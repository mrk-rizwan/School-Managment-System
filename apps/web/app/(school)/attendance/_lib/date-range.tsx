'use client';

import { useId } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { addDays } from '../../calendar/_lib/calendar-ui';

// The From / To pair of the attendance reports. The API bounds each report's span
// (contracts/slice-11.md §10.2: 92 days; §10.4, §10.5: 366 days); the check here only saves a
// round trip.

export type DateRange = { dateFrom: string; dateTo: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Why the range cannot be asked for, or null. `maxSpan` is the largest `dateTo − dateFrom` in days. */
export function rangeProblem({ dateFrom, dateTo }: DateRange, maxSpan: number): string | null {
  if (!DATE.test(dateFrom) || !DATE.test(dateTo)) return 'Choose both dates.';
  if (dateTo < dateFrom) return 'The end date cannot be before the start date.';
  if (dateTo > addDays(dateFrom, maxSpan)) return `Choose at most ${maxSpan + 1} days.`;
  return null;
}

export function DateRangeFields({
  value,
  onChange,
  max,
}: {
  value: DateRange;
  onChange: (value: DateRange) => void;
  /** The latest date either field offers (today, for reports of what happened). */
  max?: string;
}) {
  const fromId = useId();
  const toId = useId();
  return (
    <>
      <div className="grid w-full gap-1.5 sm:w-40">
        <Label htmlFor={fromId}>From</Label>
        <Input
          id={fromId}
          type="date"
          max={max}
          value={value.dateFrom}
          onChange={(event) => onChange({ ...value, dateFrom: event.target.value })}
        />
      </div>
      <div className="grid w-full gap-1.5 sm:w-40">
        <Label htmlFor={toId}>To</Label>
        <Input
          id={toId}
          type="date"
          max={max}
          value={value.dateTo}
          onChange={(event) => onChange({ ...value, dateTo: event.target.value })}
        />
      </div>
    </>
  );
}
