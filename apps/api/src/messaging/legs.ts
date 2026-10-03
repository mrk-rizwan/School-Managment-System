// Leg bookkeeping for the processor (contracts/slice-9.md §7.6): attempt budgets, permanent
// failures, and the state of one leg from its delivery rows. Pure.
import type { DeliveryErrorCode, ExternalChannel, MessageChannel } from '@asms/shared';
import type { DeliveryRecord } from '../repositories/message-delivery.repository';

const MINUTE = 60_000;

/**
 * Each attempt's offset from the leg's first attempt. WhatsApp: three attempts over fifteen
 * minutes (R112); SMS 0, +2, +10 min; push 0, +1 min; email 0, +5, +30 min.
 */
export const ATTEMPT_OFFSETS: Readonly<Record<ExternalChannel, readonly number[]>> = {
  whatsapp: [0, 5 * MINUTE, 15 * MINUTE],
  sms: [0, 2 * MINUTE, 10 * MINUTE],
  push: [0, MINUTE],
  email: [0, 5 * MINUTE, 30 * MINUTE],
};

/** Failures that end a leg at once (no retry). */
export const PERMANENT_FAILURES: Readonly<Record<ExternalChannel, ReadonlySet<DeliveryErrorCode>>> = {
  whatsapp: new Set([
    'not_on_whatsapp',
    'invalid_number',
    'session_down',
    'outside_window',
    'rejected',
    'auth_failed',
  ]),
  sms: new Set(['invalid_number', 'dnd_blocked', 'rejected', 'auth_failed']),
  push: new Set(['unregistered_device']),
  email: new Set(['rejected']),
};

export type { ExternalChannel } from '@asms/shared';

export const isExternal = (channel: MessageChannel): channel is ExternalChannel =>
  channel !== 'in_app';

export interface LegState {
  finished: boolean;
  /** Accepted or delivered (the leg reached the provider). */
  succeeded: boolean;
  /** Ended by a suppression row. */
  suppressed: boolean;
  /** Attempts written so far. */
  attempts: number;
  /** When the next attempt is due; null when finished or never attempted (due now). */
  dueAt: Date | null;
}

/** A failed row whose failure came later than its attempt: a report failed an accepted send. */
const reportedFailure = (row: DeliveryRecord): boolean =>
  row.failedAt !== null && row.failedAt.getTime() > row.attemptedAt.getTime();

export function legState(channel: ExternalChannel, rows: readonly DeliveryRecord[]): LegState {
  const own = rows.filter((row) => row.channel === channel);
  const attempts = own.length;
  const base = { attempts, dueAt: null };
  if (own.some((row) => row.status === 'accepted' || row.status === 'delivered')) {
    return { ...base, finished: true, succeeded: true, suppressed: false };
  }
  if (own.some((row) => row.status === 'suppressed')) {
    return { ...base, finished: true, succeeded: false, suppressed: true };
  }
  const offsets = ATTEMPT_OFFSETS[channel];
  const permanent = own.some(
    (row) =>
      row.status === 'failed' &&
      (reportedFailure(row) ||
        (row.errorCode !== null && PERMANENT_FAILURES[channel].has(row.errorCode))),
  );
  if (permanent || attempts >= offsets.length) {
    return { ...base, finished: true, succeeded: false, suppressed: false };
  }
  const first = own[0];
  const offset = offsets[attempts] ?? 0;
  return {
    attempts,
    finished: false,
    succeeded: false,
    suppressed: false,
    dueAt: first ? new Date(first.attemptedAt.getTime() + offset) : null,
  };
}
