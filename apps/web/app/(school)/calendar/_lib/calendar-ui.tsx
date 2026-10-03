'use client';

import { ErrorCode, type HolidayKind, type HolidayStatus } from '@asms/shared';
import { Badge } from '@/components/ui/badge';
import { ApiError, describeApiError } from '@/lib/api/errors';
import type { HolidayDto } from '@/lib/api/school-calendar-contract';
import { formatDay } from '@/lib/format';

// Pieces shared by the calendar month view, the holiday list and the holiday dialogs
// (contracts/slice-10.md §4, §13).

export const calendarKeys = {
  all: ['school', 'calendar'] as const,
  holidays: ['school', 'calendar', 'holidays'] as const,
  holiday: (id: string) => ['school', 'calendar', 'holidays', 'detail', id] as const,
  teachingDays: ['school', 'calendar', 'teaching-days'] as const,
};

export const HOLIDAY_STATUS_LABELS: Record<HolidayStatus, string> = {
  draft: 'Draft',
  published: 'Published',
  cancelled: 'Cancelled',
};
const STATUS_VARIANT = {
  draft: 'outline',
  published: 'secondary',
  cancelled: 'ghost',
} as const satisfies Record<HolidayStatus, string>;

export function HolidayStatusBadge({ status }: { status: HolidayStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{HOLIDAY_STATUS_LABELS[status]}</Badge>;
}

export const HOLIDAY_KIND_LABELS: Record<HolidayKind, string> = {
  public: 'Public holiday',
  school: 'School holiday',
};

/** "6 Oct 2026", or "6 Oct 2026 – 10 Oct 2026" for a range. */
export function holidayDates(h: Pick<HolidayDto, 'startsOn' | 'endsOn'>): string {
  return h.startsOn === h.endsOn ? formatDay(h.startsOn) : `${formatDay(h.startsOn)} – ${formatDay(h.endsOn)}`;
}

/** One sentence for a refusal on the holiday routes (contract §10); anything else is `describeApiError`. */
export function holidayErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.fieldErrors.length === 0) {
    switch (error.code) {
      case ErrorCode.HOLIDAY_NOT_DRAFT:
        return 'This holiday is published, so its dates, name and kind cannot change. Cancel it and create a new one instead.';
      case ErrorCode.ILLEGAL_STATUS_TRANSITION:
        return 'This holiday is cancelled. A cancelled holiday cannot be published again.';
      case ErrorCode.CONCURRENT_UPDATE:
        return 'Someone else changed this holiday at the same moment. Close this and try again.';
    }
  }
  return describeApiError(error);
}

// ---- Calendar dates. YYYY-MM-DD strings are calendar days: all arithmetic is in UTC. ----

const DAY_MS = 86_400_000;
const toMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
const toDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (date: string, days: number) => toDate(toMs(date) + days * DAY_MS);

/** `YYYY-MM` of a date. */
export const monthOf = (date: string) => date.slice(0, 7);

export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

/** First and last day of a `YYYY-MM` month. */
export function monthRange(month: string): { from: string; to: string } {
  const from = `${month}-01`;
  return { from, to: addDays(`${addMonths(month, 1)}-01`, -1) };
}

const monthTitleFormat = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
export const monthTitle = (month: string) => monthTitleFormat.format(new Date(`${month}-01T00:00:00Z`));

/** The weeks shown for a month, Monday first, padded with the neighbouring months' days. */
export function monthGrid(month: string): string[][] {
  const { from, to } = monthRange(month);
  const offset = (new Date(toMs(from)).getUTCDay() + 6) % 7; // Monday = 0
  let day = addDays(from, -offset);
  const weeks: string[][] = [];
  while (day <= to) {
    const week: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      week.push(day);
      day = addDays(day, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

export const dayOfMonth = (date: string) => Number(date.slice(8, 10));
