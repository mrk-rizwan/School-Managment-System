import { Inject, Injectable, Logger } from '@nestjs/common';
import { FieldEncryption } from '../common/crypto/field-encryption';
import { failureLog } from '../common/errors/failure-log';
import { MessageDeliveryRepository } from '../repositories/message-delivery.repository';
import { MessageRepository } from '../repositories/message.repository';
import type { SchoolId } from '../tenancy/school-id';
import { MESSAGING_DRIVERS, type MessagingDrivers } from './drivers/types';
import { pollRefAad } from './provider-refs';
import { OutboxDispatcher } from './outbox-dispatcher';

const MINUTE = 60_000;

/**
 * Outbox sweep (§7.9): idle `queued` rows after 2 min; `sending` claimed over 10 min ago; reports
 * of the last 24 h on `sent` messages whose rollup was lost, once 2 min old.
 */
export const OUTBOX_IDLE_MS = 2 * MINUTE;
export const LOST_ROLLUP_WINDOW_MS = 24 * 60 * MINUTE;
export const STALE_CLAIM_MS = 10 * MINUTE;
export const SWEEP_LIMIT = 500;

/** SMS poll (§7.10): poll points 2, 10, 30, 120 minutes, then every 120; give up at 24 h. */
export const POLL_INTERVAL_MS = 2 * MINUTE;
export const POLL_GIVE_UP_MS = 24 * 60 * MINUTE;
export const POLL_BUDGET = 100;
const POLL_POINTS = [2, 10, 30, 120].map((m) => m * MINUTE);

/** Whether an age window (from, to] crosses a poll point. */
export function crossesPollPoint(ageFrom: number, ageTo: number): boolean {
  if (POLL_POINTS.some((p) => p > ageFrom && p <= ageTo)) return true;
  const every = 120 * MINUTE;
  if (ageTo <= every) return false;
  // Points 240, 360, ...: the window holds one when floor(to / every) passes floor(from / every).
  return Math.floor(ageTo / every) > Math.floor(Math.max(ageFrom, every) / every);
}

/** The per-school bodies of the outbox sweep and the SMS delivery poll. */
@Injectable()
export class DeliverySweeps {
  private readonly logger = new Logger('DeliverySweeps');

  constructor(
    @Inject(MESSAGING_DRIVERS) private readonly drivers: MessagingDrivers,
    private readonly messages: MessageRepository,
    private readonly deliveries: MessageDeliveryRepository,
    private readonly encryption: FieldEncryption,
    private readonly outbox: OutboxDispatcher,
  ) {}

  /**
   * R105: re-enqueues what a lost enqueue or a crashed worker left behind - a `message` job for
   * a stale claim or an idle queued row, and a `message-rollup` for a report on a `sent` message
   * that its rollup never saw (the webhook's or the poll's enqueue was lost).
   */
  async outboxSweep(
    schoolId: SchoolId,
    now: Date = new Date(),
  ): Promise<{ requeued: number; idle: number; rollups: number }> {
    const stale = await this.messages.requeueStaleSending(
      schoolId,
      new Date(now.getTime() - STALE_CLAIM_MS),
      SWEEP_LIMIT,
    );
    const idle = await this.messages.listIdleQueued(
      schoolId,
      new Date(now.getTime() - OUTBOX_IDLE_MS),
      SWEEP_LIMIT,
    );
    const ids = [...new Set([...stale, ...idle])];
    const jobs: { id: bigint; round: number }[] = [];
    for (const id of ids) {
      jobs.push({ id, round: await this.deliveries.countForMessage(schoolId, id) });
    }
    await this.outbox.messages(schoolId, jobs);
    const lost = await this.deliveries.listUnrolledReports(
      schoolId,
      new Date(now.getTime() - LOST_ROLLUP_WINDOW_MS),
      new Date(now.getTime() - OUTBOX_IDLE_MS),
      SWEEP_LIMIT,
    );
    await this.outbox.rollup(schoolId, lost, Math.floor(now.getTime() / MINUTE));
    return { requeued: stale.length, idle: idle.length, rollups: lost.length };
  }

  /**
   * §7.10: accepted SMS past 24 h fail as `no_report` without a query; due rows (a poll point
   * crossed within this run's window) are asked once, at most POLL_BUDGET per school, oldest
   * first. A final status settles the row forward-only, clears poll_ref, and enqueues a rollup.
   */
  async smsPoll(schoolId: SchoolId, plannedRunAt: Date): Promise<{ expired: number; polled: number; settled: number }> {
    const reports: { deliveryId: bigint; messageId: bigint; status: string }[] = [];
    const expired = await this.deliveries.expireUnreported(
      schoolId,
      new Date(plannedRunAt.getTime() - POLL_GIVE_UP_MS),
      plannedRunAt,
    );
    for (const row of expired) reports.push({ deliveryId: row.id, messageId: row.messageId, status: 'failed' });

    const candidates = await this.deliveries.listAwaitingPoll(
      schoolId,
      new Date(plannedRunAt.getTime() - POLL_GIVE_UP_MS),
      POLL_BUDGET * 20,
    );
    const due = candidates
      .filter((row) => {
        const ageTo = plannedRunAt.getTime() - row.attemptedAt.getTime();
        return crossesPollPoint(ageTo - POLL_INTERVAL_MS, ageTo);
      })
      .slice(0, POLL_BUDGET);
    let settled = 0;
    for (const row of due) {
      try {
        const status = await this.drivers.sms.fetchStatus(
          this.encryption.decrypt(row.pollRef, pollRefAad(schoolId)),
        );
        if (status.kind === 'pending') continue;
        const to = status.kind;
        const changed = await this.deliveries.settle(
          schoolId,
          row.id,
          to,
          status.kind === 'failed' ? status.error : null,
          plannedRunAt,
        );
        if (changed === 1) {
          settled++;
          reports.push({ deliveryId: row.id, messageId: row.messageId, status: to });
        }
      } catch (error) {
        // The next poll point retries; never the reference or the provider's text.
        this.logger.warn(failureLog(error), 'sms status query failed');
      }
    }
    await this.outbox.rollup(schoolId, reports);
    return { expired: expired.length, polled: due.length, settled };
  }
}
