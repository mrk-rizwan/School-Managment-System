// Queue and job names and deterministic job ids (contracts/slice-9.md §7.12). Shared by the
// producer (outbox-dispatcher.ts) and the consumers (src/jobs/**); no queue library here.

export const QUEUE = {
  messaging: 'messaging',
  scheduled: 'scheduled',
  /** Attendance alerts and the section-day rollup (contracts/slice-11.md §8.5). */
  attendance: 'attendance',
} as const;

export const JOB = {
  message: 'message',
  messageRollup: 'message-rollup',
  whatsappHealth: 'whatsapp-health',
  outboxSweep: 'outbox-sweep',
  whatsappHealthSweep: 'whatsapp-health-sweep',
  smsDeliveryPoll: 'sms-delivery-poll',
  deliveryHealthRollup: 'delivery-health-rollup',
  stagedUploadSweep: 'staged-upload-sweep',
  sessionPurge: 'session-purge',
  // contracts/slice-11.md §8.5.
  attendanceAlert: 'attendance-alert',
  attendanceRollup: 'attendance-rollup',
  registerDeadlineSweep: 'register-deadline-sweep',
  attendanceNightlyRecompute: 'attendance-nightly-recompute',
  // contracts/slice-14.md §5.6: a scheduled announcement's send, on the messaging queue.
  announcementSend: 'announcement-send',
  // Phase 3 slice 26 (phase-3-financial.md §3.7): the platform's daily billing run (non-tenant),
  // the per-school student-count rollup and the per-school invoice notices.
  platformBilling: 'platform-billing',
  schoolMetricsRollup: 'school-metrics-rollup',
  billingNotices: 'billing-notices',
  // Phase 3 slice 19 (phase-3-financial.md §3.7): the daily monthly generation (the 1st, then the
  // catch-up) and the late-fee sweep on the scheduled queue; a requested monthly or campaign run
  // (`charge_runs` row) on the messaging queue.
  chargeGenerate: 'charge-generate',
  lateFeeSweep: 'late-fee-sweep',
  chargeRun: 'charge-run',
  // Phase 3 slice 25 (§3.7): on each school's pay day, the previous month's draft payroll run.
  payrollPrepare: 'payroll-prepare',
  // Phase 3 slice 22 (§3.7): daily at 09:00 school time, the fee reminders (R201, R202, R250).
  feeReminder: 'fee-reminder',
  // Phase 3 slice 21 (§3.7, R200): daily, deposit claims still without their slip after 24 h expire.
  claimImageSweep: 'claim-image-sweep',
} as const;

/*
 * Job ids use '-' as the separator, never ':'. BullMQ refuses a custom id containing ':' unless it
 * splits into exactly three parts ("Custom Id cannot contain :"), so `alert:<id>` and the four-part
 * ids were refused at enqueue and those jobs never ran (absence alerts, attendance rollups; found
 * 2026-10-04). test/jobs/job-ids.e2e-spec.ts adds every shape to a real queue.
 */

/**
 * `message-<messageId>-<round>`, round = the message's delivery rows when enqueued, so a delayed
 * retry and a sweep re-enqueue of the same round collapse to one job. A follow-up of a round that
 * wrote no row (a paced WhatsApp send, nothing due yet) would reuse the running job's id and be
 * dropped, so it carries the due minute: `<round>w<minute>`.
 */
export const messageJobId = (messageId: bigint, round: number, waitMinute?: number): string =>
  `message-${messageId}-${round}${waitMinute === undefined ? '' : `w${waitMinute}`}`;

/**
 * `rollup-<deliveryId>-<status>`; the outbox sweep's recovery of a lost one carries its minute
 * (`...-s<minute>`), so a failed original kept by BullMQ cannot swallow it.
 */
export const rollupJobId = (deliveryId: bigint, status: string, sweepMinute?: number): string =>
  `rollup-${deliveryId}-${status}${sweepMinute === undefined ? '' : `-s${sweepMinute}`}`;

export const healthJobId = (whatsappNumberId: bigint, at: Date): string =>
  `wa-health-${whatsappNumberId}-${Math.floor(at.getTime() / 60_000)}`;

/** Payloads carry ids only, as decimal strings (R113); never a body, phone or name. */
export interface MessageJobPayload {
  schoolId: string;
  messageId: string;
}

export interface HealthJobPayload {
  schoolId: string;
  whatsappNumberId: string;
}

/**
 * `alert-<alertId>`; the outbox sweep's recovery of a lost one carries its minute
 * (`alert-<alertId>-s<minute>`), so a failed original kept by BullMQ cannot swallow it.
 */
export const alertJobId = (alertId: bigint, sweepMinute?: number): string =>
  `alert-${alertId}${sweepMinute === undefined ? '' : `-s${sweepMinute}`}`;

/**
 * `att-rollup-<sectionId>-<YYYYMMDD>-<version>`: two writes of one version collapse to one job,
 * and a write that bumps the version gets a job of its own.
 */
export const rollupSectionDayJobId = (sectionId: bigint, date: string, version: bigint): string =>
  `att-rollup-${sectionId}-${date.replaceAll('-', '')}-${version}`;

/**
 * `ann-send-<announcementId>-<scheduledAtEpochSeconds>` (contracts/slice-14.md §5.6): a changed
 * time is a new job and the stale one finds its claim false. The outbox sweep's recovery of a
 * lost one carries its minute (`...-s<minute>`).
 */
export const announcementSendJobId = (announcementId: bigint, scheduledAt: Date, sweepMinute?: number): string =>
  `ann-send-${announcementId}-${Math.floor(scheduledAt.getTime() / 1000)}${sweepMinute === undefined ? '' : `-s${sweepMinute}`}`;

/**
 * `charge-run-<runId>` (contracts/slice-19.md §5): a requested monthly or campaign run. A lost job
 * is not re-enqueued: the stale sweep fails the run after 10 minutes queued (R252) and the office
 * runs it again.
 */
export const chargeRunJobId = (runId: bigint): string => `charge-run-${runId}`;

export interface ChargeRunPayload {
  schoolId: string;
  runId: string;
}

export interface AnnouncementSendPayload {
  schoolId: string;
  announcementId: string;
}

export interface AlertJobPayload {
  schoolId: string;
  alertId: string;
}

/** `date` (`YYYY-MM-DD`) is the only non-id field a payload may carry (§8.5). */
export interface RollupJobPayload {
  schoolId: string;
  sectionId: string;
  date: string;
}
