import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { AttendanceModule } from '../modules/attendance/attendance.module';
import { DocumentsModule } from '../modules/documents/documents.module';
import { QueueTenancyModule } from '../tenancy/queue.mint';
import { DELIVERY_HEALTH_ROLLUP_PROVIDERS } from './delivery-health-rollup';
import { JOB_RUNNER_PROVIDERS, JobRunner } from './job-runner';
import { SessionPurge } from './session-purge';
import { WorkerHost } from './worker-host';

/**
 * The worker's queues and scheduled jobs (Phase 2 plan §2-§4.1, contracts/slice-9.md §7.12). The
 * module is part of every process, but WorkerHost starts consumers and schedulers only when
 * ENV.WORKER is set (src/worker.ts); the HTTP process enqueues through OutboxDispatcher and runs
 * no job.
 */
@Module({
  imports: [MessagingModule, QueueTenancyModule, DocumentsModule, AttendanceModule],
  providers: [...JOB_RUNNER_PROVIDERS, ...DELIVERY_HEALTH_ROLLUP_PROVIDERS, SessionPurge, WorkerHost],
  exports: [JobRunner],
})
export class JobsModule {}
