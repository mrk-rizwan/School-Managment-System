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
} as const;

/**
 * `message:<messageId>:<round>`, round = the message's delivery rows when enqueued, so a delayed
 * retry and a sweep re-enqueue of the same round collapse to one job. A follow-up of a round that
 * wrote no row (a paced WhatsApp send, nothing due yet) would reuse the running job's id and be
 * dropped, so it carries the due minute: `<round>w<minute>`.
 */
export const messageJobId = (messageId: bigint, round: number, waitMinute?: number): string =>
  `message:${messageId}:${round}${waitMinute === undefined ? '' : `w${waitMinute}`}`;

/**
 * `rollup:<deliveryId>:<status>`; the outbox sweep's recovery of a lost one carries its minute
 * (`...:s<minute>`), so a failed original kept by BullMQ cannot swallow it.
 */
export const rollupJobId = (deliveryId: bigint, status: string, sweepMinute?: number): string =>
  `rollup:${deliveryId}:${status}${sweepMinute === undefined ? '' : `:s${sweepMinute}`}`;

export const healthJobId = (whatsappNumberId: bigint, at: Date): string =>
  `wa-health:${whatsappNumberId}:${Math.floor(at.getTime() / 60_000)}`;

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
 * `alert:<alertId>`; the outbox sweep's recovery of a lost one carries its minute
 * (`alert:<alertId>:s<minute>`), so a failed original kept by BullMQ cannot swallow it.
 */
export const alertJobId = (alertId: bigint, sweepMinute?: number): string =>
  `alert:${alertId}${sweepMinute === undefined ? '' : `:s${sweepMinute}`}`;

/**
 * `att-rollup:<sectionId>:<YYYYMMDD>:<version>`: two writes of one version collapse to one job,
 * and a write that bumps the version gets a job of its own.
 */
export const rollupSectionDayJobId = (sectionId: bigint, date: string, version: bigint): string =>
  `att-rollup:${sectionId}:${date.replaceAll('-', '')}:${version}`;

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
