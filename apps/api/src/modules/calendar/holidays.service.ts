import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { Capability, ErrorCode, HOLIDAY_STATUSES, type HolidayStatus } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { diffFields } from '../../common/diff';
import { recoverConstraint } from '../../common/errors/prisma-errors';
import { readLocked } from '../../common/locking';
import { toPage, type Page } from '../../common/pagination';
import { addDays, assertRange, SchoolClock } from '../../common/school-clock';
import { SchoolContext } from '../../common/school-context';
import { ContactResolver } from '../../messaging/contacts';
import { NotificationService } from '../../messaging/notification.service';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { MessageRepository } from '../../repositories/message.repository';
import {
  HolidayRepository,
  type HolidayChange,
  type HolidayRecord,
  type HolidayView,
} from '../../repositories/holiday.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { fromDateString, toDateString } from '../academics/academics.shared';
import { AnnouncementsService } from '../announcements/announcements.service';
import { CalendarListenerRegistry, type HolidayRange } from './calendar-listener';
import { CalendarService } from './calendar.service';
import type {
  CancelHolidayDto,
  CreateHolidayDto,
  HolidayDto,
  ListHolidaysQueryDto,
  UpdateHolidayDto,
} from './calendar.dto';

// contracts/slice-10.md §4 (R116, R117, R167). Lock order: the holiday row, then whatever a
// calendar listener locks. Rows are cancelled, never deleted (rule 4).

const SUBJECT = 'holiday';
const LIVE_EXCL = 'holidays_live_excl';
/** The create typo guard (§4.3): today − 366 days … today + 731 days. */
const EARLIEST_DAYS = -366;
const LATEST_DAYS = 731;
/** endsOn − startsOn ≤ 365: a range spans at most 366 days. */
const MAX_SPAN_DAYS = 365;

/** Visible to a caller without holiday.manage: never a draft (§1). */
const PUBLIC_STATUSES: readonly HolidayStatus[] = ['published', 'cancelled'];
/** Fields frozen once published (R117), compared by value so a resent form is accepted. */
const FROZEN: readonly string[] = ['startsOn', 'endsOn', 'name', 'kind'];
const EDITABLE = ['startsOn', 'endsOn', 'name', 'kind', 'description', 'appliesToStaff'] as const;

export function toHolidayDto(row: HolidayView): HolidayDto {
  return {
    id: row.id.toString(),
    startsOn: toDateString(row.startsOn),
    endsOn: toDateString(row.endsOn),
    name: row.name,
    description: row.description,
    kind: row.kind,
    appliesToStaff: row.appliesToStaff,
    status: row.status,
    publishedAt: row.publishedAt,
    publishedBy: row.publishedBy?.toString() ?? null,
    publishedByName: row.publishedByName,
    cancelledAt: row.cancelledAt,
    cancelledBy: row.cancelledBy?.toString() ?? null,
    cancelledByName: row.cancelledByName,
    cancelReason: row.cancelReason,
    announcementId: row.announcementId?.toString() ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const datesTaken = (holidayId: bigint): ApiException =>
  new ApiException(409, ErrorCode.HOLIDAY_DATES_TAKEN, 'Those dates overlap another holiday.', {
    holidayId: holidayId.toString(),
  });

const notDraft = (): ApiException =>
  new ApiException(
    409,
    ErrorCode.HOLIDAY_NOT_DRAFT,
    'Only a draft holiday can change its dates, name or kind: cancel it and create a new one.',
  );

const range = (row: HolidayRecord): HolidayRange => ({
  id: row.id,
  startsOn: row.startsOn,
  endsOn: row.endsOn,
  appliesToStaff: row.appliesToStaff,
});

/** endsOn ≥ startsOn and the span within 366 days, reported on endsOn (§4.3). */
const assertSpan = (startsOn: Date, endsOn: Date): void =>
  assertRange(startsOn, endsOn, MAX_SPAN_DAYS, { field: 'endsOn', from: 'startsOn' });

/** The typo guard on startsOn (§4.3). Past dates are allowed: a closure recorded next morning. */
function assertWindow(startsOn: Date, today: Date): void {
  if (startsOn < addDays(today, EARLIEST_DAYS) || startsOn > addDays(today, LATEST_DAYS)) {
    throw fieldRefused(
      'startsOn',
      ErrorCode.INVALID_VALUE,
      'startsOn must be within a year before and two years after today',
    );
  }
}

@Injectable()
export class HolidaysService {
  constructor(
    private readonly context: SchoolContext,
    private readonly holidays: HolidayRepository,
    private readonly calendar: CalendarService,
    private readonly listeners: CalendarListenerRegistry,
    private readonly notifications: NotificationService,
    private readonly contacts: ContactResolver,
    private readonly messages: MessageRepository,
    private readonly announcements: AnnouncementsService,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
  ) {}

  /** Drafts are filtered in the query for a caller without holiday.manage (§1, §4.1). */
  async list(session: SchoolSessionContext, query: ListHolidaysQueryDto): Promise<Page<HolidayDto>> {
    const visible = this.visibleStatuses(session);
    const dateFrom = query.dateFrom === undefined ? undefined : fromDateString(query.dateFrom);
    const dateTo = query.dateTo === undefined ? undefined : fromDateString(query.dateTo);
    if (dateFrom && dateTo && dateTo < dateFrom) {
      throw fieldRefused('dateTo', ErrorCode.INVALID_VALUE, 'dateTo must not be before dateFrom');
    }
    const { rows, total } = await this.holidays.list(this.context.schoolId, {
      ...(dateFrom === undefined ? {} : { dateFrom }),
      ...(dateTo === undefined ? {} : { dateTo }),
      statuses: query.status === undefined ? visible : visible.filter((s) => s === query.status),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      sort: query.sort ?? 'startsOn',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map(toHolidayDto), query, total);
  }

  async get(session: SchoolSessionContext, id: bigint): Promise<HolidayDto> {
    const schoolId = this.context.schoolId;
    const row = await this.holidays.findById(schoolId, id, this.visibleStatuses(session));
    if (!row) throw notFound();
    return toHolidayDto(await this.holidays.view(schoolId, row));
  }

  /**
   * Created `draft`; sends nothing. An overlap with a live holiday is 409 HOLIDAY_DATES_TAKEN
   * naming the oldest such row; the race loser of holidays_live_excl reads it in a fresh
   * statement after the rollback, so both answers are the same.
   */
  async create(dto: CreateHolidayDto): Promise<HolidayDto> {
    const startsOn = fromDateString(dto.startsOn);
    const endsOn = fromDateString(dto.endsOn ?? dto.startsOn);
    return recoverConstraint(
      LIVE_EXCL,
      () => this.createInTransaction(dto, startsOn, endsOn),
      (error) => this.datesTakenAfterRace(error, startsOn, endsOn),
    );
  }

  /** §4.4: draft → anything; published → description and appliesToStaff; cancelled → nothing. */
  async update(id: bigint, dto: UpdateHolidayDto): Promise<HolidayDto> {
    return recoverConstraint(
      LIVE_EXCL,
      () => this.updateInTransaction(id, dto),
      async (error) => {
        const row = await this.holidays.findById(this.context.schoolId, id);
        if (!row) throw error;
        const startsOn = dto.startsOn === undefined ? row.startsOn : fromDateString(dto.startsOn);
        const endsOn = dto.endsOn === undefined ? row.endsOn : fromDateString(dto.endsOn);
        return this.datesTakenAfterRace(error, startsOn, endsOn, id);
      },
    );
  }

  /**
   * §4.5: draft → published. Already published: unchanged, no audit, nothing sent. The R167
   * listeners run after the status write and before the notice; a holiday wholly in the past is
   * published without a notice.
   */
  @Transactional()
  async publish(id: bigint): Promise<HolidayDto> {
    const { schoolId, userId } = this.context.actor();
    const row = await this.lock(schoolId, id);
    if (row.status === 'published') return this.dto(schoolId, row);
    if (row.status === 'cancelled') {
      throw new ApiException(
        409,
        ErrorCode.ILLEGAL_STATUS_TRANSITION,
        'A cancelled holiday cannot be published.',
        { from: 'cancelled', to: 'published' },
      );
    }
    let published = await this.holidays.publish(schoolId, id, userId, new Date());
    await this.listeners.published(schoolId, range(published));

    // R151 (contracts/slice-14.md §6.1): the notice is an `everyone` announcement naming the
    // holiday, the last write before the audit. A holiday wholly past has none.
    const counts = { noticeGuardians: 0, noticeStaff: 0, noticeStudents: 0 };
    let announcementId: bigint | null = null;
    if (published.endsOn >= (await this.clock.today(schoolId))) {
      const notice = await this.announcements.sendHolidayNotice(schoolId, {
        kind: 'notice',
        holidayId: id,
        name: published.name,
        startsOn: published.startsOn,
        endsOn: published.endsOn,
        reopensOn: await this.calendar.nextTeachingDay(schoolId, published.endsOn),
        createdBy: userId,
      });
      announcementId = notice.announcementId;
      published = await this.holidays.setAnnouncement(schoolId, id, notice.announcementId);
      counts.noticeGuardians = notice.guardians;
      counts.noticeStaff = notice.staff;
      counts.noticeStudents = notice.students;
    }

    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'holiday.published',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: {
        startsOn: toDateString(published.startsOn),
        endsOn: toDateString(published.endsOn),
        ...counts,
        announcementId: announcementId?.toString() ?? null,
      },
    });
    return this.dto(schoolId, published);
  }

  /**
   * §4.6: draft | published → cancelled, final. Already cancelled: unchanged, no audit. From
   * published, the R167 listeners run, unsent notices are withdrawn, and (unless the holiday is
   * wholly past) everyone whose notice was not withdrawn is told it is cancelled.
   */
  @Transactional()
  async cancel(id: bigint, dto: CancelHolidayDto): Promise<HolidayDto> {
    const { schoolId, userId } = this.context.actor();
    const row = await this.lock(schoolId, id);
    if (row.status === 'cancelled') return this.dto(schoolId, row);
    const cancelled = await this.holidays.cancel(schoolId, id, userId, new Date(), dto.reason);

    const counts = { noticesWithdrawn: 0, cancellationRecipients: 0 };
    let cancellationAnnouncementId: bigint | null = null;
    if (row.status === 'published' && row.announcementId !== null) {
      await this.listeners.cancelled(schoolId, range(cancelled));
      // contracts/slice-14.md §6.2: the notice announcement's unsent messages are withdrawn (it
      // stays `sent`, R146), then a second `everyone` announcement tells the school now
      // (decision 15), unless the holiday is wholly past. The notice's send job may still be
      // writing its messages after commit: wait for it first, so none escapes the withdrawal (a
      // job that has not started finds the holiday cancelled and tells nobody).
      await this.announcements.holdHolidayNotice(schoolId, row.announcementId);
      counts.noticesWithdrawn = await this.messages.withdrawQueuedForSubject(
        schoolId,
        'announcement',
        row.announcementId,
      );
      if (cancelled.endsOn >= (await this.clock.today(schoolId))) {
        const notice = await this.announcements.sendHolidayNotice(schoolId, {
          kind: 'cancellation',
          holidayId: id,
          name: cancelled.name,
          startsOn: cancelled.startsOn,
          endsOn: cancelled.endsOn,
          reopensOn: null,
          createdBy: userId,
        });
        cancellationAnnouncementId = notice.announcementId;
        counts.cancellationRecipients = notice.guardians + notice.staff + notice.students;
      }
    } else if (row.status === 'published') {
      // Published before slice 14 (no announcement; not backfilled): slice 10's path, unchanged.
      await this.listeners.cancelled(schoolId, range(cancelled));
      // Unsent notices are withdrawn in one statement; the processor claims only `queued` rows
      // (R105), so each notice is either withdrawn here or already claimed, never both.
      counts.noticesWithdrawn = await this.messages.withdrawQueuedForSubject(schoolId, SUBJECT, id);
      if (cancelled.endsOn >= (await this.clock.today(schoolId))) {
        // Exactly the people who were or may have been told (R117), as they are now: a guardian
        // merged since is told as the survivor, staff who have left are not told.
        const told = await this.contacts.survivors(
          schoolId,
          await this.messages.recipientsNotWithdrawn(schoolId, SUBJECT, id),
        );
        if (told.length > 0) {
          await this.notifications.send(schoolId, {
            type: 'holiday_notice',
            subject: { type: 'holiday_cancellation', id },
            recipients: told,
            vars: { name: cancelled.name, startsOn: cancelled.startsOn, endsOn: cancelled.endsOn },
          });
        }
        counts.cancellationRecipients = told.length;
      }
    }

    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'holiday.cancelled',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: {
        from: row.status,
        ...counts,
        cancellationAnnouncementId: cancellationAnnouncementId?.toString() ?? null,
      },
    });
    return this.dto(schoolId, cancelled);
  }

  @Transactional()
  private async createInTransaction(
    dto: CreateHolidayDto,
    startsOn: Date,
    endsOn: Date,
  ): Promise<HolidayDto> {
    const { schoolId, userId } = this.context.actor();
    assertWindow(startsOn, await this.clock.today(schoolId));
    assertSpan(startsOn, endsOn);
    const taken = await this.holidays.firstLiveOverlapping(schoolId, startsOn, endsOn);
    if (taken !== null) throw datesTaken(taken);
    const created = await this.holidays.create(schoolId, {
      startsOn,
      endsOn,
      name: dto.name,
      description: dto.description ? dto.description : null,
      kind: dto.kind,
      appliesToStaff: dto.appliesToStaff ?? true,
    });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'holiday.created',
      subjectType: SUBJECT,
      subjectId: created.id,
      metadata: {
        name: created.name,
        startsOn: toDateString(created.startsOn),
        endsOn: toDateString(created.endsOn),
        kind: created.kind,
        appliesToStaff: created.appliesToStaff,
      },
    });
    return this.dto(schoolId, created);
  }

  @Transactional()
  private async updateInTransaction(id: bigint, dto: UpdateHolidayDto): Promise<HolidayDto> {
    const { schoolId, userId } = this.context.actor();
    const row = await this.lock(schoolId, id);

    // The request as values comparable with the row; '' and null both clear the description.
    const wanted = {
      startsOn: dto.startsOn,
      endsOn: dto.endsOn,
      name: dto.name,
      kind: dto.kind,
      description: dto.description === undefined ? undefined : dto.description || null,
      appliesToStaff: dto.appliesToStaff,
    };
    const current = {
      startsOn: toDateString(row.startsOn),
      endsOn: toDateString(row.endsOn),
      name: row.name,
      kind: row.kind,
      description: row.description,
      appliesToStaff: row.appliesToStaff,
    };
    const { data: diff, changes } = diffFields(current, wanted, EDITABLE);
    const changed = Object.keys(changes);

    if (row.status === 'cancelled' && changed.length > 0) throw notDraft();
    if (row.status === 'published' && FROZEN.some((key) => changed.includes(key))) throw notDraft();
    if (changed.length === 0) return this.dto(schoolId, row);

    const { startsOn: newStart, endsOn: newEnd, ...rest } = diff;
    const data: HolidayChange = {
      ...rest,
      ...(newStart === undefined ? {} : { startsOn: fromDateString(newStart) }),
      ...(newEnd === undefined ? {} : { endsOn: fromDateString(newEnd) }),
    };

    if (data.startsOn !== undefined || data.endsOn !== undefined) {
      const startsOn = data.startsOn ?? row.startsOn;
      const endsOn = data.endsOn ?? row.endsOn;
      if (data.startsOn !== undefined) assertWindow(startsOn, await this.clock.today(schoolId));
      assertSpan(startsOn, endsOn);
      const taken = await this.holidays.firstLiveOverlapping(schoolId, startsOn, endsOn, id);
      if (taken !== null) throw datesTaken(taken);
    }

    const updated = await this.holidays.update(schoolId, id, data);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'holiday.updated',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { changes },
    });
    return this.dto(schoolId, updated);
  }

  /** The race loser of holidays_live_excl: the conflicting row, read after the rollback. */
  private async datesTakenAfterRace(
    error: unknown,
    startsOn: Date,
    endsOn: Date,
    exceptId?: bigint,
  ): Promise<never> {
    const taken = await this.holidays.firstLiveOverlapping(
      this.context.schoolId,
      startsOn,
      endsOn,
      exceptId,
    );
    throw taken === null ? error : datesTaken(taken);
  }

  private visibleStatuses(session: SchoolSessionContext): readonly HolidayStatus[] {
    return session.access.capabilities.has(Capability.HOLIDAY_MANAGE)
      ? HOLIDAY_STATUSES
      : PUBLIC_STATUSES;
  }

  private lock(schoolId: SchoolId, id: bigint): Promise<HolidayRecord> {
    return readLocked(
      () => this.holidays.findById(schoolId, id),
      (row) => this.holidays.lockIfUnchanged(schoolId, row),
    );
  }

  private async dto(schoolId: SchoolId, row: HolidayRecord): Promise<HolidayDto> {
    return toHolidayDto(await this.holidays.view(schoolId, row));
  }
}
