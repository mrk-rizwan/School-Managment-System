// Calendar-day helpers. Days are YYYY-MM-DD strings computed in UTC, so no zone moves them.

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** The month `offset` months from the school's current month: its first and last day. */
export function monthRange(
  today: string,
  offset: number,
): { dateFrom: string; dateTo: string; title: string } {
  const [year, month] = today.split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(year, month - 1 + offset, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    dateFrom: iso(first),
    dateTo: iso(last),
    title: `${MONTH_NAMES[first.getUTCMonth()]} ${first.getUTCFullYear()}`,
  };
}
