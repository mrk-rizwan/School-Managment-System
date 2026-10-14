import {
  ApiError,
  ErrorCode,
  formatDate,
  formatDateTime,
  formatRupees,
  formatTime,
  dayInSchool,
  type DutyKind,
  type ParticipationStatus,
} from '@asms/shared';
import { isNetworkError } from '../api/client';
import type { EventDto, EventRosterRowDto, MyEventDto } from '../api/contracts';

// Events and PTM on the phone (Phase 5 slice 38, contracts/slice-38.md §6): the pure parts of
// the teacher's event screens and the families' list. No React, no I/O.

export const DUTY_LABELS: Readonly<Record<DutyKind, string>> = {
  registration: 'Registration',
  supervision: 'Supervision',
  collection: 'Collection',
  transport: 'Transport',
  other: 'Other',
};

export const PARTICIPATION_LABELS: Readonly<Record<ParticipationStatus, string>> = {
  attended: 'Attended',
  absent: 'Absent',
  excused: 'Excused',
};

/** "14 Nov 2026, 10:00–12:00" on one day; otherwise both ends with their dates. */
export function eventWhen(e: Pick<EventDto, 'startsAt' | 'endsAt'>): string {
  if (dayInSchool(e.startsAt) === dayInSchool(e.endsAt)) {
    return `${formatDate(e.startsAt)}, ${formatTime(e.startsAt)}–${formatTime(e.endsAt)}`;
  }
  return `${formatDateTime(e.startsAt)} to ${formatDateTime(e.endsAt)}`;
}

/** The list row's right-hand word: the caller's duties, or the event's state when it is over. */
export function eventValue(e: Pick<EventDto, 'status' | 'myDuties'>): string | null {
  if (e.status === 'completed') return 'Completed';
  if (e.status === 'cancelled') return 'Cancelled';
  return e.myDuties.length === 0 ? null : e.myDuties.map((d) => DUTY_LABELS[d]).join(', ');
}

/** A collector takes event money only on a live collection duty of a published, charged event. */
export const canCollect = (e: Pick<EventDto, 'status' | 'myDuties' | 'charge'>): boolean =>
  e.status === 'published' && e.charge !== null && e.myDuties.includes('collection');

/** A roster row's second line: roll number, class and section. */
export const rosterDetail = (r: EventRosterRowDto): string =>
  [r.rollNo === null ? null : `Roll ${r.rollNo}`, `${r.className} ${r.sectionName}`]
    .filter(Boolean)
    .join(' · ');

/** A charge's state: what is still owed, or paid. */
export function chargeLine(charge: { amount: number; outstanding: number } | null): string | null {
  if (charge === null) return null;
  if (charge.outstanding <= 0) return `${formatRupees(charge.amount)} · Paid`;
  return charge.outstanding === charge.amount
    ? `${formatRupees(charge.amount)} owed`
    : `${formatRupees(charge.outstanding)} of ${formatRupees(charge.amount)} owed`;
}

/** The family list's charge line: the child's own charge only (§2.10). */
export const myChargeLine = (e: Pick<MyEventDto, 'charge'>): string | null =>
  e.charge === null ? null : `Charge: ${chargeLine(e.charge)}`;

/** The rows whose chosen status differs from what the server holds: what Save sends. */
export function changedRows(
  rows: readonly EventRosterRowDto[],
  draft: Readonly<Record<string, ParticipationStatus>>,
): { studentId: string; status: ParticipationStatus }[] {
  return rows
    .filter((r) => draft[r.studentId] !== undefined && draft[r.studentId] !== r.participation)
    .map((r) => ({ studentId: r.studentId, status: draft[r.studentId]! }));
}

/** Digits only, at most eight: whole rupees. */
export const rupeeDigits = (raw: string): string => raw.replace(/\D/g, '').slice(0, 8);

/** Why an amount typed for a collection cannot be sent, or null. */
export function amountProblem(text: string, outstanding: number): string | null {
  if (text === '') return 'Enter the amount received.';
  const amount = Number(text);
  if (amount <= 0) return 'Enter more than Rs 0.';
  if (amount > outstanding) return `At most ${formatRupees(outstanding)} is owed.`;
  return null;
}

/**
 * What a failed participation save or event payment says, and whether its request certainly
 * did not commit (a new Idempotency-Key is then due before a changed body is sent).
 */
export function eventWriteFailure(error: unknown): { message: string; definite: boolean } {
  if (isNetworkError(error)) {
    return {
      message: 'No connection. Nothing was sent; try again when connected.',
      definite: false,
    };
  }
  if (!(error instanceof ApiError)) {
    return { message: 'This could not be sent. Try again.', definite: false };
  }
  if (error.code === ErrorCode.EVENT_PAYMENT_EXCEEDS_CHARGE) {
    const outstanding = (error.details as { outstanding?: unknown } | null)?.outstanding;
    return {
      message:
        typeof outstanding === 'number'
          ? `More than is owed: ${formatRupees(outstanding)} is outstanding now.`
          : error.message,
      definite: true,
    };
  }
  if (error.code === ErrorCode.SELF_ACTION_FORBIDDEN) {
    return {
      message: 'You cannot collect for your own child. Another collector or the office records it.',
      definite: true,
    };
  }
  if (error.code === ErrorCode.EVENT_NOT_PUBLISHED) {
    return {
      message: 'This event is no longer open: it was completed or cancelled. Nothing was saved.',
      definite: true,
    };
  }
  return { message: error.fieldErrors[0]?.message ?? error.message, definite: true };
}
