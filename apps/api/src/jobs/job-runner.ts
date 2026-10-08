import { Injectable, Logger } from '@nestjs/common';
import { failureLog } from '../common/errors/failure-log';
import { DeliverySweeps } from '../messaging/delivery-sweeps';
import { MessageProcessor } from '../messaging/message-processor';
import { MessageRollup } from '../messaging/message-rollup';
import { JOB } from '../messaging/queues';
import { WhatsAppHealth } from '../messaging/whatsapp-health';
import { AttendanceAlertProcessor } from '../modules/attendance/attendance-alerts';
import {
  AttendanceRollup,
  AttendanceSweeps,
  RegisterDeadlineSweep,
} from '../modules/attendance/attendance-jobs';
import { StagedUploadSweep } from '../modules/documents/staged-upload.sweep';
import { AnnouncementSendJob } from '../modules/announcements/announcement-send.job';
import { ChargeGeneration } from '../modules/fees/charge-generation';
import { PayrollPrepare } from '../modules/payroll/payroll-prepare.job';
import { FeeReminders } from '../modules/finance-reports/fee-reminders';
import { ClaimsService } from '../modules/payments/claims.service';
import { ResultNotifyJob } from '../modules/results/result-notify.job';
// Named exception 3, the scheduler fan-out (NAMED_EXCEPTION_SITES in eslint.config.mjs).
import { SchoolFanOutRepository } from '../repositories/platform/school-fan-out.repository';
import { QueueTenancy } from '../tenancy/queue.mint';
import type { SchoolId } from '../tenancy/school-id';
import { DeliveryHealthRollup } from './delivery-health-rollup';
import { SessionPurge } from './session-purge';
import { BillingNotices } from './billing-notices';
import { PlatformBillingJob } from './platform-billing';
import { SchoolMetricsRollup } from './school-metrics-rollup';

export type JobOutcome = 'done' | 'dropped' | 'unknown';

/**
 * Every job body, independent of the queue library so tests drive it directly
 * (contracts/slice-9.md §7.12). A payload becomes a SchoolId only through fromQueuePayload (R113):
 * a malformed payload, an unknown or a terminated school is dropped (logged by job name only,
 * never its ids), not retried. Each body runs in runAsSchool, so concurrent jobs for two schools
 * never share a tenant or a transaction. Housekeeping fans out per live school in-process.
 */
@Injectable()
export class JobRunner {
  private readonly logger = new Logger('JobRunner');

  constructor(
    private readonly tenancy: QueueTenancy,
    private readonly fanOut: SchoolFanOutRepository,
    private readonly processor: MessageProcessor,
    private readonly rollup: MessageRollup,
    private readonly health: WhatsAppHealth,
    private readonly sweeps: DeliverySweeps,
    private readonly deliveryHealth: DeliveryHealthRollup,
    private readonly stagedUploads: StagedUploadSweep,
    private readonly sessionPurge: SessionPurge,
    private readonly attendanceAlerts: AttendanceAlertProcessor,
    private readonly attendanceRollup: AttendanceRollup,
    private readonly attendanceSweeps: AttendanceSweeps,
    private readonly registerDeadline: RegisterDeadlineSweep,
    private readonly announcementSend: AnnouncementSendJob,
    // Slice 19 (phase-3-financial.md §3.7).
    private readonly charges: ChargeGeneration,
    // Slice 26 (phase-3-financial.md §3.7).
    private readonly platformBilling: PlatformBillingJob,
    private readonly schoolMetrics: SchoolMetricsRollup,
    private readonly billingNotices: BillingNotices,
    // Slice 25 (phase-3-financial.md §3.7).
    private readonly payroll: PayrollPrepare,
    // Slice 22 (phase-3-financial.md §3.7).
    private readonly feeReminders: FeeReminders,
    // Slice 21 (phase-3-financial.md §3.7, R200).
    private readonly claims: ClaimsService,
    // Phase 4 slice 31 (phase-4-academic.md §3.6).
    private readonly resultNotify: ResultNotifyJob,
  ) {}

  /**
   * The `messaging` queue: message, message-rollup, whatsapp-health, announcement-send. `dueAt` is
   * when the producer asked the job to run (its creation plus its delay, WorkerHost.plannedAt).
   */
  async messaging(name: string, payload: unknown, now: Date = new Date(), dueAt: Date = now): Promise<JobOutcome> {
    switch (name) {
      case JOB.message: {
        const job = await this.tenancy.fromQueuePayload(payload, ['messageId']);
        if (!job) return this.dropped(name);
        await this.tenancy.runAsSchool(job.schoolId, () => this.processor.run(job.schoolId, job.ids.messageId));
        return 'done';
      }
      case JOB.messageRollup: {
        const job = await this.tenancy.fromQueuePayload(payload, ['messageId']);
        if (!job) return this.dropped(name);
        await this.tenancy.runAsSchool(job.schoolId, () => this.rollup.run(job.schoolId, job.ids.messageId));
        return 'done';
      }
      case JOB.whatsappHealth: {
        const job = await this.tenancy.fromQueuePayload(payload, ['whatsappNumberId']);
        if (!job) return this.dropped(name);
        await this.tenancy.runAsSchool(job.schoolId, () =>
          this.health.check(job.schoolId, job.ids.whatsappNumberId),
        );
        return 'done';
      }
      // contracts/slice-14.md §5.6: an announcement's send, now or at its time.
      case JOB.announcementSend: {
        const job = await this.tenancy.fromQueuePayload(payload, ['announcementId']);
        if (!job) return this.dropped(name);
        await this.tenancy.runAsSchool(job.schoolId, () =>
          this.announcementSend.fire(job.schoolId, job.ids.announcementId, now, dueAt),
        );
        return 'done';
      }
      // contracts/slice-19.md §5: a requested monthly or campaign run (its charge_runs row).
      case JOB.chargeRun: {
        const job = await this.tenancy.fromQueuePayload(payload, ['runId']);
        if (!job) return this.dropped(name);
        await this.tenancy.runAsSchool(job.schoolId, () => this.charges.run(job.schoolId, job.ids.runId, now));
        return 'done';
      }
      // Phase 4 slice 31 (§3.6): a published sheet's family messages; slice 32 adds a corrected
      // result's (`resultId`).
      case JOB.resultNotify: {
        const job =
          (await this.tenancy.fromQueuePayload(payload, ['sheetId'])) ??
          (await this.tenancy.fromQueuePayload(payload, ['resultId']));
        if (!job) return this.dropped(name);
        const target = 'sheetId' in job.ids ? { sheetId: job.ids.sheetId } : { resultId: job.ids.resultId };
        await this.tenancy.runAsSchool(job.schoolId, () => this.resultNotify.run(job.schoolId, target, now));
        return 'done';
      }
      default:
        return this.dropped(name);
    }
  }

  /** The `attendance` queue (contracts/slice-11.md §8.5): attendance-alert, attendance-rollup. */
  async attendance(name: string, payload: unknown, now: Date = new Date()): Promise<JobOutcome> {
    switch (name) {
      case JOB.attendanceAlert: {
        const job = await this.tenancy.fromQueuePayload(payload, ['alertId']);
        if (!job) return this.dropped(name);
        await this.tenancy.runAsSchool(job.schoolId, () =>
          this.attendanceAlerts.run(job.schoolId, job.ids.alertId, now),
        );
        return 'done';
      }
      case JOB.attendanceRollup: {
        const job = await this.tenancy.fromQueuePayload(payload, ['sectionId'], ['date']);
        const date = job?.dates?.date;
        if (!job || !date) return this.dropped(name);
        await this.tenancy.runAsSchool(job.schoolId, () =>
          this.attendanceRollup.recompute(job.schoolId, job.ids.sectionId, date, now),
        );
        return 'done';
      }
      default:
        return this.dropped(name);
    }
  }

  /** The `scheduled` queue: repeatable housekeeping (no payload). */
  async scheduled(name: string, plannedAt: Date): Promise<JobOutcome> {
    switch (name) {
      case JOB.outboxSweep:
        // Messaging's sources, then attendance's two (contracts/slice-11.md §8.3), then the
        // scheduled announcements (contracts/slice-14.md §5.6, slice-9 §7.9's reserved source).
        await this.eachSchool(name, async (schoolId) => {
          await this.sweeps.outboxSweep(schoolId, plannedAt);
          await this.attendanceSweeps.outboxSweep(schoolId, plannedAt);
          await this.announcementSend.sweep(schoolId, plannedAt);
          // R252: a charge run queued 10 minutes or running 15 is failed `stale`.
          await this.charges.staleSweep(schoolId, plannedAt);
          // §3.6: a published sheet whose result-notify job was lost after commit.
          await this.resultNotify.sweep(schoolId, plannedAt);
        });
        return 'done';
      case JOB.registerDeadlineSweep:
        await this.eachSchool(name, (schoolId) => this.registerDeadline.run(schoolId, plannedAt));
        return 'done';
      case JOB.attendanceNightlyRecompute:
        await this.eachSchool(name, (schoolId) => this.attendanceSweeps.nightly(schoolId, plannedAt));
        return 'done';
      case JOB.whatsappHealthSweep:
        await this.eachSchool(name, (schoolId) => this.health.check(schoolId, undefined, plannedAt));
        return 'done';
      case JOB.smsDeliveryPoll:
        await this.eachSchool(name, (schoolId) => this.sweeps.smsPoll(schoolId, plannedAt));
        return 'done';
      case JOB.deliveryHealthRollup:
        await this.eachSchool(name, (schoolId) => this.deliveryHealth.run(schoolId, plannedAt));
        return 'done';
      case JOB.stagedUploadSweep:
        // Its own fan-out over every school, terminated included (R41, R90).
        await this.stagedUploads.runDaily();
        return 'done';
      // Slice 19 (§3.7): the daily generation (the 1st, then the catch-up) and the late-fee sweep.
      case JOB.chargeGenerate:
        await this.eachSchool(name, (schoolId) => this.charges.daily(schoolId, plannedAt));
        return 'done';
      case JOB.lateFeeSweep:
        await this.eachSchool(name, (schoolId) => this.charges.lateFees(schoolId, plannedAt));
        return 'done';
      // Slice 25 (§3.7, R214): daily; a school whose pay day it is gets last month's draft.
      case JOB.payrollPrepare:
        await this.eachSchool(name, (schoolId) => this.payroll.run(schoolId, plannedAt));
        return 'done';
      // Slice 22 (§3.7, R201, R202, R250): the day's due and overdue fee reminders.
      case JOB.feeReminder:
        await this.eachSchool(name, (schoolId) => this.feeReminders.daily(schoolId, plannedAt));
        return 'done';
      // Slice 21 (§3.7, R200): deposit claims still without their slip after 24 h expire.
      case JOB.claimImageSweep:
        await this.eachSchool(name, (schoolId) => this.claims.expireImageless(schoolId, plannedAt));
        return 'done';
      case JOB.sessionPurge:
        // Every school, terminated included: a dead sign-in is not history anywhere.
        await this.eachSchool(name, (schoolId) => this.sessionPurge.run(schoolId, plannedAt), 'all');
        return 'done';
      // Slice 26: the per-school count (every live school, trial and suspended included), the
      // non-tenant billing run (no school context), and the per-school invoice notices.
      case JOB.schoolMetricsRollup:
        await this.eachSchool(name, (schoolId) => this.schoolMetrics.run(schoolId, plannedAt));
        return 'done';
      case JOB.platformBilling:
        await this.platformBilling.run(plannedAt);
        return 'done';
      case JOB.billingNotices:
        await this.eachSchool(name, (schoolId) => this.billingNotices.run(schoolId));
        return 'done';
      default:
        return this.dropped(name);
    }
  }

  /** One school's failure is logged and does not stop the others. Live schools unless `all`. */
  private async eachSchool(
    name: string,
    fn: (schoolId: SchoolId) => Promise<unknown>,
    schools: 'live' | 'all' = 'live',
  ): Promise<void> {
    const ids =
      schools === 'all' ? await this.fanOut.listAllForFanOut() : await this.fanOut.listLiveForFanOut();
    for (const schoolId of ids) {
      try {
        await this.tenancy.runAsSchool(schoolId, () => fn(schoolId));
      } catch (error) {
        this.logger.error({ ...failureLog(error), job: name, schoolId: schoolId.toString() }, 'scheduled job failed for a school');
      }
    }
  }

  private dropped(name: string): JobOutcome {
    this.logger.warn({ job: name }, 'job dropped: payload did not resolve');
    return 'dropped';
  }
}

/** The runner with the fan-out repository it needs, so only this file imports it. */
export const JOB_RUNNER_PROVIDERS = [JobRunner, SchoolFanOutRepository];
