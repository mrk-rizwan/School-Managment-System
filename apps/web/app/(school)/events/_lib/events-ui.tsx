'use client';

import { ErrorCode, formatRupees, type DutyKind, type EventStatus, type ParticipationStatus } from '@asms/shared';
import { Badge } from '@/components/ui/badge';
import { refusalMessage, type RefusalMessages } from '@/lib/api/errors';
import type { EventDto } from '@/lib/api/school-events-contract';
import { formatDateTime, formatTime } from '@/lib/format';
import { instantToLocal } from '../../announcements/_lib/announcements-ui';

// Shared by the event screens (contracts/slice-38.md §6): query keys, labels, the status badge,
// the event's time span and the refusals in words the user can act on.

export const eventKeys = {
  all: ['school', 'events'] as const,
  list: ['school', 'events', 'list'] as const,
  detail: (id: string) => ['school', 'events', 'detail', id] as const,
  roster: (id: string) => ['school', 'events', 'roster', id] as const,
  payments: (id: string) => ['school', 'events', 'payments', id] as const,
  payable: (id: string) => ['school', 'events', 'payable', id] as const,
  report: (id: string) => ['school', 'events', 'report', id] as const,
};

export const eventHref = (id: string) => `/events/${encodeURIComponent(id)}`;

export const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
  draft: 'Draft',
  published: 'Published',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const STATUS_VARIANT = {
  draft: 'outline',
  published: 'default',
  completed: 'secondary',
  cancelled: 'ghost',
} as const satisfies Record<EventStatus, string>;

export function EventStatusBadge({ status }: { status: EventStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{EVENT_STATUS_LABELS[status]}</Badge>;
}

export const DUTY_LABELS: Record<DutyKind, string> = {
  registration: 'Registration',
  supervision: 'Supervision',
  collection: 'Fee collection',
  transport: 'Transport',
  other: 'Other',
};

export const PARTICIPATION_LABELS: Record<ParticipationStatus, string> = {
  attended: 'Attended',
  absent: 'Absent',
  excused: 'Excused',
};

/** The campaign behind an event's charge, in words (draft, generating, generated, cancelled). */
export const CAMPAIGN_STATUS_LABELS: Record<string, string> = {
  draft: 'Charges not raised yet',
  generating: 'Charges being raised',
  generated: 'Charges raised',
  cancelled: 'Charges cancelled',
};

/** "14 Nov 2026, 09:00 – 12:00", or both date-times when the event runs over more than a day. */
export function eventSpan(e: Pick<EventDto, 'startsAt' | 'endsAt'>): string {
  const sameDay = instantToLocal(e.startsAt).slice(0, 10) === instantToLocal(e.endsAt).slice(0, 10);
  return sameDay ? `${formatDateTime(e.startsAt)} – ${formatTime(e.endsAt)}` : `${formatDateTime(e.startsAt)} – ${formatDateTime(e.endsAt)}`;
}

/** "Class 5 A, Class 5 B", or "No sections yet". */
export const sectionsLabel = (e: Pick<EventDto, 'sections'>) =>
  e.sections.length === 0 ? 'No sections yet' : e.sections.map((s) => `${s.className} ${s.sectionName}`).join(', ');

const EVENT_REFUSALS: RefusalMessages = {
  [ErrorCode.EVENT_NOT_DRAFT]: 'This event is no longer a draft, so it cannot change. Reload to see it.',
  [ErrorCode.EVENT_NOT_PUBLISHED]: 'This event is not published, or it is already completed.',
  [ErrorCode.EVENT_NO_SECTIONS]: 'Choose at least one section before publishing. Edit the draft first.',
  [ErrorCode.EVENT_DUTY_EXISTS]: 'This member of staff already has that duty on this event.',
  [ErrorCode.EVENT_NO_CHARGE]: 'This event has no charge, so there is nothing to collect.',
  [ErrorCode.EVENT_PAYMENT_EXCEEDS_CHARGE]: (d) =>
    typeof d.outstanding === 'number'
      ? `That is more than the child owes for this event (${formatRupees(d.outstanding)}).`
      : 'That is more than the child owes for this event.',
  [ErrorCode.CHARGE_RUN_IN_PROGRESS]: 'Fee charges are being raised for this year right now. Try again in a minute.',
  [ErrorCode.ACADEMIC_YEAR_CLOSED]: 'The academic year is closed.',
  [ErrorCode.ILLEGAL_STATUS_TRANSITION]: 'This event’s status does not allow that any more. Reload to see it.',
  [`${ErrorCode.SELF_ACTION_FORBIDDEN}:own_child`]: 'You cannot take a payment for your own child. Ask another member of staff.',
  [ErrorCode.SELF_ACTION_FORBIDDEN]: 'You cannot do this for yourself. Ask another member of staff.',
  [`${ErrorCode.PERMISSION_DENIED}:principal_required`]:
    'Some families have already paid for this event. Only the principal can cancel it, which credits what they paid.',
  [ErrorCode.EXPENSE_EVENT_TAGGED]: 'This expense is already tagged to another event.',
  [ErrorCode.IDEMPOTENCY_KEY_REUSED]: 'This form was already used. Save again to send it as a new one.',
  [ErrorCode.NOT_FOUND]: 'This event no longer exists, or it is not yours to change.',
};

/** One sentence for an event refusal (§2); anything else is `describeApiError`. */
export const eventErrorMessage = (error: unknown) => refusalMessage(error, EVENT_REFUSALS);
