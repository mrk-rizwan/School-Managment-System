// Date windows for the diary lists (slice-16 §3.1), YYYY-MM-DD in UTC arithmetic so no zone
// moves a day.

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ms = (date: string) => Date.parse(`${date}T00:00:00Z`);

export const addDays = (date: string, days: number) => iso(ms(date) + days * DAY_MS);

/** The Monday on or before `date`. */
export function mondayOf(date: string): string {
  const weekday = new Date(ms(date)).getUTCDay(); // 0 = Sunday
  return addDays(date, -((weekday + 6) % 7));
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
