import { ApiError, ErrorCode, formatDateTime, formatDay, formatRupees, PAYMENT_METHOD_LABELS } from '@asms/shared';
import { api, isNetworkError, unwrap } from '../api/client';
import type { ApprovalsDto, ClaimDto, ExpenseDto, HandoverDto, LeaveRequestDto } from '../api/contracts';

// The Approvals tab (phase-3-financial.md slice 27, R226, R227): GET /me/approvals holds only the
// sections whose key the user has, each its queue's first ten rows and total. Every decision is
// online-only: it goes straight to the server, never the outbox, and nothing is cached on the
// phone. A decision someone took elsewhere comes back 409: the server's sentence is shown and
// the list is read again.

export const fetchApprovals = (): Promise<ApprovalsDto> => unwrap(api.GET('/api/v1/me/approvals'));

export type Failure = {
  message: string;
  /** The row moved on the server (409): close the sheet and read the list again. */
  stale: boolean;
};

/** What to tell the user when a decision fails. */
export function decisionFailure(error: unknown): Failure {
  if (isNetworkError(error)) return { message: 'No connection. Nothing was sent; try again when connected.', stale: false };
  if (!(error instanceof ApiError)) return { message: 'This could not be sent. Try again.', stale: false };
  if (error.status === 409) return { message: error.message, stale: true };
  if (error.status === 404) return { message: 'This is no longer in the queue.', stale: true };
  return { message: error.fieldErrors[0]?.message ?? error.message, stale: false };
}

/** The claim's payment would find nothing owed: the verifier may keep it as the child's advance. */
export const isNothingDue = (error: unknown): boolean =>
  error instanceof ApiError && error.code === ErrorCode.PAYMENT_NOTHING_DUE;

export const claimTitle = (c: ClaimDto): string => `${c.studentName} · ${formatRupees(c.claimedAmount)}`;
export const claimLine = (c: ClaimDto): string =>
  `${PAYMENT_METHOD_LABELS[c.method]}, paid ${formatDay(c.paidOn)}, from ${c.guardianName}`;
export const methodWord = (method: ClaimDto['method']): string => PAYMENT_METHOD_LABELS[method];

export const handoverTitle = (h: HandoverDto): string => `${h.collector.name} · ${formatRupees(h.expectedAmount)}`;
export const handoverLine = (h: HandoverDto): string =>
  `${h.paymentCount} ${h.paymentCount === 1 ? 'payment' : 'payments'}, handed over ${formatDateTime(h.openedAt)}`;

export const expenseTitle = (e: ExpenseDto): string => `No. ${e.expenseNo} · ${formatRupees(e.amount)}`;
export const expenseLine = (e: ExpenseDto): string => `${e.description} · ${e.recordedByName}, ${formatDay(e.spentOn)}`;

export function leavePeriod(l: Pick<LeaveRequestDto, 'startsOn' | 'endsOn'>): string {
  return l.startsOn === l.endsOn ? formatDay(l.startsOn) : `${formatDay(l.startsOn)} to ${formatDay(l.endsOn)}`;
}
export const leaveTitle = (l: LeaveRequestDto): string => `${l.staffName} · ${l.leaveType.name}`;
export const leaveLine = (l: LeaveRequestDto): string =>
  `${leavePeriod(l)} · ${l.workingDays} working ${l.workingDays === 1 ? 'day' : 'days'}${
    l.sectionsNeedingCover.length > 0 ? ' · needs cover' : ''
  }`;

/** Counted cash: digits only, at most 8 (the server bounds amounts by MAX_RUPEES). */
export const digitsOnly = (raw: string): string => raw.replace(/\D/g, '').slice(0, 8);

/** "Handover confirmed." or the shortfall or surplus the count found. */
export function confirmedMessage(expected: number, counted: number): string {
  if (counted < expected) return `Handover confirmed, ${formatRupees(expected - counted)} short. The principals are told.`;
  if (counted > expected) return `Handover confirmed, ${formatRupees(counted - expected)} over.`;
  return 'Handover confirmed.';
}
