import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import {
  Capability,
  ErrorCode,
  EXTERNAL_CHANNELS,
  messageTypeOf,
  type AnnouncementCategory,
} from '@asms/shared';
import { scopeOf, type SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { diffFields } from '../../common/diff';
import { readLocked } from '../../common/locking';
import { toPage, type Page } from '../../common/pagination';
import { addDays, assertRange, dayStart, SchoolClock } from '../../common/school-clock';
import { SchoolContext, type Actor } from '../../common/school-context';
import { OutboxDispatcher } from '../../messaging/outbox-dispatcher';
import {
  composeAnnouncement,
  holidayCancellationText,
  holidayNoticeText,
  smsSegments,
  smsTextOf,
} from '../../messaging/templates';
import { AnnouncementAudienceRepository } from '../../repositories/announcement-audience.repository';
import { AnnouncementRecipientRepository } from '../../repositories/announcement-recipient.repository';
import {
  AnnouncementRepository,
  type AnnouncementChanges,
  type AnnouncementRecord,
} from '../../repositories/announcement.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import type { SchoolMessagingSettings } from '../../repositories/school-messaging.repository';
import { StagedUploadRepository } from '../../repositories/staged-upload.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { AfterCommit } from '../../tenancy/after-commit';
import { fromDateString, toDateString } from '../academics/academics.shared';
import {
  AttachmentFiles,
  storedAttachment,
  type AttachedFile,
  type StoredAttachment,
} from '../documents/attachment-files.service';
import { stagedUploadUnusable } from '../documents/documents.service';
import { AnnouncementDispatch, subjectOf, type SmsFacts } from './announcement-dispatch';
import {
  attachmentMimeOf,
  type AnnouncementDto,
  type AudienceDto,
  type AudiencePreviewDto,
  type CancelAnnouncementDto,
  type CreateAnnouncementDto,
  type DeliverySummaryDto,
  type ListAnnouncementsQueryDto,
  type PreviewAudienceDto,
  type PreviewWarning,
  type UpdateAnnouncementDto,
} from './announcements.dto';
import {
  AudienceRules,
  parseAudiences,
  rolesOf,
  type AudienceItem,
  type SenderReach,
} from './audiences';

// contracts/slice-14.md §1-§5 (R143-R152). Lock order: the announcement row, then its recipients,
// then messages (§1.4). A send locks one announcement row; membership is read, never locked.

const ENDPOINT = 'announcements';
const SUBJECT = 'announcement';
const MINUTE_MS = 60_000;
/** §5.4: scheduledAt at least 1 minute and at most 90 days ahead. */
const SCHEDULE_MIN_MS = MINUTE_MS;
const SCHEDULE_MAX_MS = 90 * 24 * 60 * MINUTE_MS;
/** §5.2: createdFrom and createdTo at most 366 days apart. */
const MAX_LIST_RANGE_DAYS = 366;
/** Content PATCH may change, in the order an audit names them. */
const CONTENT = ['title', 'body', 'category', 'priority', 'audiences', 'scheduledAt', 'expiresOn', 'attachment'] as const;
type ContentField = (typeof CONTENT)[number];

export interface AnnouncementCreateOutcome {
  replayed: boolean;
  announcement: AnnouncementDto;
}

/** The holiday a notice or its cancellation is about (contracts/slice-14.md §6). */
export interface HolidayNoticeInput {
  kind: 'notice' | 'cancellation';
  holidayId: bigint;
  name: string;
  startsOn: Date;
  endsOn: Date;
  /** The notice only: the next teaching day, or null. */
  reopensOn: Date | null;
  /** The publisher or the canceller. */
  createdBy: bigint;
}

const sentRefusal = (status: string) =>
  new ApiException(409, ErrorCode.ANNOUNCEMENT_SENT, 'This announcement has been sent and cannot be changed.', {
    status,
  });
const cancelledRefusal = () =>
  new ApiException(409, ErrorCode.ANNOUNCEMENT_CANCELLED, 'This announcement is cancelled.');

/** R152: counts by audience kind, never a target or a name: `everyone`, `class:2,section:1`. */
export function audienceKinds(items: readonly Pick<AudienceItem, 'kind' | 'targetId'>[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    // A broad kind is named alone; a targeted kind with how many targets it has.
    const key = item.targetId === null ? item.kind : `${item.kind}:`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, n]) => (key.endsWith(':') ? `${key}${n}` : key)).join(',');
}

const sameItems = (a: readonly AudienceItem[], b: readonly AudienceItem[]): boolean =>
  JSON.stringify(a.map((i) => [i.kind, i.targetId?.toString() ?? null, [...rolesOf(i)].sort()])) ===
  JSON.stringify(b.map((i) => [i.kind, i.targetId?.toString() ?? null, [...rolesOf(i)].sort()]));

@Injectable()
export class AnnouncementsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly announcements: AnnouncementRepository,
    private readonly audiences: AnnouncementAudienceRepository,
    private readonly recipients: AnnouncementRecipientRepository,
    private readonly rules: AudienceRules,
    private readonly dispatch: AnnouncementDispatch,
    private readonly staged: StagedUploadRepository,
    private readonly files: AttachmentFiles,
    private readonly idempotency: IdempotentRequests,
    private readonly audit: AuditLogRepository,
    private readonly outbox: OutboxDispatcher,
    private readonly afterCommit: AfterCommit,
    private readonly clock: SchoolClock,
  ) {}

  // ---------------------------------------------------------------------------------- reads

  /** §5.2: `.school` sees every row; a `.scope` holder their own (in the query). */
  async list(session: SchoolSessionContext, query: ListAnnouncementsQueryDto): Promise<Page<AnnouncementDto>> {
    const schoolId = this.context.schoolId;
    const settings = await this.dispatch.settings(schoolId);
    const from = query.createdFrom === undefined ? undefined : fromDateString(query.createdFrom);
    const to = query.createdTo === undefined ? undefined : fromDateString(query.createdTo);
    if (from !== undefined && to !== undefined) {
      assertRange(from, to, MAX_LIST_RANGE_DAYS, { field: 'createdTo', from: 'createdFrom' });
    }
    const createdBy = this.ownOnly(session);
    const { rows, total } = await this.announcements.list(schoolId, {
      ...(createdBy === undefined ? {} : { createdBy }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.category === undefined ? {} : { category: query.category }),
      ...(query.priority === undefined ? {} : { priority: query.priority }),
      ...(query.holidayId === undefined ? {} : { holidayId: BigInt(query.holidayId) }),
      ...(from === undefined ? {} : { createdFrom: dayStart(settings.timezone, from) }),
      ...(to === undefined ? {} : { createdBefore: dayStart(settings.timezone, addDays(to, 1)) }),
      sort: query.sort ?? '-createdAt',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(await this.dtos(schoolId, rows, settings), query, total);
  }

  async get(session: SchoolSessionContext, id: bigint): Promise<AnnouncementDto> {
    const schoolId = this.context.schoolId;
    return this.dto(schoolId, await this.require(schoolId, session, id));
  }

  /** §5.9 (R150): computed live from the rows, never stored. */
  async delivery(session: SchoolSessionContext, id: bigint): Promise<DeliverySummaryDto> {
    const schoolId = this.context.schoolId;
    const row = await this.require(schoolId, session, id);
    const counts = await this.announcements.deliveryCounts(schoolId, id);
    const settings = await this.dispatch.settings(schoolId);
    return {
      announcementId: id.toString(),
      status: row.status,
      recipients: await this.recipients.counts(schoolId, id),
      messages: counts.messages,
      byChannel: EXTERNAL_CHANNELS.map((channel) => {
        const of = (status: string) =>
          counts.byChannel.find((c) => c.channel === channel && c.status === status)?.count ?? 0;
        return {
          channel,
          accepted: of('accepted'),
          delivered: of('delivered'),
          failed: of('failed'),
          suppressed: of('suppressed'),
        };
      }),
      suppressions: counts.suppressions,
      smsSegmentsPerMessage: this.smsSegmentsOf(row, settings),
      smsUnitsReserved: counts.smsUnitsReserved,
      computedAt: this.clock.now(),
    };
  }

  /** §5.10: the sender's copy; a PDF has no thumbnail. */
  async attachment(session: SchoolSessionContext, id: bigint, thumb: boolean): Promise<AttachedFile> {
    const schoolId = this.context.schoolId;
    const row = await this.require(schoolId, session, id);
    const file = storedAttachment(row);
    const name = `announcement-${row.id}`;
    const log = { announcementId: row.id.toString() };
    return thumb ? this.files.thumbnail(schoolId, file, name, log) : this.files.open(schoolId, file, name, log);
  }

  /** §4.6: shape, scope, resolution on today and the SMS facts. Writes nothing, audits nothing. */
  async preview(session: SchoolSessionContext, dto: PreviewAudienceDto): Promise<AudiencePreviewDto> {
    const schoolId = this.context.schoolId;
    const items = parseAudiences(dto.audiences);
    const { resolution, facts } = await this.dispatch.resolve(schoolId, {
      items,
      scope: { reach: this.reachOf(session), mode: 'refuse' },
      subject: {
        priority: dto.priority,
        holidayId: dto.holiday ? 0n : null,
        title: dto.title ?? '',
        body: dto.body ?? '',
        hasAttachment: dto.hasAttachment ?? false,
      },
      on: await this.clock.today(schoolId),
      plan: 'count',
    });
    const units = facts.units ?? 0;
    const names = await this.targetNames(schoolId, items);
    const warnings: PreviewWarning[] = [];
    if (facts.allowed && units > facts.remaining) warnings.push('sms_cap_short');
    if (facts.allowed && dto.title !== undefined && dto.body !== undefined && facts.segments > 3) {
      warnings.push('sms_too_long');
    }
    if (resolution.persons.length === 0) warnings.push('no_recipients');
    if (!(await this.dispatch.whatsappConnected(schoolId))) warnings.push('whatsapp_not_connected');
    return {
      recipients: resolution.counts,
      byAudience: items.map((item, i) => ({
        kind: item.kind,
        targetId: item.targetId?.toString() ?? null,
        targetName: names[i] ?? null,
        persons: resolution.byItem[i] ?? 0,
      })),
      sms: {
        allowed: facts.allowed,
        legs: facts.legs ?? 0,
        segments: facts.segments,
        units,
        remaining: facts.remaining,
        cap: facts.cap,
      },
      warnings,
      computedAt: this.clock.now(),
    };
  }

  // --------------------------------------------------------------------------------- create

  /** §5.4 with §3's pre-steps: key, hash, replay or reuse, then one transaction. */
  async create(
    session: SchoolSessionContext,
    dto: CreateAnnouncementDto,
    rawKey: string | undefined,
  ): Promise<AnnouncementCreateOutcome> {
    const actor = this.context.actor();
    const items = parseAudiences(dto.audiences);
    // The request hash is over the body with its audiences in canonical order (§3).
    const canonical = { ...dto, audiences: items.map((i) => ({ kind: i.kind, targetId: i.targetId?.toString(), roles: rolesOf(i) })) };
    const outcome = await this.idempotency.withIdempotencyKey(actor, ENDPOINT, 0n, canonical, rawKey, (claim) =>
      this.createInTransaction(session, actor, dto, items, claim),
    );
    if (outcome.replayed) return { replayed: true, announcement: await this.get(session, outcome.subjectId) };
    return { replayed: false, announcement: await this.dto(actor.schoolId, outcome.value) };
  }

  @Transactional()
  private async createInTransaction(
    session: SchoolSessionContext,
    actor: Actor,
    dto: CreateAnnouncementDto,
    items: AudienceItem[],
    claim: IdempotencyClaim,
  ): Promise<AnnouncementRecord> {
    const { schoolId, userId } = actor;
    // Step 1, the first statement: a racing same-key submit now waits on the unique index.
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, SUBJECT);
    const now = this.clock.now();
    const scheduledAt = this.scheduledAtOf(dto.scheduledAt ?? null, now);
    const expiresOn = await this.expiresOnOf(schoolId, dto.expiresOn ?? null);
    // Step 2: scope (403 first, then 422/409 per item).
    await this.rules.check(schoolId, items, this.reachOf(session), 'refuse');
    // Step 3: length, when the type may travel by SMS now.
    this.dispatch.assertSmsLength(
      await this.dispatch.smsFacts(schoolId, { ...dto, holidayId: null, hasAttachment: dto.stagedUploadId != null }),
    );
    // Step 4: the attachment, consumed by its uploader only (R91, R171).
    const attachment =
      dto.stagedUploadId === undefined || dto.stagedUploadId === null
        ? null
        : await this.consume(actor, BigInt(dto.stagedUploadId));
    // Step 5.
    const row = await this.announcements.create(schoolId, {
      title: dto.title,
      body: dto.body,
      category: dto.category,
      priority: dto.priority,
      status: 'draft',
      scheduledAt,
      expiresOn,
      attachment,
      holidayId: null,
      createdBy: userId,
    });
    await this.audiences.replace(schoolId, row.id, items);
    await recordSubject(row.id);
    // Step 6.
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'announcement.created',
      subjectType: SUBJECT,
      subjectId: row.id,
      metadata: {
        category: row.category,
        priority: row.priority,
        audienceKinds: audienceKinds(items),
        scheduled: scheduledAt !== null,
        hasAttachment: attachment !== null,
        holidayId: null,
      },
    });
    return row;
  }

  // ---------------------------------------------------------------------------------- patch

  /** §5.7: draft or scheduled only; the merged result re-checked; no change is a free 200. */
  @Transactional()
  async update(session: SchoolSessionContext, id: bigint, dto: UpdateAnnouncementDto): Promise<AnnouncementDto> {
    const actor = this.context.actor();
    const { schoolId, userId } = actor;
    for (const field of ['title', 'body', 'category', 'priority', 'audiences'] as const) {
      if (dto[field] === null) throw fieldRefused(field, ErrorCode.INVALID_VALUE, `${field} cannot be removed`);
    }
    const row = await this.lock(schoolId, session, id);
    if (row.status === 'sending' || row.status === 'sent') throw sentRefusal(row.status);
    if (row.status === 'cancelled') throw cancelledRefusal();
    const now = this.clock.now();

    const current = await this.itemsOf(schoolId, row.id);
    const items = dto.audiences === undefined ? current : parseAudiences(dto.audiences);
    const wanted = {
      title: dto.title,
      body: dto.body,
      category: dto.category,
      priority: dto.priority,
      expiresOn: dto.expiresOn === undefined ? undefined : await this.expiresOnOf(schoolId, dto.expiresOn),
      scheduledAt: dto.scheduledAt === undefined ? undefined : this.scheduledAtOf(dto.scheduledAt, now),
    };
    const fields = ['title', 'body', 'category', 'priority', 'expiresOn', 'scheduledAt'] as const;
    const { data } = diffFields(row, wanted, fields, (value) => (value instanceof Date ? value.getTime() : value));
    const changes: AnnouncementChanges = { ...data };
    const changed: ContentField[] = fields.filter((field) => field in data);
    // A scheduled row without a time is a draft again (§5.1).
    if (row.status === 'scheduled' && 'scheduledAt' in data && data.scheduledAt === null) changes.status = 'draft';
    const audiencesChanged = dto.audiences !== undefined && !sameItems(items, current);
    if (audiencesChanged) changed.push('audiences');
    // Scope is re-checked on the merged audiences every time (today's scope).
    await this.rules.check(schoolId, items, this.reachOf(session), 'refuse');

    const hasAttachment =
      dto.stagedUploadId === undefined ? row.attachmentObjectKey !== null : dto.stagedUploadId !== null;
    this.dispatch.assertSmsLength(
      await this.dispatch.smsFacts(schoolId, {
        priority: changes.priority ?? row.priority,
        holidayId: row.holidayId,
        title: changes.title ?? row.title,
        body: changes.body ?? row.body,
        hasAttachment,
      }),
    );
    if (dto.stagedUploadId === null) {
      if (row.attachmentObjectKey !== null) {
        changes.attachment = null;
        changed.push('attachment');
      }
    } else if (dto.stagedUploadId !== undefined) {
      changes.attachment = await this.consume(actor, BigInt(dto.stagedUploadId));
      changed.push('attachment');
    }
    if (changed.length === 0) return this.dto(schoolId, row);

    const updated = await this.announcements.update(schoolId, id, changes, now);
    if (audiencesChanged) await this.audiences.replace(schoolId, id, items);
    if (updated.status === 'scheduled' && changes.scheduledAt instanceof Date) {
      this.outbox.announcementSendAfterCommit(schoolId, { id, scheduledAt: changes.scheduledAt });
    }
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'announcement.updated',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { changes: CONTENT.filter((field) => changed.includes(field)).join(',') },
    });
    return this.dto(schoolId, updated);
  }

  // ----------------------------------------------------------------------------------- send

  /**
   * §5.5: scheduled, sending or sent -> 200 unchanged (a retry); cancelled -> 409. A draft with a
   * future time -> scheduled (the job fires it). Otherwise send now: scope, resolution and the SMS
   * checks here, so a refusal reaches the caller; the row is committed `sending` and the
   * `announcement-send` job writes the messages after commit (decision 9, reversed: a school-wide
   * fan-out does not fit a request's transaction). The response is `sending`; the detail page
   * shows it become `sent`.
   */
  @Transactional()
  async send(session: SchoolSessionContext, id: bigint): Promise<AnnouncementDto> {
    const { schoolId, userId } = this.context.actor();
    const row = await this.lock(schoolId, session, id);
    if (row.status === 'cancelled') throw cancelledRefusal();
    if (row.status !== 'draft') return this.dto(schoolId, row);
    const now = this.clock.now();
    const items = await this.itemsOf(schoolId, id);
    const reach = this.reachOf(session);

    if (row.scheduledAt !== null && row.scheduledAt > now) {
      // §4.2: scope is checked at create, patch and send, scheduling included (today's scope).
      await this.rules.check(schoolId, items, reach, 'refuse');
      const scheduled = await this.announcements.markSending(schoolId, id, 'scheduled', now);
      this.outbox.announcementSendAfterCommit(schoolId, { id, scheduledAt: row.scheduledAt });
      await this.audit.record(schoolId, {
        actorUserId: userId,
        action: 'announcement.scheduled',
        subjectType: SUBJECT,
        subjectId: id,
        metadata: { scheduledAt: row.scheduledAt.toISOString(), audienceKinds: audienceKinds(items) },
      });
      return this.dto(schoolId, scheduled);
    }

    // Send now. A refusal below leaves the row `draft` with nothing written.
    const { resolution, facts } = await this.dispatch.resolve(schoolId, {
      items,
      scope: { reach, mode: 'refuse' },
      subject: subjectOf(row),
      on: await this.clock.today(schoolId),
      plan: 'cap',
      now,
    });
    if (resolution.persons.length === 0) {
      throw new ApiException(409, ErrorCode.ANNOUNCEMENT_NO_RECIPIENTS, 'Nobody is in this audience today.', {
        audiences: items.length,
      });
    }
    this.dispatch.assertSmsLength(facts);
    this.assertSmsCap(facts);
    const sending = await this.announcements.markSending(schoolId, id, 'sending', now);
    this.outbox.announcementSendAfterCommit(schoolId, { id, scheduledAt: now });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'announcement.sent',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: {
        recipients: resolution.counts.total,
        guardians: resolution.counts.guardians,
        staff: resolution.counts.staff,
        students: resolution.counts.students,
        audienceKinds: audienceKinds(items),
        smsSegments: facts.allowed ? facts.segments : null,
        dedupedByUser: resolution.dedupedByUser,
        dedupedByIdentity: resolution.dedupedByIdentity,
      },
    });
    return this.dto(schoolId, sending);
  }

  /** §5.8: draft or scheduled -> cancelled; a sent announcement cannot be recalled (R146). */
  @Transactional()
  async cancel(session: SchoolSessionContext, id: bigint, dto: CancelAnnouncementDto): Promise<AnnouncementDto> {
    const { schoolId, userId } = this.context.actor();
    const row = await this.lock(schoolId, session, id);
    if (row.status === 'cancelled') return this.dto(schoolId, row);
    if (row.status === 'sending' || row.status === 'sent') throw sentRefusal(row.status);
    const cancelled = await this.announcements.cancel(schoolId, id, userId, dto.reason, this.clock.now());
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'announcement.cancelled',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: { fromStatus: row.status, audienceKinds: audienceKinds(await this.itemsOf(schoolId, id)) },
    });
    return this.dto(schoolId, cancelled);
  }

  // ------------------------------------------------------------------ holidays (§6, R151)

  /**
   * A holiday's notice or cancellation as an `everyone` announcement, committed `sending` inside
   * the caller's (the holiday's) transaction; the `announcement-send` job delivers it after commit
   * (§6.1). No `announcement.send.*` check: `holiday.manage` is the authority (decision 14). Zero
   * persons is not a refusal (decision 10). The counts are today's resolution, for the holiday's
   * own audit row, which names the announcement (it is not audited separately).
   */
  async sendHolidayNotice(
    schoolId: SchoolId,
    input: HolidayNoticeInput,
  ): Promise<{ announcementId: bigint; guardians: number; staff: number; students: number }> {
    const now = this.clock.now();
    const { name } = await this.dispatch.settings(schoolId);
    const text =
      input.kind === 'notice' ? holidayNoticeText(name, input) : holidayCancellationText(name, input);
    const items: AudienceItem[] = [{ kind: 'everyone', targetId: null, roles: ['parents', 'students'] }];
    const row = await this.announcements.create(schoolId, {
      title: text.title,
      body: text.body,
      category: 'holiday',
      priority: 'normal',
      status: 'sending',
      scheduledAt: null,
      expiresOn: input.endsOn,
      attachment: null,
      holidayId: input.holidayId,
      createdBy: input.createdBy,
    });
    await this.audiences.replace(schoolId, row.id, items);
    const { resolution } = await this.dispatch.resolve(schoolId, {
      items,
      scope: null,
      subject: subjectOf(row),
      on: await this.clock.today(schoolId),
      plan: 'none',
      now,
    });
    this.outbox.announcementSendAfterCommit(schoolId, { id: row.id, scheduledAt: now });
    const { guardians, staff, students } = resolution.counts;
    return { announcementId: row.id, guardians, staff, students };
  }

  /**
   * §6.2: before a cancelled holiday's queued notices are withdrawn, wait for a send job still
   * writing them (it holds the announcement row), so none is committed after the withdrawal. Lock
   * order: holiday row, then announcement row (§1.4).
   */
  async holdHolidayNotice(schoolId: SchoolId, announcementId: bigint): Promise<void> {
    await readLocked(
      () => this.announcements.findById(schoolId, announcementId),
      (row) => this.announcements.lockIfUnchanged(schoolId, row),
    );
  }

  // -------------------------------------------------------------------------------- helpers

  /** §1.2: today's scope over the two keys, and whether `.school` is held. */
  private reachOf(session: SchoolSessionContext): SenderReach {
    return {
      scope: scopeOf(session),
      school: session.access.capabilities.has(Capability.ANNOUNCEMENT_SEND_SCHOOL),
    };
  }

  /** §1.1: a `.scope`-only sender sees their own rows; `.school` every row. */
  private ownOnly(session: SchoolSessionContext): bigint | undefined {
    return session.access.capabilities.has(Capability.ANNOUNCEMENT_SEND_SCHOOL) ? undefined : session.access.userId;
  }

  private async require(schoolId: SchoolId, session: SchoolSessionContext, id: bigint): Promise<AnnouncementRecord> {
    const row = await this.announcements.findById(schoolId, id, this.ownOnly(session));
    if (!row) throw notFound();
    return row;
  }

  /** The visible row, locked (§1.4); a row the caller cannot see is 404. */
  private lock(schoolId: SchoolId, session: SchoolSessionContext, id: bigint): Promise<AnnouncementRecord> {
    const createdBy = this.ownOnly(session);
    return readLocked(
      () => this.announcements.findById(schoolId, id, createdBy),
      (row) => this.announcements.lockIfUnchanged(schoolId, row),
    );
  }

  private async itemsOf(schoolId: SchoolId, id: bigint): Promise<AudienceItem[]> {
    return (await this.audiences.forAnnouncements(schoolId, [id])).map((row) => ({
      kind: row.kind,
      targetId: row.targetId,
      roles: row.roles,
    }));
  }

  /** §5.4: absent or null = none; else at least 1 minute and at most 90 days ahead. */
  private scheduledAtOf(value: string | null, now: Date): Date | null {
    if (value === null) return null;
    const at = new Date(value);
    const ms = at.getTime() - now.getTime();
    if (Number.isNaN(at.getTime()) || ms < SCHEDULE_MIN_MS || ms > SCHEDULE_MAX_MS) {
      throw fieldRefused(
        'scheduledAt',
        ErrorCode.INVALID_VALUE,
        'scheduledAt must be at least 1 minute and at most 90 days ahead',
      );
    }
    return at;
  }

  /** §5.4: today or later; null = never expires. */
  private async expiresOnOf(schoolId: SchoolId, value: string | null): Promise<Date | null> {
    if (value === null) return null;
    const date = fromDateString(value);
    if (date < (await this.clock.today(schoolId))) {
      throw fieldRefused('expiresOn', ErrorCode.INVALID_VALUE, 'expiresOn must be today or later');
    }
    return date;
  }

  /**
   * R109 at send now: the always-SMS units must fit what the month has left. Units not counted
   * (null) means the upper bound already fit.
   */
  private assertSmsCap(facts: SmsFacts): void {
    if (facts.allowed && facts.units !== null && facts.units > facts.remaining) {
      throw new ApiException(
        409,
        ErrorCode.SMS_CAP_EXCEEDED,
        `This announcement needs ${facts.units} SMS units; ${facts.remaining} remain this month.`,
        { smsUnits: facts.units, remaining: facts.remaining, cap: facts.cap },
      );
    }
  }

  /**
   * The staged upload consumed in one conditional update (R91); an image's thumbnail is stored
   * after commit, so nothing is written to storage for a write that rolls back.
   */
  private async consume(actor: Actor, stagedUploadId: bigint): Promise<StoredAttachment> {
    const { schoolId, userId } = actor;
    const [staged] = await this.staged.findOwned(schoolId, userId, [stagedUploadId]);
    if (!staged || !(await this.staged.consume(schoolId, userId, staged.id, this.clock.now()))) {
      throw stagedUploadUnusable('stagedUploadId');
    }
    const attachment = { objectKey: staged.objectKey, mime: staged.mime, sizeBytes: staged.sizeBytes };
    this.afterCommit.register(() => this.files.storeThumbnail(schoolId, attachment));
    return attachment;
  }

  /** AnnouncementDto.smsSegments: the composed SMS's segments when its type may travel by SMS now. */
  private smsSegmentsOf(row: AnnouncementRecord, settings: SchoolMessagingSettings): number | null {
    if (!settings.smsAllowedTypes.includes(messageTypeOf(row))) return null;
    return smsSegments(
      smsTextOf(composeAnnouncement(settings.name, row.title, row.body), row.attachmentObjectKey !== null),
    );
  }

  private async targetNames(schoolId: SchoolId, items: readonly AudienceItem[]): Promise<(string | null)[]> {
    const named = await this.audiences.namesOf(schoolId, items);
    return items.map((item) => (item.targetId === null ? null : (named.get(`${item.kind}:${item.targetId}`) ?? null)));
  }

  private async dto(schoolId: SchoolId, row: AnnouncementRecord): Promise<AnnouncementDto> {
    const [dto] = await this.dtos(schoolId, [row], await this.dispatch.settings(schoolId));
    if (!dto) throw notFound();
    return dto;
  }

  private async dtos(
    schoolId: SchoolId,
    rows: readonly AnnouncementRecord[],
    settings: SchoolMessagingSettings,
  ): Promise<AnnouncementDto[]> {
    const views = await this.announcements.withNames(schoolId, rows);
    const audiences = await this.audiences.forAnnouncements(
      schoolId,
      rows.map((r) => r.id),
    );
    return views.map((row) => ({
      id: row.id.toString(),
      title: row.title,
      body: row.body,
      category: row.category satisfies AnnouncementCategory,
      priority: row.priority,
      messageType: messageTypeOf(row),
      status: row.status,
      audiences: audiences
        .filter((a) => a.announcementId === row.id)
        .map(
          (a): AudienceDto => ({
            kind: a.kind,
            targetId: a.targetId?.toString() ?? null,
            targetName: a.targetName,
            roles: rolesOf(a),
          }),
        ),
      scheduledAt: row.scheduledAt,
      expiresOn: row.expiresOn === null ? null : toDateString(row.expiresOn),
      hasAttachment: row.attachmentObjectKey !== null,
      attachmentMime: attachmentMimeOf(row.attachmentMime),
      attachmentSizeBytes: row.attachmentSizeBytes,
      holidayId: row.holidayId?.toString() ?? null,
      createdBy: row.createdBy.toString(),
      createdByName: row.createdByName,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      sentAt: row.sentAt,
      cancelledAt: row.cancelledAt,
      cancelledBy: row.cancelledBy?.toString() ?? null,
      cancelReason: row.cancelReason,
      recipientCount: row.recipientCount,
      sendFailedAt: row.sendFailedAt,
      smsSegments: this.smsSegmentsOf(row, settings),
    }));
  }
}
