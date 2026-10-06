'use client';

import { ErrorCode, formatDay } from '@asms/shared';
import { Badge } from '@/components/ui/badge';
import type { RefusalMessages } from '@/lib/api/errors';
import type { LeaveCode, LeaveRequestDto, LeaveStatus } from '@/lib/api/school-leave-contract';

// Pieces shared by the leave screens (phase-3-financial.md slice 24): My leave and the approvers'
// page.

export const leaveKeys = {
  all: ['school', 'leave'] as const,
  types: ['school', 'leave', 'types'] as const,
  requests: ['school', 'leave', 'requests'] as const,
  mine: ['school', 'leave', 'mine'] as const,
};

export const LEAVE_STATUS_LABELS: Record<LeaveStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  ended_early: 'Ended early',
};

export const LEAVE_CODE_LABELS: Record<LeaveCode, string> = {
  casual: 'Casual',
  sick: 'Sick',
  unpaid: 'Unpaid',
  other: 'Other',
};

export function LeaveStatusBadge({ status }: { status: LeaveStatus }) {
  const variant = status === 'pending' ? 'outline' : status === 'rejected' ? 'destructive' : status === 'approved' ? 'secondary' : 'ghost';
  return <Badge variant={variant}>{LEAVE_STATUS_LABELS[status]}</Badge>;
}

/** "Mon 12 Oct – Wed 14 Oct" (to the day it ended, when ended early). */
export function leavePeriod(row: Pick<LeaveRequestDto, 'startsOn' | 'endsOn' | 'endedEarlyOn'>): string {
  const last = row.endedEarlyOn ?? row.endsOn;
  return row.startsOn === last ? formatDay(row.startsOn) : `${formatDay(row.startsOn)} – ${formatDay(last)}`;
}

export const workingDaysLabel = (n: number) => `${n} working ${n === 1 ? 'day' : 'days'}`;

/** The leave refusals in words the user can act on. */
export const LEAVE_REFUSALS: RefusalMessages = {
  [ErrorCode.LEAVE_OVERLAPS]: 'This overlaps leave already requested for those days.',
  [ErrorCode.LEAVE_BALANCE_EXCEEDED]: (details) =>
    typeof details.balance === 'number'
      ? `Not enough leave left: ${Math.max(0, details.balance)} working ${details.balance === 1 ? 'day' : 'days'}.`
      : 'Not enough leave left.',
  [ErrorCode.LEAVE_TYPE_ARCHIVED]: 'That type of leave is no longer offered.',
  [ErrorCode.LEAVE_NOT_PENDING]: 'This request has already been decided.',
  [ErrorCode.LEAVE_STARTED]: 'This leave has started. Ask an approver to end it early.',
  [ErrorCode.LEAVE_TYPE_NAME_TAKEN]: 'A leave type of that name already exists.',
  [ErrorCode.SELF_ACTION_FORBIDDEN]: 'Nobody decides their own leave. Ask a colleague.',
  [`${ErrorCode.PERMISSION_DENIED}:cover_needs_class_manage`]:
    'Assigning a cover needs permission to manage classes. Approve without a cover, or ask someone who can.',
  [ErrorCode.CAPABILITY_NOT_HELD]: 'That person cannot mark registers, so cannot cover a class.',
};
