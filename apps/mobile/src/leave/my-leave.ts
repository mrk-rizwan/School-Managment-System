import { addDaysTo, ApiError, ErrorCode, formatDay } from '@asms/shared';
import { api, isNetworkError, unwrap } from '../api/client';
import type { LeaveBalanceDto, LeaveRequestDto, LeaveTypeDto } from '../api/contracts';
import { sensitiveTextError } from '../outbox/bodies';

// My leave (phase-3-financial.md slice 24, §3.9, R226): a staff member's balances and requests.
// Every leave action is online-only — reads and writes go straight to the server, never the
// outbox or the SQLite cache; offline the screen says it needs a connection.

type Page<T> = { data: T[]; page: number; limit: number; total: number };

export const LEAVE_LIMIT = 25;
/** A request may start at most this many days back and cover at most this many days (server rules). */
export const BACKDATE_DAYS = 7;
export const MAX_DAYS = 60;
/** How far ahead the date list reaches. */
export const AHEAD_DAYS = 120;

export const leaveKeys = {
  balance: ['me', 'staff', 'leave-balance'] as const,
  requests: (page: number) => ['me', 'staff', 'leave-requests', page] as const,
  types: ['leave-types', 'active'] as const,
  all: ['me', 'staff'] as const,
};

export const fetchBalance = (): Promise<LeaveBalanceDto> =>
  unwrap(api.GET('/api/v1/me/staff/leave-balance', { params: { query: {} } }));

export const fetchRequests = (page: number): Promise<Page<LeaveRequestDto>> =>
  unwrap(
    api.GET('/api/v1/me/staff/leave-requests', { params: { query: { page, limit: LEAVE_LIMIT } } }),
  );

export const fetchTypes = (): Promise<Page<LeaveTypeDto>> =>
  unwrap(api.GET('/api/v1/leave-types', { params: { query: { status: 'active', limit: 50 } } }));

/** "Casual leave: 7 of 10 left" (or "no limit", with days taken). */
export function balanceLine(row: LeaveBalanceDto['types'][number]): string {
  if (row.balance === null || row.entitlement === null) {
    return `${row.used} ${row.used === 1 ? 'day' : 'days'} taken, no limit`;
  }
  const pending = row.pending > 0 ? `, ${row.pending} pending` : '';
  return `${row.balance} of ${row.entitlement} left${pending}`;
}

const STATUS_WORDS: Record<LeaveRequestDto['status'], string> = {
  pending: 'Waiting for a decision',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  ended_early: 'Ended early',
};

export const statusWord = (status: LeaveRequestDto['status']): string => STATUS_WORDS[status];

/** "Mon 12 Oct to Wed 14 Oct · 3 working days". */
export function requestLine(row: LeaveRequestDto): string {
  const last = row.endedEarlyOn ?? row.endsOn;
  const when = row.startsOn === last ? formatDay(row.startsOn) : `${formatDay(row.startsOn)} to ${formatDay(last)}`;
  return `${when} · ${row.workingDays} working ${row.workingDays === 1 ? 'day' : 'days'}`;
}

/** Cancellable by its owner: pending, or approved and not yet started (the server's rule). */
export const canCancel = (row: LeaveRequestDto, today: string): boolean =>
  row.status === 'pending' || (row.status === 'approved' && row.startsOn > today);

/** The days a request may start or end on: from 7 days back to 120 ahead. */
export function pickableDays(today: string): string[] {
  const days: string[] = [];
  for (let offset = -BACKDATE_DAYS; offset <= AHEAD_DAYS; offset++) days.push(addDaysTo(today, offset));
  return days;
}

export type LeaveForm = { leaveTypeId: string | null; startsOn: string; endsOn: string; reason: string };

/** The form's problems by field, mirroring the server's 422s; empty when it may be sent. */
export function formProblems(form: LeaveForm, today: string): Record<string, string> {
  const problems: Record<string, string> = {};
  if (form.leaveTypeId === null) problems.leaveTypeId = 'Choose a type of leave.';
  if (form.startsOn < addDaysTo(today, -BACKDATE_DAYS)) {
    problems.startsOn = `Leave can start at most ${BACKDATE_DAYS} days ago.`;
  }
  if (form.endsOn < form.startsOn) problems.endsOn = 'The last day must be on or after the first.';
  else if (form.endsOn > addDaysTo(form.startsOn, MAX_DAYS - 1)) {
    problems.endsOn = `A request covers at most ${MAX_DAYS} days.`;
  }
  const reason = form.reason.trim();
  if (reason.length < 3) problems.reason = 'Give a reason of at least 3 characters.';
  else if (reason.length > 500) problems.reason = 'At most 500 characters.';
  else if (sensitiveTextError(reason)) problems.reason = sensitiveTextError(reason)!;
  return problems;
}

/** What to tell the user when a leave write fails. */
export function leaveFailure(error: unknown): string {
  if (isNetworkError(error)) return 'No connection. Leave needs a connection; nothing was sent.';
  if (!(error instanceof ApiError)) return 'This could not be sent. Try again.';
  switch (error.code) {
    case ErrorCode.LEAVE_OVERLAPS:
      return 'You already have leave on some of these days.';
    case ErrorCode.LEAVE_BALANCE_EXCEEDED: {
      const balance = (error.details as { balance?: unknown } | null)?.balance;
      return typeof balance === 'number'
        ? `Not enough leave left: ${Math.max(0, balance)} working ${balance === 1 ? 'day' : 'days'}.`
        : 'Not enough leave left.';
    }
    case ErrorCode.LEAVE_TYPE_ARCHIVED:
      return 'That type of leave is no longer offered.';
    case ErrorCode.LEAVE_STARTED:
      return 'This leave has started. Ask the principal to end it early.';
    default:
      return error.fieldErrors[0]?.message ?? error.message;
  }
}
