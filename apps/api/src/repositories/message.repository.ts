import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type {
  MessageChannel,
  MessagePriority,
  MessageStatus,
  MessageSubjectType,
  MessageType,
  SuppressionReason,
} from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

// The tenant table messages (contracts/slice-9.md §7.1, §7.6, §7.9; R105, R107): one outbound
// message to one person. Written in the sender's transaction by NotificationService; moved through
// its states by the worker with conditional updates. A claim is a scoped `status = queued`
// update, so a replayed or forged job touches nothing.

/** Exactly one key, as CHECK messages_recipient_check demands. */
export type MessagePerson =
  | { readonly guardianId: bigint }
  | { readonly staffId: bigint }
  | { readonly studentId: bigint };

export interface NewMessage {
  type: MessageType;
  priority: MessagePriority;
  subjectType: MessageSubjectType;
  subjectId: bigint;
  guardianId: bigint | null;
  staffId: bigint | null;
  studentId: bigint | null;
  body: string;
  mediaObjectKey: string | null;
  channelPlan: MessageChannel[];
  status: MessageStatus;
  suppressedReason: SuppressionReason | null;
  finishedAt: Date | null;
}

export interface MessageRecord {
  id: bigint;
  type: MessageType;
  priority: MessagePriority;
  subjectType: string;
  subjectId: bigint;
  guardianId: bigint | null;
  staffId: bigint | null;
  studentId: bigint | null;
  body: string;
  channelPlan: MessageChannel[];
  status: MessageStatus;
  suppressedReason: SuppressionReason | null;
  createdAt: Date;
  claimedAt: Date | null;
  finishedAt: Date | null;
}

const SELECT = {
  id: true,
  type: true,
  priority: true,
  subjectType: true,
  subjectId: true,
  guardianId: true,
  staffId: true,
  studentId: true,
  body: true,
  channelPlan: true,
  status: true,
  suppressedReason: true,
  createdAt: true,
  claimedAt: true,
  finishedAt: true,
} as const;

/** The terminal states of a round's roll-up (§7.6). */
export type FinishedStatus = 'sent' | 'delivered' | 'failed' | 'suppressed';

export function personOf(row: {
  guardianId: bigint | null;
  staffId: bigint | null;
  studentId: bigint | null;
}): MessagePerson {
  if (row.guardianId !== null) return { guardianId: row.guardianId };
  if (row.staffId !== null) return { staffId: row.staffId };
  if (row.studentId !== null) return { studentId: row.studentId };
  throw new Error('a message row without a recipient');
}

@Injectable()
export class MessageRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /**
   * One set-based INSERT ... ON CONFLICT DO NOTHING (R107: the per-person partial uniques). Returns
   * only the rows inserted; a retried sender gets none back for the rows it already wrote.
   */
  async insertMany(schoolId: SchoolId, rows: readonly NewMessage[]): Promise<MessageRecord[]> {
    if (rows.length === 0) return [];
    return this.txHost.tx.message.createManyAndReturn({
      data: rows.map((row) => ({ schoolId, ...row })),
      skipDuplicates: true,
      select: SELECT,
    });
  }

  find(schoolId: SchoolId, id: bigint): Promise<MessageRecord | null> {
    return this.txHost.tx.message.findFirst({ where: { schoolId, id }, select: SELECT });
  }

  /** The ids of a subject's messages, oldest first. */
  async findBySubject(
    schoolId: SchoolId,
    subjectType: MessageSubjectType,
    subjectId: bigint,
  ): Promise<bigint[]> {
    const rows = await this.txHost.tx.message.findMany({
      where: { schoolId, subjectType, subjectId },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => row.id);
  }

  /** R105: the processor's first statement. Null when the row is not `queued` in this school. */
  async claim(schoolId: SchoolId, id: bigint, now: Date): Promise<MessageRecord | null> {
    const [row] = await this.txHost.tx.message.updateManyAndReturn({
      where: { schoolId, id, status: 'queued' },
      data: { status: 'sending', claimedAt: now },
      select: SELECT,
    });
    return row ?? null;
  }

  /** A round ended with a leg unfinished: back to `queued` for the delayed job. */
  async release(schoolId: SchoolId, id: bigint): Promise<number> {
    const { count } = await this.txHost.tx.message.updateMany({
      where: { schoolId, id, status: 'sending' },
      data: { status: 'queued' },
    });
    return count;
  }

  /** The terminal roll-up of a round, only from `sending`. */
  async finish(
    schoolId: SchoolId,
    id: bigint,
    status: FinishedStatus,
    suppressedReason: SuppressionReason | null,
    now: Date,
  ): Promise<number> {
    const { count } = await this.txHost.tx.message.updateMany({
      where: { schoolId, id, status: 'sending' },
      data: { status, suppressedReason, finishedAt: now },
    });
    return count;
  }

  /**
   * message-rollup (§7.6): a `sent` message after a delivery report. `queued` reopens it (its
   * after-failure SMS leg is due) and clears finished_at.
   */
  async moveFromSent(
    schoolId: SchoolId,
    id: bigint,
    to: 'delivered' | 'failed' | 'queued',
    now: Date,
  ): Promise<number> {
    const { count } = await this.txHost.tx.message.updateMany({
      where: { schoolId, id, status: 'sent' },
      data: { status: to, finishedAt: to === 'queued' ? null : now },
    });
    return count;
  }

  /**
   * message-rollup found nothing to change on a `sent` message: records that it was rolled up
   * now (updated_at), so the outbox sweep does not re-enqueue a rollup for reports it has seen.
   */
  async touchSent(schoolId: SchoolId, id: bigint, now: Date): Promise<void> {
    await this.txHost.tx.message.updateMany({
      where: { schoolId, id, status: 'sent' },
      data: { updatedAt: now },
    });
  }

  /**
   * Outbox sweep (§7.9): `queued` rows with no activity since `before` - created before it, not
   * claimed at or after it (a round released by the processor keeps its claimed_at and has its
   * delayed job), and no attempt at or after it - oldest first.
   */
  async listIdleQueued(schoolId: SchoolId, before: Date, limit: number): Promise<bigint[]> {
    const rows = await this.txHost.tx.message.findMany({
      where: {
        schoolId,
        status: 'queued',
        createdAt: { lt: before },
        OR: [{ claimedAt: null }, { claimedAt: { lt: before } }],
        deliveries: { none: { schoolId, attemptedAt: { gte: before } } },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map((row) => row.id);
  }

  /** Outbox sweep: `sending` rows claimed before `claimedBefore` (a crashed worker) -> `queued`. */
  async requeueStaleSending(
    schoolId: SchoolId,
    claimedBefore: Date,
    limit: number,
  ): Promise<bigint[]> {
    const stale = await this.txHost.tx.message.findMany({
      where: { schoolId, status: 'sending', claimedAt: { lt: claimedBefore } },
      select: { id: true },
      orderBy: { claimedAt: 'asc' },
      take: limit,
    });
    const requeued: bigint[] = [];
    for (const { id } of stale) {
      const { count } = await this.txHost.tx.message.updateMany({
        where: { schoolId, id, status: 'sending', claimedAt: { lt: claimedBefore } },
        data: { status: 'queued' },
      });
      if (count === 1) requeued.push(id);
    }
    return requeued;
  }

  /**
   * contracts/slice-10.md §4.6: a cancelled subject's notices still `queued` are withdrawn in one
   * conditional statement (R105: each is either withdrawn here or already claimed).
   */
  async withdrawQueuedForSubject(
    schoolId: SchoolId,
    subjectType: MessageSubjectType,
    subjectId: bigint,
  ): Promise<number> {
    const { count } = await this.txHost.tx.message.updateMany({
      where: { schoolId, subjectType, subjectId, status: 'queued' },
      data: { status: 'suppressed', suppressedReason: 'subject_cancelled', finishedAt: new Date() },
    });
    return count;
  }

  /**
   * contracts/slice-10.md §4.6 step 3: one person per message of the subject that was not
   * withdrawn (every status except `suppressed` with `subject_cancelled`).
   */
  async recipientsNotWithdrawn(
    schoolId: SchoolId,
    subjectType: MessageSubjectType,
    subjectId: bigint,
  ): Promise<MessagePerson[]> {
    const rows = await this.txHost.tx.message.findMany({
      where: {
        schoolId,
        subjectType,
        subjectId,
        NOT: { status: 'suppressed', suppressedReason: 'subject_cancelled' },
      },
      select: { guardianId: true, staffId: true, studentId: true },
      orderBy: { id: 'asc' },
    });
    return rows.map(personOf);
  }
}
