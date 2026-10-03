import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type {
  DeliveryErrorCode,
  DeliveryStatus,
  MessageChannel,
  SuppressionReason,
} from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

// The tenant table message_deliveries (contracts/slice-9.md §7.6, §7.10, §7.11; R108): one row
// per attempt per channel, unique per (message, channel, attempt). Rows move only forward
// (trigger message_deliveries_forward_only): accepted -> delivered | failed, and poll_ref only to
// NULL. The provider reference is stored hashed; a pull provider's is also kept encrypted in
// poll_ref until a final status.

/** UNIQUE (school_id, message_id, channel, attempt): an attempt is written once (R108). */
export const DELIVERY_ATTEMPT_UNIQUE = 'message_deliveries_attempt_key';

export interface NewDelivery {
  messageId: bigint;
  channel: Exclude<MessageChannel, 'in_app'>;
  attempt: number;
  status: Exclude<DeliveryStatus, 'delivered'>;
  providerRefHash: string | null;
  pollRef: string | null;
  toMasked: string | null;
  errorCode: DeliveryErrorCode | null;
  suppressedReason: SuppressionReason | null;
  segments: number | null;
  attemptedAt: Date;
}

export interface DeliveryRecord {
  id: bigint;
  messageId: bigint;
  channel: MessageChannel;
  attempt: number;
  status: DeliveryStatus;
  errorCode: DeliveryErrorCode | null;
  suppressedReason: SuppressionReason | null;
  attemptedAt: Date;
  /** Later than attemptedAt when a report failed an accepted attempt. */
  failedAt: Date | null;
}

const SELECT = {
  id: true,
  messageId: true,
  channel: true,
  attempt: true,
  status: true,
  errorCode: true,
  suppressedReason: true,
  attemptedAt: true,
  failedAt: true,
} as const;

/** An accepted SMS attempt awaiting its final status (the poll's input). */
export interface PollableDelivery {
  id: bigint;
  messageId: bigint;
  pollRef: string;
  attemptedAt: Date;
}

/** A report that moved a delivery of a `sent` message after the message was last rolled up. */
export interface UnrolledReport {
  deliveryId: bigint;
  messageId: bigint;
  status: 'delivered' | 'failed';
}

/** One day's counts for one channel (the delivery-health rollup). */
export interface ChannelDayCounts {
  channel: MessageChannel;
  status: DeliveryStatus;
  count: number;
}

@Injectable()
export class MessageDeliveryRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async insert(schoolId: SchoolId, row: NewDelivery): Promise<bigint> {
    const created = await this.txHost.tx.messageDelivery.create({
      data: { schoolId, ...row, failedAt: row.status === 'failed' ? row.attemptedAt : null },
      select: { id: true },
    });
    return created.id;
  }

  /** Set-based: the write-time suppressed rows of a send (§7.4). */
  async insertMany(schoolId: SchoolId, rows: readonly NewDelivery[]): Promise<void> {
    if (rows.length === 0) return;
    await this.txHost.tx.messageDelivery.createMany({
      data: rows.map((row) => ({
        schoolId,
        ...row,
        failedAt: row.status === 'failed' ? row.attemptedAt : null,
      })),
    });
  }

  listForMessage(schoolId: SchoolId, messageId: bigint): Promise<DeliveryRecord[]> {
    return this.txHost.tx.messageDelivery.findMany({
      where: { schoolId, messageId },
      select: SELECT,
      orderBy: [{ attemptedAt: 'asc' }, { id: 'asc' }],
    });
  }

  countForMessage(schoolId: SchoolId, messageId: bigint): Promise<number> {
    return this.txHost.tx.messageDelivery.count({ where: { schoolId, messageId } });
  }

  /**
   * SMS poll (§7.10): accepted SMS attempts with a reference, attempted within [from, to),
   * oldest first. The caller filters by poll point.
   */
  listAwaitingPoll(
    schoolId: SchoolId,
    attemptedAfter: Date,
    limit: number,
  ): Promise<PollableDelivery[]> {
    return this.txHost.tx.messageDelivery
      .findMany({
        where: {
          schoolId,
          channel: 'sms',
          status: 'accepted',
          pollRef: { not: null },
          attemptedAt: { gt: attemptedAfter },
        },
        select: { id: true, messageId: true, pollRef: true, attemptedAt: true },
        orderBy: { attemptedAt: 'asc' },
        take: limit,
      })
      .then((rows) =>
        rows.flatMap((row) => (row.pollRef === null ? [] : [{ ...row, pollRef: row.pollRef }])),
      );
  }

  /**
   * Outbox sweep (§7.9, L6): deliveries reported `delivered` or `failed` within [from, to) whose
   * message is still `sent` and was last rolled up (messages.updated_at: the round's finish or
   * the rollup's own touch) before the report, i.e. a report whose `message-rollup` job was lost.
   * Oldest first, at most `limit`.
   */
  async listUnrolledReports(
    schoolId: SchoolId,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<UnrolledReport[]> {
    const rows = await this.txHost.tx.messageDelivery.findMany({
      where: {
        schoolId,
        OR: [
          { status: 'delivered', deliveredAt: { gte: from, lt: to } },
          { status: 'failed', failedAt: { gte: from, lt: to } },
        ],
        message: { is: { schoolId, status: 'sent' } },
      },
      select: {
        id: true,
        messageId: true,
        status: true,
        attemptedAt: true,
        deliveredAt: true,
        failedAt: true,
        message: { select: { updatedAt: true } },
      },
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.flatMap((row): UnrolledReport[] => {
      const changedAt = row.deliveredAt ?? row.failedAt;
      // A failure written at the attempt is not a report; a report the rollup has seen is done.
      if (changedAt === null || changedAt <= row.attemptedAt || changedAt <= row.message.updatedAt) return [];
      if (row.status !== 'delivered' && row.status !== 'failed') return [];
      return [{ deliveryId: row.id, messageId: row.messageId, status: row.status }];
    });
  }

  /** SMS accepted for longer than the give-up window: failed with `no_report`, no query. */
  async expireUnreported(
    schoolId: SchoolId,
    attemptedBefore: Date,
    now: Date,
  ): Promise<{ id: bigint; messageId: bigint }[]> {
    return this.txHost.tx.messageDelivery.updateManyAndReturn({
      where: { schoolId, channel: 'sms', status: 'accepted', attemptedAt: { lte: attemptedBefore } },
      data: { status: 'failed', failedAt: now, errorCode: 'no_report', pollRef: null },
      select: { id: true, messageId: true },
    });
  }

  /**
   * A final status from a pull report, forward-only: matches only while still `accepted`.
   * Clears poll_ref. Returns rows changed (0 or 1).
   */
  async settle(
    schoolId: SchoolId,
    id: bigint,
    to: 'delivered' | 'failed',
    errorCode: DeliveryErrorCode | null,
    now: Date,
  ): Promise<number> {
    const { count } = await this.txHost.tx.messageDelivery.updateMany({
      where: { schoolId, id, status: 'accepted' },
      data:
        to === 'delivered'
          ? { status: 'delivered', deliveredAt: now, pollRef: null }
          : { status: 'failed', failedAt: now, errorCode, pollRef: null },
    });
    return count;
  }

  /** Deliveries of the school attempted in [from, to), counted by channel and status. */
  async countByChannelAndStatus(
    schoolId: SchoolId,
    from: Date,
    to: Date,
  ): Promise<ChannelDayCounts[]> {
    const groups = await this.txHost.tx.messageDelivery.groupBy({
      by: ['channel', 'status'],
      where: { schoolId, attemptedAt: { gte: from, lt: to } },
      _count: { _all: true },
    });
    return groups.map((g) => ({ channel: g.channel, status: g.status, count: g._count._all }));
  }
}
