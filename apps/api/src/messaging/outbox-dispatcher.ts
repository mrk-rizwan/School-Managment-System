import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';
import { ENV, type Env } from '../config/env';
import { failureLog } from '../common/errors/failure-log';
import { AfterCommit } from '../tenancy/after-commit';
import type { SchoolId } from '../tenancy/school-id';
import {
  healthJobId,
  JOB,
  messageJobId,
  QUEUE,
  rollupJobId,
  type HealthJobPayload,
  type MessageJobPayload,
} from './queues';

/**
 * Puts jobs on the `messaging` queue (Phase 2 plan rule 0.11, R105). Inside a transaction a job is
 * enqueued only after commit; outside one (the worker, a webhook) at once. Redis is not a system
 * of record: an enqueue that fails is logged and the outbox sweep (§7.9) re-enqueues the row, so
 * a failure never reaches the caller. Completed jobs are removed, so an id can be reused by the
 * sweep; a replayed job finds its row already claimed.
 */
@Injectable()
export class OutboxDispatcher implements OnModuleDestroy {
  private readonly logger = new Logger('OutboxDispatcher');
  #queue: Queue | undefined;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly afterCommit: AfterCommit,
  ) {}

  private queue(): Queue {
    this.#queue ??= new Queue(QUEUE.messaging, {
      connection: { url: this.env.REDIS_URL, maxRetriesPerRequest: 1 },
      defaultJobOptions: { removeOnComplete: true, removeOnFail: 1000, attempts: 1 },
    });
    return this.#queue;
  }

  /** Throws outside a transaction (a sender bug: send() must run in the sender's transaction). */
  requireTransaction(): void {
    this.afterCommit.register(() => Promise.resolve());
  }

  /** After the ambient transaction commits: one `message` job per id (round 0). */
  messagesAfterCommit(schoolId: SchoolId, messageIds: readonly bigint[]): void {
    if (messageIds.length === 0) return;
    const ids = [...messageIds];
    this.afterCommit.register(() => this.messages(schoolId, ids.map((id) => ({ id, round: 0 }))));
  }

  /** At once, e.g. the sweep or a delayed retry. `delayMs` 0 means now. */
  async messages(
    schoolId: SchoolId,
    jobs: readonly { id: bigint; round: number; delayMs?: number; waitMinute?: number }[],
  ): Promise<void> {
    if (jobs.length === 0) return;
    await this.add(
      jobs.map(({ id, round, delayMs, waitMinute }) => ({
        name: JOB.message,
        data: { schoolId: schoolId.toString(), messageId: id.toString() } satisfies MessageJobPayload,
        opts: { jobId: messageJobId(id, round, waitMinute), delay: Math.max(0, delayMs ?? 0) },
      })),
    );
  }

  /**
   * A delivery moved by a report (webhook, SMS poll): re-roll its message (§7.6). The outbox
   * sweep passes its minute when it recovers a lost one.
   */
  async rollup(
    schoolId: SchoolId,
    reports: readonly { deliveryId: bigint; messageId: bigint; status: string }[],
    sweepMinute?: number,
  ): Promise<void> {
    await this.add(
      reports.map((r) => ({
        name: JOB.messageRollup,
        data: { schoolId: schoolId.toString(), messageId: r.messageId.toString() } satisfies MessageJobPayload,
        opts: { jobId: rollupJobId(r.deliveryId, r.status, sweepMinute) },
      })),
    );
  }

  /** An immediate health check of one school's number (the session.status webhook, §8.2). */
  async health(schoolId: SchoolId, whatsappNumberId: bigint, now: Date): Promise<void> {
    await this.add([
      {
        name: JOB.whatsappHealth,
        data: {
          schoolId: schoolId.toString(),
          whatsappNumberId: whatsappNumberId.toString(),
        } satisfies HealthJobPayload,
        opts: { jobId: healthJobId(whatsappNumberId, now) },
      },
    ]);
  }

  private async add(
    jobs: { name: string; data: MessageJobPayload | HealthJobPayload; opts: JobsOptions }[],
  ): Promise<void> {
    if (jobs.length === 0) return;
    try {
      await this.queue().addBulk(jobs);
    } catch (error) {
      // The sweep re-enqueues anything lost (R105); the caller's work is already committed.
      this.logger.error({ ...failureLog(error), jobs: jobs.length }, 'enqueue failed');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.#queue?.close();
  }
}
