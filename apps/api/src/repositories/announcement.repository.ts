import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type {
  AnnouncementCategory,
  AnnouncementPriority,
  AnnouncementStatus,
  ExternalChannel,
  MessageStatus,
  SuppressionReason,
} from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

// The tenant table announcements (contracts/slice-14.md §5, §11 item 2). Content is edited only
// while draft or scheduled (trigger announcements_final_frozen); the send moves status forward
// with conditional updates. Rows are cancelled, never deleted (rule 4).

export interface AnnouncementRecord {
  id: bigint;
  title: string;
  body: string;
  category: AnnouncementCategory;
  priority: AnnouncementPriority;
  status: AnnouncementStatus;
  scheduledAt: Date | null;
  expiresOn: Date | null;
  attachmentObjectKey: string | null;
  attachmentMime: string | null;
  attachmentSizeBytes: number | null;
  holidayId: bigint | null;
  createdBy: bigint;
  sentAt: Date | null;
  cancelledAt: Date | null;
  cancelledBy: bigint | null;
  cancelReason: string | null;
  recipientCount: number;
  /** Set when the send job gave up after its failed attempts (§5.6); only on a draft. */
  sendFailedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The row with its creator's staff name (AnnouncementDto.createdByName). */
export interface AnnouncementView extends AnnouncementRecord {
  createdByName: string;
}

export interface NewAnnouncement {
  title: string;
  body: string;
  category: AnnouncementCategory;
  priority: AnnouncementPriority;
  status: 'draft' | 'sending';
  scheduledAt: Date | null;
  expiresOn: Date | null;
  attachment: { objectKey: string; mime: string; sizeBytes: number } | null;
  holidayId: bigint | null;
  createdBy: bigint;
}

/** The content fields a PATCH may change, and the schedule. */
export interface AnnouncementChanges {
  title?: string;
  body?: string;
  category?: AnnouncementCategory;
  priority?: AnnouncementPriority;
  expiresOn?: Date | null;
  attachment?: { objectKey: string; mime: string; sizeBytes: number } | null;
  scheduledAt?: Date | null;
  status?: 'draft' | 'scheduled';
}

export type AnnouncementSort = '-createdAt' | 'createdAt' | '-scheduledAt' | '-sentAt';

export interface AnnouncementListQuery {
  /** Only these creators' rows (a `.scope` holder sees their own); undefined = every row. */
  createdBy?: bigint;
  status?: AnnouncementStatus;
  category?: AnnouncementCategory;
  priority?: AnnouncementPriority;
  holidayId?: bigint;
  /** created_at >= createdFrom and < createdBefore (school-local day bounds). */
  createdFrom?: Date;
  createdBefore?: Date;
  sort: AnnouncementSort;
  skip: number;
  take: number;
}

/** The live delivery summary of one announcement (contracts/slice-14.md §5.9, R150). */
export interface DeliveryCounts {
  messages: Record<MessageStatus, number>;
  byChannel: { channel: ExternalChannel; status: string; count: number }[];
  suppressions: { reason: SuppressionReason; count: number }[];
  smsUnitsReserved: number;
}

const SELECT = {
  id: true,
  title: true,
  body: true,
  category: true,
  priority: true,
  status: true,
  scheduledAt: true,
  expiresOn: true,
  attachmentObjectKey: true,
  attachmentMime: true,
  attachmentSizeBytes: true,
  holidayId: true,
  createdBy: true,
  sentAt: true,
  cancelledAt: true,
  cancelledBy: true,
  cancelReason: true,
  recipientCount: true,
  sendFailedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AnnouncementSelect;

const attachmentData = (attachment: AnnouncementChanges['attachment']) =>
  attachment === undefined
    ? {}
    : {
        attachmentObjectKey: attachment?.objectKey ?? null,
        attachmentMime: attachment?.mime ?? null,
        attachmentSizeBytes: attachment?.sizeBytes ?? null,
      };

function orderBy(sort: AnnouncementSort): Prisma.AnnouncementOrderByWithRelationInput[] {
  switch (sort) {
    case 'createdAt':
      return [{ createdAt: 'asc' }, { id: 'asc' }];
    case '-scheduledAt':
      return [{ scheduledAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }];
    case '-sentAt':
      return [{ sentAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }];
    default:
      return [{ createdAt: 'desc' }, { id: 'desc' }];
  }
}

@Injectable()
export class AnnouncementRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** `createdBy` set: only that creator's row (a `.scope` holder's visibility, §1.1). */
  findById(schoolId: SchoolId, id: bigint, createdBy?: bigint): Promise<AnnouncementRecord | null> {
    return this.txHost.tx.announcement.findFirst({
      where: { schoolId, id, ...(createdBy === undefined ? {} : { createdBy }) },
      select: SELECT,
    });
  }

  async list(
    schoolId: SchoolId,
    query: AnnouncementListQuery,
  ): Promise<{ rows: AnnouncementRecord[]; total: number }> {
    const created =
      query.createdFrom === undefined && query.createdBefore === undefined
        ? {}
        : {
            createdAt: {
              ...(query.createdFrom === undefined ? {} : { gte: query.createdFrom }),
              ...(query.createdBefore === undefined ? {} : { lt: query.createdBefore }),
            },
          };
    const where: Prisma.AnnouncementWhereInput = {
      schoolId,
      ...(query.createdBy === undefined ? {} : { createdBy: query.createdBy }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.category === undefined ? {} : { category: query.category }),
      ...(query.priority === undefined ? {} : { priority: query.priority }),
      ...(query.holidayId === undefined ? {} : { holidayId: query.holidayId }),
      ...created,
    };
    const rows = await this.txHost.tx.announcement.findMany({
      where,
      select: SELECT,
      orderBy: orderBy(query.sort),
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.announcement.count({ where });
    return { rows, total };
  }

  /** readLocked's lock: a compare-and-set that holds the row lock to the end of the transaction. */
  async lockIfUnchanged(schoolId: SchoolId, row: Pick<AnnouncementRecord, 'id' | 'updatedAt'>): Promise<boolean> {
    const { count } = await this.txHost.tx.announcement.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  create(schoolId: SchoolId, data: NewAnnouncement): Promise<AnnouncementRecord> {
    const { attachment, ...rest } = data;
    return this.txHost.tx.announcement.create({
      data: { schoolId, ...rest, ...attachmentData(attachment) },
      select: SELECT,
    });
  }

  /** A draft or scheduled row's content and schedule (the freeze trigger refuses any other). */
  update(schoolId: SchoolId, id: bigint, changes: AnnouncementChanges, now: Date): Promise<AnnouncementRecord> {
    const { attachment, ...rest } = changes;
    return this.updateOne(schoolId, id, { ...rest, ...attachmentData(attachment), updatedAt: now });
  }

  /**
   * §5.5 step 3 (`scheduled`) or step 4 (`sending`: the job delivers): a fresh send, so an
   * earlier give-up's count and flag are cleared.
   */
  markSending(
    schoolId: SchoolId,
    id: bigint,
    status: 'scheduled' | 'sending',
    now: Date,
  ): Promise<AnnouncementRecord> {
    return this.updateOne(schoolId, id, { status, sendFailures: 0, sendFailedAt: null, updatedAt: now });
  }

  /** The send's end: sending -> sent, with the persons resolved. */
  markSent(schoolId: SchoolId, id: bigint, recipientCount: number, now: Date): Promise<AnnouncementRecord> {
    return this.updateOne(schoolId, id, { status: 'sent', sentAt: now, recipientCount, updatedAt: now });
  }

  cancel(schoolId: SchoolId, id: bigint, by: bigint, reason: string, now: Date): Promise<AnnouncementRecord> {
    return this.updateOne(schoolId, id, {
      status: 'cancelled',
      cancelledAt: now,
      cancelledBy: by,
      cancelReason: reason,
      updatedAt: now,
    });
  }

  /**
   * §5.6 step 1, the job's first statement, holding the row lock to the end of its transaction:
   * a `scheduled` row due by `dueBy` -> `sending`, or a `sending` row (a send now or a holiday
   * notice that a request committed for the job). Null when neither (a replay, an edited time, a
   * cancellation, already sent). A second job for one row waits on the lock, then finds it `sent`
   * (Postgres re-checks the WHERE against the committed row).
   */
  async claimForSend(
    schoolId: SchoolId,
    id: bigint,
    dueBy: Date,
    now: Date,
  ): Promise<{ row: AnnouncementRecord; from: 'scheduled' | 'sending' } | null> {
    const tx = this.txHost.tx;
    const [scheduled] = await tx.announcement.updateManyAndReturn({
      where: { schoolId, id, status: 'scheduled', scheduledAt: { lte: dueBy } },
      data: { status: 'sending', updatedAt: now },
      select: SELECT,
    });
    if (scheduled) return { row: scheduled, from: 'scheduled' };
    const [sending] = await tx.announcement.updateManyAndReturn({
      where: { schoolId, id, status: 'sending' },
      data: { updatedAt: now },
      select: SELECT,
    });
    return sending ? { row: sending, from: 'sending' } : null;
  }

  /**
   * The sweep source (§5.6): `scheduled` rows due before `before`, and `sending` rows untouched
   * since `before` (their job was lost or failed), oldest first. `dueAt` names the job.
   */
  async listOverdueSends(schoolId: SchoolId, before: Date, limit: number): Promise<{ id: bigint; dueAt: Date }[]> {
    const rows = await this.txHost.tx.announcement.findMany({
      where: {
        schoolId,
        OR: [
          { status: 'scheduled', scheduledAt: { lte: before } },
          { status: 'sending', updatedAt: { lte: before } },
        ],
      },
      select: { id: true, scheduledAt: true, updatedAt: true },
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map((r) => ({ id: r.id, dueAt: r.scheduledAt ?? r.updatedAt }));
  }

  /**
   * A send job's failed attempt, counted in its own transaction after the job's rolled back, on a
   * row still waiting to be sent. Null when it no longer waits.
   */
  async countSendFailure(
    schoolId: SchoolId,
    id: bigint,
    now: Date,
  ): Promise<{ failures: number; status: AnnouncementStatus; createdBy: bigint } | null> {
    const [row] = await this.txHost.tx.announcement.updateManyAndReturn({
      where: { schoolId, id, status: { in: ['scheduled', 'sending'] } },
      data: { sendFailures: { increment: 1 }, updatedAt: now },
      select: { sendFailures: true, status: true, createdBy: true },
    });
    return row ? { failures: row.sendFailures, status: row.status, createdBy: row.createdBy } : null;
  }

  /** The job gives up: back to `draft`, flagged; nothing was written (§5.6, decision 25). */
  giveUpSend(schoolId: SchoolId, id: bigint, now: Date): Promise<AnnouncementRecord> {
    return this.updateOne(schoolId, id, { status: 'draft', sendFailedAt: now, updatedAt: now });
  }

  /** The row is a holiday's notice and that holiday has since been cancelled (§6.2): nobody is told. */
  async isWithdrawnHolidayNotice(
    schoolId: SchoolId,
    row: Pick<AnnouncementRecord, 'id' | 'holidayId'>,
  ): Promise<boolean> {
    if (row.holidayId === null) return false;
    const holiday = await this.txHost.tx.holiday.findFirst({
      where: { schoolId, id: row.holidayId },
      select: { status: true, announcementId: true },
    });
    return holiday?.status === 'cancelled' && holiday.announcementId === row.id;
  }

  /** Creator staff names: two sequential reads whatever the page size. */
  async withNames(schoolId: SchoolId, rows: readonly AnnouncementRecord[]): Promise<AnnouncementView[]> {
    const userIds = [...new Set(rows.map((r) => r.createdBy))];
    const users =
      userIds.length === 0
        ? []
        : await this.txHost.tx.user.findMany({
            where: { schoolId, id: { in: userIds } },
            select: { id: true, staffId: true },
          });
    const staffIds = users.flatMap((u) => (u.staffId === null ? [] : [u.staffId]));
    const staff =
      staffIds.length === 0
        ? []
        : await this.txHost.tx.staff.findMany({
            where: { schoolId, id: { in: staffIds } },
            select: { id: true, fullName: true },
          });
    const staffName = new Map(staff.map((s) => [s.id, s.fullName]));
    const userName = new Map(users.map((u) => [u.id, u.staffId === null ? '' : (staffName.get(u.staffId) ?? '')]));
    return rows.map((row) => ({ ...row, createdByName: userName.get(row.createdBy) ?? '' }));
  }

  /**
   * The delivery summary's counts (§5.9), computed live: message statuses for the subject, the
   * latest attempt per (message, channel) by channel and status, suppression reasons of the
   * suppressed delivery rows, and the SMS units reserved (every sms attempt that is accepted,
   * delivered or failed). Each statement filters school_id on every table it reads.
   */
  async deliveryCounts(schoolId: SchoolId, announcementId: bigint): Promise<DeliveryCounts> {
    const tx = this.txHost.tx;
    const statuses = await tx.message.groupBy({
      by: ['status'],
      where: { schoolId, subjectType: 'announcement', subjectId: announcementId },
      _count: { _all: true },
    });
    const count = (status: MessageStatus): number =>
      statuses.find((row) => row.status === status)?._count._all ?? 0;
    const messages: Record<MessageStatus, number> = {
      queued: count('queued'),
      sending: count('sending'),
      sent: count('sent'),
      delivered: count('delivered'),
      failed: count('failed'),
      suppressed: count('suppressed'),
    };
    // One statement over the subject's delivery rows (every table filtered on school_id): the
    // latest attempt per message and channel, the suppression reasons and the SMS units reserved.
    const rows = await tx.$queryRaw<
      {
        kind: 'latest' | 'suppressed' | 'units';
        channel: ExternalChannel | null;
        status: string | null;
        reason: SuppressionReason | null;
        n: bigint | null;
      }[]
    >(Prisma.sql`
      WITH d AS (
        SELECT md.message_id, md.channel, md.attempt, md.status, md.suppressed_reason, md.segments
          FROM message_deliveries md
          JOIN messages m ON m.school_id = md.school_id AND m.id = md.message_id
         WHERE md.school_id = ${schoolId} AND m.school_id = ${schoolId}
           AND m.subject_type = 'announcement' AND m.subject_id = ${announcementId})
      SELECT 'latest' AS kind, l.channel::text AS channel, l.status::text AS status, NULL::text AS reason, count(*) AS n
        FROM (SELECT DISTINCT ON (message_id, channel) channel, status
                FROM d ORDER BY message_id, channel, attempt DESC) l
       GROUP BY l.channel, l.status
      UNION ALL
      SELECT 'suppressed', NULL, NULL, suppressed_reason::text, count(*)
        FROM d WHERE status = 'suppressed' AND suppressed_reason IS NOT NULL
       GROUP BY suppressed_reason
      UNION ALL
      SELECT 'units', NULL, NULL, NULL, sum(segments)
        FROM d WHERE channel = 'sms' AND status IN ('accepted', 'delivered', 'failed')`);
    const byChannel: DeliveryCounts['byChannel'] = [];
    const suppressions: DeliveryCounts['suppressions'] = [];
    let smsUnitsReserved = 0;
    for (const row of rows) {
      const count = Number(row.n ?? 0n);
      if (row.kind === 'latest' && row.channel !== null && row.status !== null) {
        byChannel.push({ channel: row.channel, status: row.status, count });
      } else if (row.kind === 'suppressed' && row.reason !== null) {
        suppressions.push({ reason: row.reason, count });
      } else if (row.kind === 'units') {
        smsUnitsReserved = count;
      }
    }
    suppressions.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
    return { messages, byChannel, suppressions, smsUnitsReserved };
  }

  private updateOne(
    schoolId: SchoolId,
    id: bigint,
    data: Prisma.AnnouncementUncheckedUpdateManyInput,
  ): Promise<AnnouncementRecord> {
    return this.txHost.tx.announcement
      .updateManyAndReturn({ where: { schoolId, id }, data, select: SELECT })
      .then(([row]) => {
        if (!row) throw new Error('announcement row missing for a locked update');
        return row;
      });
  }
}
