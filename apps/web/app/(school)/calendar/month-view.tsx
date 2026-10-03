'use client';

import { weekdayOf } from '@asms/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { ErrorState, LoadingState, NoPermissionState, StateCard, isPermissionDenied } from '@/components/page-states';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { OPTIONS_LIMIT, unwrap } from '@/lib/api/client';
import { calendarApi, type HolidayDto } from '@/lib/api/school-calendar-contract';
import { todayInSchool } from '@/lib/format';
import { cn } from '@/lib/utils';
import { WEEKDAY_LABELS, WEEKDAY_ORDER } from '../settings/_lib/settings-ui';
import {
  HOLIDAY_STATUS_LABELS,
  addMonths,
  calendarKeys,
  dayOfMonth,
  holidayDates,
  monthGrid,
  monthOf,
  monthRange,
  monthTitle,
} from './_lib/calendar-ui';
import type { HolidayAction } from './holiday-dialogs';

// contracts/slice-10.md §13: weekly-off days greyed, published ranges filled, drafts outlined
// (only holiday.manage holders receive drafts), cancelled hidden unless asked for, and the
// month's teaching days, informational for past months (R116).

export function MonthView({ onAction }: { onAction: (action: HolidayAction) => void }) {
  const today = todayInSchool();
  const toggleId = useId();
  const [month, setMonth] = useState(monthOf(today));
  const [showCancelled, setShowCancelled] = useState(false);
  const { from, to } = monthRange(month);

  const days = useQuery({
    queryKey: [...calendarKeys.teachingDays, from, to],
    queryFn: () =>
      unwrap(calendarApi.GET('/api/v1/calendar/teaching-days', { params: { query: { dateFrom: from, dateTo: to } } })),
  });
  // At most 31 live holidays can touch a month, so one page of 50 holds them (§4.1).
  const query = { dateFrom: from, dateTo: to, limit: OPTIONS_LIMIT, sort: 'startsOn' } as const;
  const holidays = useQuery({
    queryKey: [...calendarKeys.holidays, query],
    queryFn: () => unwrap(calendarApi.GET('/api/v1/holidays', { params: { query } })),
  });

  const error = days.error ?? holidays.error;
  const shown = (holidays.data?.data ?? []).filter((h) => showCancelled || h.status !== 'cancelled');
  const offDays = new Set(days.data?.weeklyOffDays ?? []);

  return (
    <section className="grid gap-4" aria-label="Month view">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon-sm" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>
            <ChevronLeftIcon />
          </Button>
          <h2 className="min-w-36 text-center text-base font-semibold" aria-live="polite">
            {monthTitle(month)}
          </h2>
          <Button variant="outline" size="icon-sm" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}>
            <ChevronRightIcon />
          </Button>
          {month !== monthOf(today) && (
            <Button variant="ghost" size="sm" onClick={() => setMonth(monthOf(today))}>
              This month
            </Button>
          )}
        </div>
        <div className="flex h-8 items-center gap-2">
          <input
            id={toggleId}
            type="checkbox"
            className="size-4 accent-primary"
            checked={showCancelled}
            onChange={(event) => setShowCancelled(event.target.checked)}
          />
          <Label htmlFor={toggleId}>Show cancelled</Label>
        </div>
      </div>

      {error ? (
        <StateCard>
          {isPermissionDenied(error) ? (
            <NoPermissionState description="The school calendar is for staff." />
          ) : (
            <ErrorState
              error={error}
              onRetry={() => {
                void days.refetch();
                void holidays.refetch();
              }}
            />
          )}
        </StateCard>
      ) : !days.data || !holidays.data ? (
        <StateCard>
          <LoadingState rows={6} />
        </StateCard>
      ) : (
        <>
          <p className="text-sm" data-testid="teaching-days">
            <span className="font-medium tabular-nums">{days.data.teachingDays}</span> teaching day
            {days.data.teachingDays === 1 ? '' : 's'} in {monthTitle(month)}
            {to < today && <span className="text-muted-foreground"> (informational for past months)</span>}
          </p>
          <MonthGrid month={month} today={today} offDays={offDays} holidays={shown} onAction={onAction} />
          <Legend />
        </>
      )}
    </section>
  );
}

function MonthGrid({
  month,
  today,
  offDays,
  holidays,
  onAction,
}: {
  month: string;
  today: string;
  offDays: ReadonlySet<number>;
  holidays: HolidayDto[];
  onAction: (action: HolidayAction) => void;
}) {
  const weeks = monthGrid(month);
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="grid grid-cols-7 border-b bg-muted/40 text-xs font-medium text-muted-foreground">
        {WEEKDAY_ORDER.map((day) => (
          <div key={day} className="px-2 py-1.5">
            <span className="sm:hidden">{WEEKDAY_LABELS[day].slice(0, 2)}</span>
            <span className="hidden sm:inline">{WEEKDAY_LABELS[day].slice(0, 3)}</span>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {weeks.flat().map((date) => {
          const inMonth = date.startsWith(month);
          const off = offDays.has(weekdayOf(date));
          const covering = inMonth ? holidays.filter((h) => h.startsOn <= date && date <= h.endsOn) : [];
          return (
            <div
              key={date}
              data-date={date}
              data-off={off || undefined}
              className={cn(
                'min-h-20 min-w-0 border-r border-b p-1 [&:nth-child(7n)]:border-r-0',
                (!inMonth || off) && 'bg-muted/50',
                !inMonth && 'text-muted-foreground/60',
              )}
            >
              <div className="flex items-center justify-between px-0.5">
                <span
                  className={cn(
                    'text-xs tabular-nums',
                    date === today && 'rounded-full bg-primary px-1.5 font-medium text-primary-foreground',
                  )}
                >
                  {dayOfMonth(date)}
                </span>
                {inMonth && off && <span className="sr-only">Weekly day off</span>}
              </div>
              <div className="mt-1 grid gap-0.5">
                {covering.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    title={`${h.name}, ${holidayDates(h)} (${HOLIDAY_STATUS_LABELS[h.status]})`}
                    aria-label={`${h.name}, ${holidayDates(h)}, ${HOLIDAY_STATUS_LABELS[h.status]}`}
                    onClick={() => onAction({ kind: 'detail', holiday: h })}
                    className={cn(
                      'truncate rounded px-1 py-0.5 text-left text-[11px] leading-tight focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                      h.status === 'published' && 'bg-primary/15 text-foreground',
                      h.status === 'draft' && 'border border-dashed border-primary/60 text-foreground',
                      h.status === 'cancelled' && 'text-muted-foreground line-through',
                    )}
                  >
                    {h.name}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground" aria-label="Legend">
      <li className="flex items-center gap-1.5">
        <span className="inline-block size-3 rounded-sm bg-primary/15" /> Published holiday
      </li>
      <li className="flex items-center gap-1.5">
        <span className="inline-block size-3 rounded-sm border border-dashed border-primary/60" /> Draft, not yet
        announced
      </li>
      <li className="flex items-center gap-1.5">
        <span className="inline-block size-3 rounded-sm bg-muted" /> Weekly day off
      </li>
    </ul>
  );
}
