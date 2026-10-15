import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { Capability, ErrorCode, EVENT_TYPE_LABELS, type DutyKind, type EventStatus } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, concurrentUpdate, fieldRefused, notFound } from '../../common/errors/api-exception';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { toPage, type Page } from '../../common/pagination';
import type { ReasonDto } from '../../common/reason.dto';
import { addDays, dayStart, SchoolClock, todayIn } from '../../common/school-clock';
import { SchoolContext, type Actor } from '../../common/school-context';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import {
  EventRepository,
  type EventContent,
  type EventDutyRecord,
  type EventRecord,
  type LockedEvent,
} from '../../repositories/event.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { fromDateString, toDateString, yearClosed } from '../academics/academics.shared';
import { AnnouncementsService } from '../announcements/announcements.service';
import { CampaignsService } from '../fees/campaigns.service';
import { ChargesService } from '../fees/charges.service';
import { runInProgress } from '../fees/charges.shared';
import { requireHeld } from '../fees/fee-gates';
import { onceMore } from '../payments/payments.shared';
import type {
  AddEventDutyDto,
  CreateEventDto,
  EventDto,
  EventDutyDto,
  EventChargeInputDto,
  ListEventsQueryDto,
  UpdateEventDto,
} from './events.dto';

// Phase 5 slice 38 (contracts/slice-38.md §2.1-§2.5, §2.9; rule 34, R310, R311, R313, R316): the
// event itself — create, edit while draft, duties, publish (the campaign and the invitation),
// cancel (the money settled, the cancellation notice), complete — and the staff lists. Every write
// runs in one transaction that locks the event row first; the database holds the same rules as
// triggers (migration 20261010090000_wave_s_events_contracts).

const ENDPOINT = 'events';
const SUBJECT = 'event';
const DUTY_SUBJECT = 'event_duty';
/** The end reason of a leaving member's duties (B8). */
const DUTY_LEFT = 'left';
const ALL_STATUSES: readonly EventStatus[] = ['draft', 'published', 'completed', 'cancelled'];
const NOT_DRAFT: readonly EventStatus[] = ['published', 'completed', 'cancelled'];
const MINE: readonly EventStatus[] = ['published', 'completed'];

export interface EventCreateOutcome {
  replayed: boolean;
  event: EventDto;
}

export const eventNotDraft = (eventId: bigint): ApiException =>
  new ApiException(409, ErrorCode.EVENT_NOT_DRAFT, 'The event is no longer a draft.', { eventId: eventId.toString() });

export const eventNotPublished = (eventId: bigint): ApiException =>
  new ApiException(409, ErrorCode.EVENT_NOT_PUBLISHED, 'The event is not published.', { eventId: eventId.toString() });

const illegalTransition = (eventId: bigint, from: EventStatus): ApiException =>
  new ApiException(409, ErrorCode.ILLEGAL_STATUS_TRANSITION, `A ${from} event cannot do that.`, {
    eventId: eventId.toString(),
    status: from,
  });

/** The event's date in school time (A4: the date that lies inside the year). */
export const eventDay = (startsAt: Date, timezone: string): Date => todayIn(timezone, startsAt);

const toDutyDto = (d: EventDutyRecord): EventDutyDto => ({
  id: d.id.toString(),
  eventId: d.eventId.toString(),
  staffId: d.staffId.toString(),
  staffName: d.staffName,
  duty: d.duty,
  note: d.note,
  createdAt: d.createdAt,
  endedAt: d.endedAt,
  endReason: d.endReason,
});

function toEventDto(row: EventRecord, duties: readonly EventDutyRecord[], staffId: bigint | null, timezone: string): EventDto {
  const own = duties.filter((d) => d.eventId === row.id);
  return {
    id: row.id.toString(),
    academicYearId: row.academicYearId.toString(),
    academicYearName: row.academicYearName,
    type: row.type,
    title: row.title,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    venue: row.venue,
    details: row.details,
    status: row.status,
    charge:
      row.chargeAmount === null
        ? null
        : { amount: row.chargeAmount, dueOn: toDateString(row.chargeDueOn ?? eventDay(row.startsAt, timezone)) },
    sections: row.sections.map((s) => ({
      sectionId: s.sectionId.toString(),
      sectionName: s.sectionName,
      classId: s.classId.toString(),
      className: s.className,
    })),
    duties: own.map(toDutyDto),
    myDuties:
      staffId === null ? [] : own.filter((d) => d.staffId === staffId && d.endedAt === null).map((d): DutyKind => d.duty),
    announcementId: row.announcementId?.toString() ?? null,
    cancelAnnouncementId: row.cancelAnnouncementId?.toString() ?? null,
    campaignId: row.campaignId?.toString() ?? null,
    campaignStatus: row.campaignStatus,
    createdByName: row.createdByName,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    cancelledAt: row.cancelledAt,
    cancelReason: row.cancelReason,
  };
}

const isHolder = (session: SchoolSessionContext): boolean => session.access.capabilities.has(Capability.HOLIDAY_MANAGE);

/** §2.1: a charge needs both campaign keys (R310). */
function requireCampaignKeys(session: SchoolSessionContext): void {
  requireHeld(session, Capability.CHARGE_CREATE);
  requireHeld(session, Capability.CHARGE_CAMPAIGN_SEND);
}

@Injectable()
export class EventsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly events: EventRepository,
    private readonly campaigns: CampaignsService,
    private readonly charges: ChargesService,
    private readonly announcements: AnnouncementsService,
    private readonly idempotency: IdempotentRequests,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
  ) {}

  // ---------------------------------------------------------------------------------- reads

  async list(session: SchoolSessionContext, query: ListEventsQueryDto): Promise<Page<EventDto>> {
    const schoolId = this.context.schoolId;
    const timezone = await this.clock.timezone(schoolId);
    const staffId = session.access.staffId;
    const holder = isHolder(session);
    let ids: bigint[] | undefined;
    if (query.mine === true) {
      ids = staffId === null ? [] : await this.events.mineIds(schoolId, staffId, await this.clock.today(schoolId));
    }
    const { rows, total } = await this.events.list(schoolId, {
      ...(query.academicYearId === undefined ? {} : { academicYearId: BigInt(query.academicYearId) }),
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.status === undefined ? {} : { status: query.status }),
      visible: query.mine === true ? MINE : holder ? ALL_STATUSES : NOT_DRAFT,
      ...(query.startsFrom === undefined ? {} : { startsFrom: dayStart(timezone, fromDateString(query.startsFrom)) }),
      ...(query.startsTo === undefined ? {} : { startsTo: dayStart(timezone, addDays(fromDateString(query.startsTo), 1)) }),
      ...(ids === undefined ? {} : { ids }),
      sort: query.sort ?? '-startsAt',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const duties = await this.events.dutiesOf(schoolId, rows.map((r) => r.id), holder ? undefined : (staffId ?? 0n));
    return toPage(rows.map((r) => toEventDto(r, duties, staffId, timezone)), query, total);
  }

  /** A draft is the holiday.manage holders' alone (404 otherwise). */
  async get(session: SchoolSessionContext, id: bigint): Promise<EventDto> {
    const schoolId = this.context.schoolId;
    const row = await this.events.findById(schoolId, id);
    const holder = isHolder(session);
    if (!row || (row.status === 'draft' && !holder)) throw notFound();
    const staffId = session.access.staffId;
    const duties = await this.events.dutiesOf(schoolId, [id], holder ? undefined : (staffId ?? 0n));
    return toEventDto(row, duties, staffId, await this.clock.timezone(schoolId));
  }

  // ------------------------------------------------------------------------- create, edit

  /** Keyed by Idempotency-Key (endpoint events, path id the academic year). */
  async create(session: SchoolSessionContext, dto: CreateEventDto, rawKey: string | undefined): Promise<EventCreateOutcome> {
    if (dto.charge !== undefined) requireCampaignKeys(session);
    const actor = this.context.actor();
    const outcome = await this.idempotency.withIdempotencyKey(actor, ENDPOINT, BigInt(dto.academicYearId), dto, rawKey, (claim) =>
      this.createInTransaction(actor, dto, claim),
    );
    const id = outcome.replayed ? outcome.subjectId : outcome.value;
    return { replayed: outcome.replayed, event: await this.get(session, id) };
  }

  @Transactional()
  private async createInTransaction(actor: Actor, dto: CreateEventDto, claim: IdempotencyClaim): Promise<bigint> {
    const { schoolId, userId } = actor;
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, SUBJECT);
    const year = await this.events.year(schoolId, BigInt(dto.academicYearId));
    if (!year) throw fieldRefused('academicYearId', ErrorCode.REFERENCE_NOT_FOUND, 'No such academic year');
    if (year.status === 'closed') throw yearClosed();
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (endsAt < startsAt) throw fieldRefused('endsAt', ErrorCode.INVALID_VALUE, 'endsAt must not be before startsAt');
    const sections = await this.checkSections(schoolId, year.id, dto.sectionIds);
    const charge = dto.charge === undefined ? null : await this.checkCharge(schoolId, year, dto.charge);
    const id = await this.events.create(
      schoolId,
      year.id,
      {
        type: dto.type,
        title: dto.title,
        startsAt,
        endsAt,
        venue: dto.venue,
        details: dto.details ?? null,
        chargeAmount: charge?.amount ?? null,
        chargeDueOn: charge?.dueOn ?? null,
      },
      userId,
    );
    await this.events.replaceSections(schoolId, id, year.id, sections);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'event.created',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: {
        academicYearId: year.id.toString(),
        type: dto.type,
        startsAt: startsAt.toISOString(),
        sections: sections.length,
        chargeAmount: charge?.amount ?? null,
      },
    });
    await recordSubject(id);
    return id;
  }

  /** §2.2: a draft's fields; `sectionIds` replaces the set; `charge: null` removes the charge. */
  @Transactional()
  async update(session: SchoolSessionContext, id: bigint, dto: UpdateEventDto): Promise<EventDto> {
    const { schoolId, userId } = this.context.actor();
    const locked = await this.lock(schoolId, id);
    if (locked.status !== 'draft') throw eventNotDraft(id);
    if (dto.charge !== undefined) requireCampaignKeys(session);
    const row = await this.require(schoolId, id);
    const year = await this.events.year(schoolId, row.academicYearId);
    if (!year) throw notFound();
    if (year.status === 'closed') throw yearClosed();
    const content: Partial<EventContent> = {};
    if (dto.type !== undefined) content.type = dto.type;
    if (dto.title !== undefined) content.title = dto.title;
    if (dto.venue !== undefined) content.venue = dto.venue;
    if (dto.details !== undefined) content.details = dto.details;
    if (dto.startsAt !== undefined) content.startsAt = new Date(dto.startsAt);
    if (dto.endsAt !== undefined) content.endsAt = new Date(dto.endsAt);
    if ((content.endsAt ?? row.endsAt) < (content.startsAt ?? row.startsAt)) {
      throw fieldRefused('endsAt', ErrorCode.INVALID_VALUE, 'endsAt must not be before startsAt');
    }
    if (dto.charge === null) {
      content.chargeAmount = null;
      content.chargeDueOn = null;
    } else if (dto.charge !== undefined) {
      const charge = await this.checkCharge(schoolId, year, dto.charge);
      content.chargeAmount = charge.amount;
      content.chargeDueOn = charge.dueOn;
    }
    if ((await this.events.updateDraft(schoolId, id, content)) !== 1) throw eventNotDraft(id);
    if (dto.sectionIds !== undefined) {
      await this.events.replaceSections(schoolId, id, year.id, await this.checkSections(schoolId, year.id, dto.sectionIds));
    }
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'event.updated',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { fields: [...Object.keys(content), ...(dto.sectionIds === undefined ? [] : ['sectionIds'])].join(',') },
    });
    return this.get(session, id);
  }

  // ---------------------------------------------------------------------------------- duties

  /** §2.3: one live duty of a kind per member, while the event is draft or published. */
  @Transactional()
  async addDuty(session: SchoolSessionContext, eventId: bigint, dto: AddEventDutyDto): Promise<EventDutyDto> {
    const { schoolId, userId } = this.context.actor();
    const locked = await this.events.lockForShare(schoolId, eventId);
    if (!locked) throw notFound();
    if (locked.status !== 'draft' && locked.status !== 'published') throw illegalTransition(eventId, locked.status);
    const staffId = BigInt(dto.staffId);
    if (!(await this.events.activeStaff(schoolId, staffId))) {
      throw fieldRefused('staffId', ErrorCode.REFERENCE_NOT_FOUND, 'No such active staff member');
    }
    const existing = await this.events.liveDuty(schoolId, eventId, staffId, dto.duty);
    if (existing !== null) {
      throw new ApiException(409, ErrorCode.EVENT_DUTY_EXISTS, 'That staff member already holds that duty at this event.', {
        eventId: eventId.toString(),
        dutyId: existing.toString(),
      });
    }
    const id = await this.events.createDuty(schoolId, { eventId, staffId, duty: dto.duty, note: dto.note ?? null, createdBy: userId });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'event_duty.added',
      subjectType: DUTY_SUBJECT,
      subjectId: id,
      metadata: { eventId: eventId.toString(), staffId: dto.staffId, duty: dto.duty },
    });
    return toDutyDto(await this.requireDuty(schoolId, id));
  }

  /** §2.3: a repeat answers unchanged and writes nothing. */
  @Transactional()
  async endDuty(id: bigint, dto: ReasonDto): Promise<EventDutyDto> {
    const { schoolId, userId } = this.context.actor();
    const duty = await this.requireDuty(schoolId, id);
    if (duty.endedAt !== null) return toDutyDto(duty);
    const locked = await this.events.lockForShare(schoolId, duty.eventId);
    if (!locked) throw notFound();
    if (locked.status !== 'draft' && locked.status !== 'published') throw illegalTransition(duty.eventId, locked.status);
    if ((await this.events.endDuty(schoolId, id, { by: userId, reason: dto.reason, at: this.clock.now() })) !== 1) {
      return toDutyDto(await this.requireDuty(schoolId, id));
    }
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'event_duty.ended',
      subjectType: DUTY_SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: { eventId: duty.eventId.toString(), staffId: duty.staffId.toString(), duty: duty.duty },
    });
    return toDutyDto(await this.requireDuty(schoolId, id));
  }

  /**
   * B8 (Phase 5 close): a member who leaves loses their live duties on draft or published events,
   * inside the staff status change's transaction (no own @Transactional), each ended with the
   * reason `left` and audited `event_duty.ended`. Returns how many were ended.
   */
  async endDutiesForLeaving(schoolId: SchoolId, staffId: bigint, actorUserId: bigint, at: Date): Promise<number> {
    let ended = 0;
    for (const duty of await this.events.liveDutiesOfStaff(schoolId, staffId)) {
      if ((await this.events.endDuty(schoolId, duty.id, { by: actorUserId, reason: DUTY_LEFT, at })) !== 1) continue;
      await this.audit.record(schoolId, {
        actorUserId,
        action: 'event_duty.ended',
        subjectType: DUTY_SUBJECT,
        subjectId: duty.id,
        reason: DUTY_LEFT,
        metadata: { eventId: duty.eventId.toString(), staffId: staffId.toString(), duty: duty.duty, via: 'staff_left' },
      });
      ended++;
    }
    return ended;
  }

  // ------------------------------------------------------------------------ status changes

  /**
   * §2.4 (R310): the campaign (when charged) and the invitation, then one UPDATE of the status
   * and both links; the run and the send are enqueued after commit.
   */
  @Transactional()
  async publish(session: SchoolSessionContext, id: bigint): Promise<EventDto> {
    const actor = this.context.actor();
    const { schoolId, userId } = actor;
    const locked = await this.lock(schoolId, id);
    if (locked.status !== 'draft') throw eventNotDraft(id);
    const row = await this.require(schoolId, id);
    const year = await this.events.year(schoolId, row.academicYearId);
    if (!year) throw notFound();
    if (year.status === 'closed') throw yearClosed();
    if (row.sections.length === 0) {
      throw new ApiException(409, ErrorCode.EVENT_NO_SECTIONS, 'An event needs at least one section before it is published.', {
        eventId: id.toString(),
      });
    }
    const timezone = await this.clock.timezone(schoolId);
    const sectionIds = row.sections.map((s) => s.sectionId);
    let campaignId: bigint | null = null;
    let dueOn: Date | null = null;
    if (row.chargeAmount !== null) {
      requireCampaignKeys(session);
      dueOn = row.chargeDueOn ?? eventDay(row.startsAt, timezone);
      if (dueOn < (await this.clock.today(schoolId))) {
        throw fieldRefused('charge.dueOn', ErrorCode.INVALID_VALUE, 'The charge would be due before today; set a later due date');
      }
      if (dueOn > year.endsOn) {
        throw fieldRefused('charge.dueOn', ErrorCode.INVALID_VALUE, 'The charge must fall due inside the academic year');
      }
      const head = await this.events.eventHead(schoolId);
      if (!head) throw fieldRefused('charge', ErrorCode.REFERENCE_NOT_FOUND, 'The school has no live Event fee head');
      campaignId = await this.campaigns.createForEvent(actor, {
        name: row.title,
        academicYearId: row.academicYearId,
        feeHeadId: head.id,
        amount: row.chargeAmount,
        dueOn,
        description: `${EVENT_TYPE_LABELS[row.type]}: ${row.title}`.slice(0, 500),
        sectionIds,
      });
    }
    const { announcementId } = await this.announcements.sendEventNotice(schoolId, {
      kind: 'notice',
      typeLabel: EVENT_TYPE_LABELS[row.type],
      title: row.title,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      venue: row.venue,
      details: row.details,
      charge: row.chargeAmount === null || dueOn === null ? null : { amount: row.chargeAmount, dueOn },
      sectionIds,
      createdBy: userId,
    });
    if ((await this.events.publish(schoolId, id, { announcementId, campaignId })) !== 1) throw concurrentUpdate();
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'event.published',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: {
        announcementId: announcementId.toString(),
        campaignId: campaignId?.toString() ?? null,
        sections: sectionIds.length,
        chargeAmount: row.chargeAmount,
      },
    });
    return this.get(session, id);
  }

  /**
   * §2.5 (R313): the charges settled (voids, or credits that leave the paid money as the child's
   * advance; the principal when any has money), the campaign cancelled, a cancellation notice for
   * a published event. No cash moves. Retried once on a racing payment, as adjust is (onceMore).
   */
  async cancel(session: SchoolSessionContext, id: bigint, dto: ReasonDto): Promise<EventDto> {
    return onceMore(() => this.cancelInTransaction(session, id, dto));
  }

  @Transactional()
  private async cancelInTransaction(session: SchoolSessionContext, id: bigint, dto: ReasonDto): Promise<EventDto> {
    const actor = this.context.actor();
    const { schoolId, userId } = actor;
    const locked = await this.lock(schoolId, id);
    if (locked.status !== 'draft' && locked.status !== 'published') throw illegalTransition(id, locked.status);
    const row = await this.require(schoolId, id);
    let settled = { voided: 0, credited: 0, applied: 0 };
    if (row.campaignId !== null) {
      requireHeld(session, Capability.CHARGE_CREATE);
      if (row.campaignStatus === 'generating') throw runInProgress(row.campaignId);
      settled = await this.charges.settleCancelledCampaign(session, row.campaignId, dto.reason);
      await this.campaigns.cancelForEvent(actor, row.campaignId, dto.reason);
    }
    let cancelAnnouncementId: bigint | null = null;
    if (locked.status === 'published') {
      ({ announcementId: cancelAnnouncementId } = await this.announcements.sendEventNotice(schoolId, {
        kind: 'cancellation',
        typeLabel: EVENT_TYPE_LABELS[row.type],
        title: row.title,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        venue: row.venue,
        details: null,
        charge: row.chargeAmount === null ? null : { amount: row.chargeAmount, dueOn: row.chargeDueOn ?? row.startsAt },
        sectionIds: row.sections.map((s) => s.sectionId),
        createdBy: userId,
      }));
    }
    const moved = await this.events.cancel(schoolId, id, locked.status, {
      by: userId,
      reason: dto.reason,
      at: this.clock.now(),
      cancelAnnouncementId,
    });
    if (moved !== 1) throw concurrentUpdate();
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'event.cancelled',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: {
        fromStatus: locked.status,
        campaignId: row.campaignId?.toString() ?? null,
        voided: settled.voided,
        credited: settled.credited,
        cancelAnnouncementId: cancelAnnouncementId?.toString() ?? null,
      },
    });
    return this.get(session, id);
  }

  /** published → completed: participation freezes (R312). */
  @Transactional()
  async complete(session: SchoolSessionContext, id: bigint): Promise<EventDto> {
    const { schoolId, userId } = this.context.actor();
    const locked = await this.lock(schoolId, id);
    if (locked.status !== 'published') throw illegalTransition(id, locked.status);
    if ((await this.events.complete(schoolId, id, this.clock.now())) !== 1) throw concurrentUpdate();
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'event.completed',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: {},
    });
    return this.get(session, id);
  }

  // -------------------------------------------------------------------------------- helpers

  private async lock(schoolId: SchoolId, id: bigint): Promise<LockedEvent> {
    const locked = await this.events.lockForUpdate(schoolId, id);
    if (!locked) throw notFound();
    return locked;
  }

  private async require(schoolId: SchoolId, id: bigint): Promise<EventRecord> {
    const row = await this.events.findById(schoolId, id);
    if (!row) throw notFound();
    return row;
  }

  private async requireDuty(schoolId: SchoolId, id: bigint): Promise<EventDutyRecord> {
    const row = await this.events.findDuty(schoolId, id);
    if (!row) throw notFound();
    return row;
  }

  /** Live sections of the year, each once (422 on `sectionIds[i]`). */
  private async checkSections(
    schoolId: SchoolId,
    academicYearId: bigint,
    raw: readonly string[],
  ): Promise<{ sectionId: bigint; classId: bigint }[]> {
    const ids = raw.map((id) => BigInt(id));
    ids.forEach((id, index) => {
      if (ids.indexOf(id) !== index) throw fieldRefused(`sectionIds[${index}]`, ErrorCode.INVALID_VALUE, 'This section is named twice');
    });
    const found = new Map((await this.events.liveSectionsOfYear(schoolId, academicYearId, ids)).map((s) => [s.id, s.classId]));
    return ids.map((id, index) => {
      const classId = found.get(id);
      if (classId === undefined) {
        throw fieldRefused(`sectionIds[${index}]`, ErrorCode.REFERENCE_NOT_FOUND, "Not a live section of the event's academic year");
      }
      return { sectionId: id, classId };
    });
  }

  /** §2.1: the event head exists; a due date, when given, is today or later and inside the year. */
  private async checkCharge(
    schoolId: SchoolId,
    year: { endsOn: Date },
    charge: EventChargeInputDto,
  ): Promise<{ amount: number; dueOn: Date | null }> {
    if (!(await this.events.eventHead(schoolId))) {
      throw fieldRefused('charge', ErrorCode.REFERENCE_NOT_FOUND, 'The school has no live Event fee head');
    }
    if (charge.dueOn === undefined) return { amount: charge.amount, dueOn: null };
    const dueOn = fromDateString(charge.dueOn);
    if (dueOn < (await this.clock.today(schoolId))) {
      throw fieldRefused('charge.dueOn', ErrorCode.INVALID_VALUE, 'charge.dueOn must be today or later');
    }
    if (dueOn > year.endsOn) {
      throw fieldRefused('charge.dueOn', ErrorCode.INVALID_VALUE, 'charge.dueOn must fall inside the academic year');
    }
    return { amount: charge.amount, dueOn };
  }
}
