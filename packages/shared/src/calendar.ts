/** Calendar values (phase-2-daily-operations.md §5, slice 10), for the API and the clients. */

export const HOLIDAY_KINDS = ['public', 'school'] as const;
export type HolidayKind = (typeof HOLIDAY_KINDS)[number];

/** draft -> published -> cancelled, or draft -> cancelled. A published holiday's dates are frozen. */
export const HOLIDAY_STATUSES = ['draft', 'published', 'cancelled'] as const;
export type HolidayStatus = (typeof HOLIDAY_STATUSES)[number];

/** `school_settings.weekly_off_days`: 0 = Sunday ... 6 = Saturday, as Date.getUTCDay(). */
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * The calendar a teaching-day question is asked against (contracts/slice-10.md §3): the school's
 * weekly-off days and its PUBLISHED holidays. Drafts and cancelled holidays are left out by the
 * caller; a holiday's `kind` does not matter.
 */
export interface SchoolCalendar {
  readonly weeklyOffDays: readonly number[];
  readonly holidays: readonly {
    readonly startsOn: string;
    readonly endsOn: string;
    readonly appliesToStaff: boolean;
  }[];
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Milliseconds of a `YYYY-MM-DD` date at UTC midnight; throws on anything else. */
function dateMs(date: string): number {
  const ms = CALENDAR_DATE.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date) {
    throw new RangeError(`not a calendar date: ${date}`);
  }
  return ms;
}

/** 0 = Sunday ... 6 = Saturday: the date's UTC weekday (dates carry no time zone). */
export function weekdayOf(date: string): Weekday {
  return new Date(dateMs(date)).getUTCDay() as Weekday;
}

// Holiday bounds are compared as strings: YYYY-MM-DD orders lexically.
const inHoliday = (date: string, holiday: { startsOn: string; endsOn: string }) =>
  holiday.startsOn <= date && date <= holiday.endsOn;

/** R116: not a weekly-off day and inside no published holiday. */
export function isTeachingDay(date: string, calendar: SchoolCalendar): boolean {
  return (
    !calendar.weeklyOffDays.includes(weekdayOf(date)) &&
    !calendar.holidays.some((holiday) => inHoliday(date, holiday))
  );
}

/** R136 (slice 12): as isTeachingDay, but only holidays that apply to staff close the day. */
export function isStaffWorkingDay(date: string, calendar: SchoolCalendar): boolean {
  return (
    !calendar.weeklyOffDays.includes(weekdayOf(date)) &&
    !calendar.holidays.some((holiday) => holiday.appliesToStaff && inHoliday(date, holiday))
  );
}

/**
 * The teaching days from `dateFrom` to `dateTo`, both inclusive; 0 when `dateTo` is earlier. A
 * holiday on a weekly-off day is not counted twice: each date is tested once.
 */
export function teachingDays(dateFrom: string, dateTo: string, calendar: SchoolCalendar): number {
  let count = 0;
  for (let ms = dateMs(dateFrom), end = dateMs(dateTo); ms <= end; ms += DAY_MS) {
    if (isTeachingDay(new Date(ms).toISOString().slice(0, 10), calendar)) count += 1;
  }
  return count;
}
