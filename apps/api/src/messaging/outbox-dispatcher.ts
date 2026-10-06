import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';
import { ENV, type Env } from '../config/env';
import { failureLog } from '../common/errors/failure-log';
import { AfterCommit } from '../tenancy/after-commit';
import type { SchoolId } from '../tenancy/school-id';
import {
  alertJobId,
  announcementSendJobId,
  chargeRunJobId,
  healthJobId,
  JOB,
  messageJobId,
  QUEUE,
  rollupJobId,
  rollupSectionDayJobId,
  type AlertJobPayload,
  type AnnouncementSendPayload,
  type ChargeRunPayload,
  type HealthJobPayload,
  type MessageJobPayload,
  type RollupJobPayload,
} from './queues';

type QueueName = (typeof QUEUE)[keyof typeof QUEUE];
type Payload =
  | MessageJobPayload
  | HealthJobPayload
  | AlertJobPayload
  | RollupJobPayload
  | AnnouncementSendPayload
  | ChargeRunPayload;

/** A scheduled announcement's send at its time (contracts/slice-14.md §5.6). */
export interface AnnouncementSendJob {
  id: bigint;
  scheduledAt: Date;
  /** The outbox sweep's minute when it recovers a lost job. */
  sweepMinute?: number;
}

/** An attendance alert row to send at its due time (contracts/slice-11.md §6.4). */
export interface AlertJob {
  id: bigint;
  dueAt: Date;
  /** The outbox sweep's minute when it recovers a lost job. */
  sweepMinute?: number;
}

/** A section-day to recompute at the version a write left it (contracts/slice-11.md §8.2). */
export interface RollupJob {
  sectionId: bigint;
  /** `YYYY-MM-DD`. */
  date: string;
  version: bigint;
}

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
  readonly #queues = new Map<QueueName, Queue>();
  #enqueueFailures = 0;
  /**
   * BullMQ's key prefix; undefined is BullMQ's own, which the worker reads. Only a test overrides
   * it, so its queues are its own and can be obliterated (test/jobs/outbox-dispatcher.e2e-spec.ts).
   */
  protected readonly prefix: string | undefined = undefined;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly afterCommit: AfterCommit,
  ) {}

  private queue(name: QueueName): Queue {
    let queue = this.#queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: { url: this.env.REDIS_URL, maxRetriesPerRequest: 1 },
        ...(this.prefix === undefined ? {} : { prefix: this.prefix }),
        defaultJobOptions: { removeOnComplete: true, removeOnFail: 1000, attempts: 1 },
      });
      this.#queues.set(name, queue);
    }
    return queue;
  }

  /**
   * Enqueues that failed since start. A failure is swallowed (the sweep recovers the row), so this
   * count and the error log line are how one is seen; the messaging harness asserts it stays 0.
   */
  get enqueueFailures(): number {
    return this.#enqueueFailures;
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

  /** After the ambient transaction commits: each alert's job, delayed to its due time. */
  alertsAfterCommit(schoolId: SchoolId, alerts: readonly AlertJob[]): void {
    if (alerts.length === 0) return;
    const jobs = [...alerts];
    this.afterCommit.register(() => this.alerts(schoolId, jobs));
  }

  /** At once (the sweep): `attendance-alert` jobs delayed to `dueAt` (0 when already due). */
  async alerts(schoolId: SchoolId, alerts: readonly AlertJob[], now: Date = new Date()): Promise<void> {
    await this.add(
      alerts.map((a) => ({
        name: JOB.attendanceAlert,
        data: { schoolId: schoolId.toString(), alertId: a.id.toString() } satisfies AlertJobPayload,
        opts: {
          jobId: alertJobId(a.id, a.sweepMinute),
          delay: Math.max(0, a.dueAt.getTime() - now.getTime()),
        },
      })),
      QUEUE.attendance,
    );
  }

  /** After the ambient transaction commits: the announcement's send, delayed to its time. */
  announcementSendAfterCommit(schoolId: SchoolId, job: AnnouncementSendJob): void {
    this.afterCommit.register(() => this.announcementSends(schoolId, [job]));
  }

  /** At once (the sweep): `announcement-send` jobs delayed to `scheduledAt` (0 when due). */
  async announcementSends(
    schoolId: SchoolId,
    jobs: readonly AnnouncementSendJob[],
    now: Date = new Date(),
  ): Promise<void> {
    await this.add(
      jobs.map((job) => ({
        name: JOB.announcementSend,
        data: {
          schoolId: schoolId.toString(),
          announcementId: job.id.toString(),
        } satisfies AnnouncementSendPayload,
        opts: {
          jobId: announcementSendJobId(job.id, job.scheduledAt, job.sweepMinute),
          delay: Math.max(0, job.scheduledAt.getTime() - now.getTime()),
        },
      })),
    );
  }

  /** After the ambient transaction commits: a requested charge run's job (contracts/slice-19.md §5). */
  chargeRunAfterCommit(schoolId: SchoolId, runId: bigint): void {
    this.afterCommit.register(() =>
      this.add([
        {
          name: JOB.chargeRun,
          data: { schoolId: schoolId.toString(), runId: runId.toString() } satisfies ChargeRunPayload,
          opts: { jobId: chargeRunJobId(runId) },
        },
      ]),
    );
  }

  /** After the ambient transaction commits: the section-days' rollup jobs. */
  rollupsAfterCommit(schoolId: SchoolId, rollups: readonly RollupJob[]): void {
    if (rollups.length === 0) return;
    const jobs = [...rollups];
    this.afterCommit.register(() => this.rollups(schoolId, jobs));
  }

  /** At once (the sweep, the nightly job): `attendance-rollup` jobs. */
  async rollups(schoolId: SchoolId, rollups: readonly RollupJob[]): Promise<void> {
    await this.add(
      rollups.map((r) => ({
        name: JOB.attendanceRollup,
        data: {
          schoolId: schoolId.toString(),
          sectionId: r.sectionId.toString(),
          date: r.date,
        } satisfies RollupJobPayload,
        opts: { jobId: rollupSectionDayJobId(r.sectionId, r.date, r.version) },
      })),
      QUEUE.attendance,
    );
  }

  private async add(
    jobs: { name: string; data: Payload; opts: JobsOptions }[],
    queue: QueueName = QUEUE.messaging,
  ): Promise<void> {
    if (jobs.length === 0) return;
    try {
      await this.queue(queue).addBulk(jobs);
    } catch (error) {
      // The sweep re-enqueues anything lost (R105); the caller's work is already committed.
      this.#enqueueFailures++;
      this.logger.error({ ...failureLog(error), jobs: jobs.length }, 'enqueue failed');
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const queue of this.#queues.values()) await queue.close();
  }
}
