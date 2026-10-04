import { createServer, type Server } from 'node:http';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { ENV, type Env } from '../config/env';
import { failureLog } from '../common/errors/failure-log';
import { JOB, QUEUE } from '../messaging/queues';
import { SchoolMessagingRepository } from '../repositories/school-messaging.repository';
import { JobRunner } from './job-runner';

const MINUTE = 60_000;

/**
 * The repeatable jobs of the `scheduled` queue (contracts/slice-9.md §7.12). They replace
 * @nestjs/schedule: the HTTP process runs no job. A new scheduled job is a reviewed change here
 * (test/jobs/worker.e2e-spec.ts pins the list).
 */
export const SCHEDULES: readonly { job: string; every?: number; pattern?: string }[] = [
  { job: JOB.outboxSweep, every: 2 * MINUTE },
  { job: JOB.whatsappHealthSweep, every: 5 * MINUTE },
  { job: JOB.smsDeliveryPoll, every: 2 * MINUTE },
  { job: JOB.deliveryHealthRollup, every: 15 * MINUTE },
  // Daily at 02:30 school time, as the Phase 1 cron was.
  { job: JOB.stagedUploadSweep, pattern: '0 30 2 * * *' },
  // Daily at 03:00 school time: sessions ended more than 90 days ago, with their devices (§1.5).
  { job: JOB.sessionPurge, pattern: '0 0 3 * * *' },
  // contracts/slice-11.md §8.4, §8.3: unrecorded registers after each school's deadline, and the
  // nightly attendance recompute at 00:30 school time.
  { job: JOB.registerDeadlineSweep, every: 5 * MINUTE },
  { job: JOB.attendanceNightlyRecompute, pattern: '0 30 0 * * *' },
];

/** Concurrency per queue, explicit (plan §3). */
const CONCURRENCY = { messaging: 10, scheduled: 1, attendance: 5 } as const;

/**
 * Runs only in the worker process (ENV.WORKER, set by src/worker.ts): the BullMQ consumers of the
 * `messaging` and `scheduled` queues, the job schedulers, and the worker's health endpoint on
 * WORKER_HEALTH_PORT (200 when Postgres and Redis answer, else 503). No job runs while Redis is
 * down: BullMQ cannot fetch one. Shutdown closes the workers, which lets in-flight jobs finish.
 */
@Injectable()
export class WorkerHost implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('WorkerHost');
  private workers: Worker[] = [];
  private scheduler: Queue | undefined;
  private server: Server | undefined;
  private probe: Redis | undefined;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly runner: JobRunner,
    private readonly db: SchoolMessagingRepository,
  ) {}

  private connection(): ConnectionOptions {
    return { url: this.env.REDIS_URL, maxRetriesPerRequest: null };
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.env.WORKER) return;
    const connection = this.connection();
    this.workers = [
      new Worker(QUEUE.messaging, (job: Job) => this.runner.messaging(job.name, job.data), {
        connection,
        concurrency: CONCURRENCY.messaging,
      }),
      new Worker(QUEUE.scheduled, (job: Job) => this.runner.scheduled(job.name, plannedAt(job)), {
        connection,
        concurrency: CONCURRENCY.scheduled,
      }),
      new Worker(QUEUE.attendance, (job: Job) => this.runner.attendance(job.name, job.data), {
        connection,
        concurrency: CONCURRENCY.attendance,
      }),
    ];
    for (const worker of this.workers) {
      // Never the job's data or the raw error.
      worker.on('failed', (job, error) =>
        this.logger.error({ ...failureLog(error), job: job?.name ?? 'unknown' }, 'job failed'),
      );
      worker.on('error', (error) => this.logger.error(failureLog(error), 'worker error'));
    }
    this.scheduler = new Queue(QUEUE.scheduled, { connection });
    for (const { job, every, pattern } of SCHEDULES) {
      await this.scheduler.upsertJobScheduler(
        job,
        pattern === undefined ? { every } : { pattern, tz: 'Asia/Karachi' },
        { name: job, opts: { removeOnComplete: true, removeOnFail: 100 } },
      );
    }
    this.server = createServer((req, res) => {
      if (req.url !== '/health') {
        res.writeHead(404).end();
        return;
      }
      void this.healthy().then((ok) => {
        res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: ok ? 'ok' : 'unavailable' }));
      });
    });
    this.server.listen(this.env.WORKER_HEALTH_PORT, '127.0.0.1');
    this.logger.log('worker queues started');
  }

  /** Postgres and Redis both answer. */
  async healthy(): Promise<boolean> {
    try {
      await this.db.ping();
      this.probe ??= new Redis(this.env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
      return (await this.probe.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    for (const worker of this.workers) await worker.close();
    await this.scheduler?.close();
    this.probe?.disconnect();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

/** When the repeatable job was due: its creation plus its delay. */
function plannedAt(job: Job): Date {
  return new Date(job.timestamp + (job.delay ?? 0));
}
