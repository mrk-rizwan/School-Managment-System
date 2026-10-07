// Calendar-day helpers. Days are YYYY-MM-DD strings computed in UTC, so no zone moves them.

import { monthLabel } from '@asms/shared';

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ms = (date: string) => Date.parse(`${date}T00:00:00Z`);

/**
 * A well-formed YYYY-MM-DD that names a real day. Parsing alone is not enough: an engine may roll
 * 2026-02-30 over to 2 March, so the parsed day must format back to the same text.
 */
export const isIsoDate = (text: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = ms(text);
  return !Number.isNaN(parsed) && iso(parsed) === text;
};

export const addDays = (date: string, days: number) => iso(ms(date) + days * DAY_MS);

/** The day of the week, 0 = Sunday. */
export const weekday = (date: string) => new Date(ms(date)).getUTCDay();

/** The Monday on or before `date`. */
function mondayOf(date: string): string {
  return addDays(date, -((weekday(date) + 6) % 7));
}

/** Week `back` weeks before this one: Monday to Sunday, the current week ending today. */
export function weekWindow(today: string, back: number): { dateFrom: string; dateTo: string } {
  const monday = addDays(mondayOf(today), -7 * back);
  return { dateFrom: monday, dateTo: back === 0 ? today : addDays(monday, 6) };
}

/** The `back`-th 14-day window ending today (a parent's or student's diary). */
export function fortnightWindow(today: string, back: number): { dateFrom: string; dateTo: string } {
  const dateTo = addDays(today, -14 * back);
  return { dateFrom: addDays(dateTo, -13), dateTo };
}

/** The first of the month of `date`, to `date`: "this month so far". */
export const monthToDate = (date: string) => ({ dateFrom: `${date.slice(0, 8)}01`, dateTo: date });

/** The last `days` days counted back from `today`, newest first, today included. */
export const lastDays = (today: string, days = 30): string[] =>
  Array.from({ length: days + 1 }, (_, back) => addDays(today, -back));

/** The month `offset` months from the school's current month: its first and last day. */
export function monthRange(
  today: string,
  offset: number,
): { dateFrom: string; dateTo: string; title: string } {
  const [year, month] = today.split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(year, month - 1 + offset, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  return {
    dateFrom: iso(first.getTime()),
    dateTo: iso(last.getTime()),
    title: monthLabel(iso(first.getTime()).slice(0, 7)),
  };
}

/** An attendance month at `offset`: this month runs to today (the children cards' key). */
export function attendanceMonth(today: string, offset: number) {
  const month = monthRange(today, offset);
  return offset === 0 ? { ...month, dateTo: today } : month;
}
