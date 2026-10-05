// Calendar arithmetic on `YYYY-MM-DD` and `YYYY-MM` strings for the money helpers. A calendar day
// is not an instant: everything here is UTC so no zone moves a date.

const DAY_MS = 86_400_000;

export const YEAR_MONTH_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

const toTime = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);
const fromTime = (time: number): string => new Date(time).toISOString().slice(0, 10);

/** `day` moved by whole days. */
export const addDaysTo = (day: string, days: number): string => fromTime(toTime(day) + days * DAY_MS);

/** The `YYYY-MM` a day falls in. */
export const yearMonthOf = (day: string): string => day.slice(0, 7);

/** `YYYY-MM-DD` of `day` (1-31) in the `YYYY-MM` period, zero-padded. */
export const dayOfPeriod = (period: string, day: number): string =>
  `${period}-${String(day).padStart(2, '0')}`;
