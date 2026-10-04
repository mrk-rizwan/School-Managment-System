'use client';

import type { DayStatus } from '@asms/shared';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { todayInSchool } from '@/lib/format';
import { cn } from '@/lib/utils';
import { addMonths, dayOfMonth, monthGrid, monthOf, monthRange, monthTitle } from '../../calendar/_lib/calendar-ui';
import { WEEKDAY_LABELS, WEEKDAY_ORDER } from '../../settings/_lib/settings-ui';
import { STATUS_FILL, STATUS_LABELS, STATUS_LETTER } from './attendance-ui';

// The month heat map of one person's attendance: the student attendance tab (contracts/slice-11.md
// §13), the staff attendance tab and "My attendance" (slice-12.md §8). One cell per day, coloured
// and lettered by status, so colour is never the only signal.

/** One day of the map. `counts` is false on a day off or outside enrolment/employment. */
export type HeatMapDay = { date: string; status: DayStatus | null; counts: boolean; detail?: string };

export { monthOf, monthRange };

/** Previous / next month with the month's name between them. */
export function MonthNav({ month, onChange }: { month: string; onChange: (month: string) => void }) {
  const thisMonth = monthOf(todayInSchool());
  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="icon-sm" aria-label="Previous month" onClick={() => onChange(addMonths(month, -1))}>
        <ChevronLeftIcon />
      </Button>
      <h2 className="min-w-36 text-center text-base font-semibold" aria-live="polite">
        {monthTitle(month)}
      </h2>
      <Button variant="outline" size="icon-sm" aria-label="Next month" onClick={() => onChange(addMonths(month, 1))}>
        <ChevronRightIcon />
      </Button>
      {month !== thisMonth && (
        <Button variant="ghost" size="sm" onClick={() => onChange(thisMonth)}>
          This month
        </Button>
      )}
    </div>
  );
}

export function MonthHeatMap({
  month,
  days,
  label,
  countedLabel = 'teaching day',
}: {
  month: string;
  days: HeatMapDay[];
  /** The map's accessible name, e.g. "Attendance in October 2026". */
  label: string;
  /** What an uncoloured, counted day is called in the legend. */
  countedLabel?: string;
}) {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const today = todayInSchool();
  return (
    <div className="grid gap-3">
      <div className="overflow-hidden rounded-lg border bg-card" role="grid" aria-label={label}>
        <div role="row" className="grid grid-cols-7 border-b bg-muted/40 text-xs font-medium text-muted-foreground">
          {WEEKDAY_ORDER.map((day) => (
            <div key={day} role="columnheader" className="px-2 py-1.5">
              {WEEKDAY_LABELS[day].slice(0, 3)}
            </div>
          ))}
        </div>
        {monthGrid(month).map((week) => (
          <div key={week[0]} role="row" className="grid grid-cols-7">
            {week.map((date) => {
              const inMonth = date.startsWith(month);
              const day = inMonth ? byDate.get(date) : undefined;
              const status = day?.status ?? null;
              const words = !inMonth
                ? ''
                : status
                  ? STATUS_LABELS[status]
                  : day?.counts
                    ? date > today
                      ? 'Not yet'
                      : 'Not recorded'
                    : 'Not counted';
              return (
                <div
                  key={date}
                  role="gridcell"
                  data-date={date}
                  data-status={inMonth ? (status ?? (day?.counts ? 'unrecorded' : 'off')) : undefined}
                  aria-label={inMonth ? `${dayOfMonth(date)}: ${words}${day?.detail ? `, ${day.detail}` : ''}` : undefined}
                  title={inMonth && day?.detail ? day.detail : undefined}
                  className={cn(
                    'flex h-12 min-w-0 flex-col justify-between border-r border-b p-1 text-xs [&:nth-child(7n)]:border-r-0',
                    !inMonth && 'bg-muted/30 text-muted-foreground/50',
                    inMonth && !day?.counts && !status && 'bg-muted/60 text-muted-foreground',
                  )}
                >
                  <span className={cn('tabular-nums', date === today && 'font-semibold underline underline-offset-2')}>
                    {dayOfMonth(date)}
                  </span>
                  {inMonth && status && (
                    <span
                      aria-hidden="true"
                      className={cn(
                        'self-end rounded px-1 text-[11px] leading-4 font-semibold',
                        STATUS_FILL[status],
                        !day?.counts && 'opacity-60',
                      )}
                    >
                      {STATUS_LETTER[status]}
                    </span>
                  )}
                  {inMonth && !status && day?.counts && date <= today && (
                    <span aria-hidden="true" className="self-end text-[11px] text-muted-foreground">
                      –
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground" aria-label="Legend">
        {(['present', 'late', 'absent', 'on_leave', 'partial'] as const).map((s) => (
          <li key={s} className="flex items-center gap-1.5">
            <span className={cn('inline-flex h-4 min-w-4 items-center justify-center rounded px-0.5 text-[10px] font-semibold', STATUS_FILL[s])}>
              {STATUS_LETTER[s]}
            </span>
            {STATUS_LABELS[s]}
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span className="inline-block size-4 rounded border text-center leading-3">–</span> Not recorded {countedLabel}
        </li>
        <li className="flex items-center gap-1.5">
          <span className="inline-block size-4 rounded bg-muted" /> Not counted
        </li>
      </ul>
    </div>
  );
}
