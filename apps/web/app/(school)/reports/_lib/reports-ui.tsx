'use client';

import { addDaysTo, formatRupees } from '@asms/shared';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useId } from 'react';
import { QueryStates } from '@/components/page-states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiError, describeApiError } from '@/lib/api/errors';
import type { ReportRowDto } from '@/lib/api/school-reports-contract';
import { todayInSchool } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useYears } from '../../academics/_lib/options';

// Pieces shared by the finance reports (phase-3-financial.md slice 22). Every report is read with
// finance.report.view; the API checks each request.

export const reportsKeys = {
  all: ['school', 'reports'] as const,
  report: (name: string, query: object) => ['school', 'reports', name, query] as const,
};

const TABS = [
  { href: '/reports/defaulters', label: 'Defaulters' },
  { href: '/reports/collections', label: 'Collections' },
  { href: '/reports/outstanding', label: 'Outstanding' },
  { href: '/reports/daily-cash', label: 'Daily cash' },
  { href: '/reports/concessions', label: 'Concessions' },
  { href: '/reports/expenses', label: 'Expenses' },
  { href: '/reports/payroll', label: 'Payroll' },
] as const;

export function ReportsTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Finance reports" className="mb-6 flex flex-wrap gap-1 border-b">
      {TABS.map(({ href, label }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
              active
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/** The last 30 days, school time, today included. */
export const last30Days = () => {
  const today = todayInSchool();
  return { from: addDaysTo(today, -29), to: today };
};

/** A labelled date (or month) input in the filter row. */
export function DateFilter({
  label,
  value,
  onChange,
  type = 'date',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'date' | 'month';
}) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} className="w-44" />
    </div>
  );
}

/** The year picker of a year report. `value` is the effective year (see `useDefaultYearId`). */
export function YearFilter({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const id = useId();
  const years = useYears();
  return (
    <div className="grid w-full gap-1.5 sm:w-44">
      <Label htmlFor={id}>Academic year</Label>
      <NativeSelect id={id} value={value} disabled={years.isPending} onChange={(e) => onChange(e.target.value)}>
        {(years.data?.data ?? []).map((y) => (
          <option key={y.id} value={y.id}>
            {y.name}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

/** The chosen year, else the active one, else the newest; '' while the years load. */
export function useDefaultYearId(chosen: string): string {
  const list = useYears().data?.data ?? [];
  if (chosen) return chosen;
  return (list.find((y) => y.status === 'active') ?? list[0])?.id ?? '';
}

type ReportQuery<T> = { data: T | undefined; isPending: boolean; error: unknown; refetch: () => unknown };

/**
 * A report's states: a refused filter (422, a range too long, say) is the API's sentence over
 * the filters, not a failure to retry; everything else is QueryStates.
 */
export function ReportStates<T>({ query, children }: { query: ReportQuery<T>; children: (data: T) => React.ReactNode }) {
  if (query.error instanceof ApiError && query.error.status === 422) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{describeApiError(query.error)}</AlertDescription>
      </Alert>
    );
  }
  return <QueryStates query={query}>{children}</QueryStates>;
}

/** The grouped rows of a report with their total; `keyLabel` heads the first column. */
export function ReportRowsTable({
  rows,
  keyLabel,
  total,
  count,
  emptyText = 'Nothing in this range.',
}: {
  rows: readonly ReportRowDto[];
  keyLabel: string;
  total: number;
  count?: number;
  emptyText?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="px-4 text-muted-foreground">{keyLabel}</TableHead>
            <TableHead className="px-4 text-right text-muted-foreground">Count</TableHead>
            <TableHead className="px-4 text-right text-muted-foreground">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={3} className="px-4 py-8 text-center text-muted-foreground">
                {emptyText}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.key}>
                <TableCell className="px-4">{row.label}</TableCell>
                <TableCell className="px-4 text-right tabular-nums">{row.count}</TableCell>
                <TableCell className="px-4 text-right tabular-nums">{formatRupees(row.amount)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
        <TableFooter>
          <TableRow className="hover:bg-transparent">
            <TableCell className="px-4 font-medium">Total</TableCell>
            <TableCell className="px-4 text-right tabular-nums">
              {count ?? rows.reduce((sum, row) => sum + row.count, 0)}
            </TableCell>
            <TableCell className="px-4 text-right font-medium tabular-nums">{formatRupees(total)}</TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}

/** Labelled amounts under a report: one line each, the emphasised one in bold. */
export function SummaryLines({
  lines,
}: {
  lines: readonly { label: string; amount: number; note?: string; strong?: boolean }[];
}) {
  return (
    <dl className="divide-y rounded-lg border bg-card text-sm">
      {lines.map((line) => (
        <div key={line.label} className="flex items-baseline justify-between gap-4 px-4 py-2.5">
          <dt className={cn(line.strong ? 'font-medium' : 'text-muted-foreground')}>
            {line.label}
            {line.note && <span className="ml-2 text-xs text-muted-foreground">{line.note}</span>}
          </dt>
          <dd className={cn('tabular-nums', line.strong && 'font-semibold')}>{formatRupees(line.amount)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** `n item(s)`. */
export const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
