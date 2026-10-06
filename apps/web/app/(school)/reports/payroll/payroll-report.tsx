'use client';

import { formatRupees, yearMonthOf } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import { reportsApi, type PayrollMonthDto, type PayrollReportQuery } from '@/lib/api/school-reports-contract';
import { todayInSchool } from '@/lib/format';
import { formatMonth } from '../../fees/_lib/fees-ui';
import { DateFilter, ReportStates, reportsKeys } from '../_lib/reports-ui';

/** The twelve months to this one, as `YYYY-MM` bounds. */
const lastTwelveMonths = () => {
  const to = yearMonthOf(todayInSchool());
  const [year, month] = to.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1 - 11, 1));
  return { from: start.toISOString().slice(0, 7), to };
};

const COLUMNS: readonly { key: 'gross' | 'deductions' | 'adjustments' | 'net' | 'paid' | 'unpaid'; label: string }[] = [
  { key: 'gross', label: 'Gross' },
  { key: 'deductions', label: 'Deductions' },
  { key: 'adjustments', label: 'Adjustments' },
  { key: 'net', label: 'Net' },
  { key: 'paid', label: 'Paid' },
  { key: 'unpaid', label: 'Unpaid' },
];

/** Payroll (slice 22): each month's salary totals over at most 24 months. */
export function PayrollReport() {
  const [range, setRange] = useState(lastTwelveMonths);
  const query: PayrollReportQuery = { from: range.from, to: range.to };
  const report = useQuery({
    queryKey: reportsKeys.report('payroll', query),
    queryFn: () => unwrap(reportsApi.GET('/api/v1/finance-reports/payroll', { params: { query } })),
    enabled: range.from !== '' && range.to !== '',
    placeholderData: keepPreviousData,
  });

  const amounts = (row: PayrollMonthDto) =>
    COLUMNS.map(({ key }) => (
      <TableCell key={key} className="px-4 text-right tabular-nums">
        {formatRupees(row[key])}
      </TableCell>
    ));

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <DateFilter type="month" label="From" value={range.from} onChange={(from) => setRange((r) => ({ ...r, from }))} />
        <DateFilter type="month" label="To" value={range.to} onChange={(to) => setRange((r) => ({ ...r, to }))} />
      </div>
      <ReportStates query={report}>
        {(data) => (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="px-4 text-muted-foreground">Month</TableHead>
                  <TableHead className="px-4 text-right text-muted-foreground">Staff</TableHead>
                  {COLUMNS.map(({ key, label }) => (
                    <TableHead key={key} className="px-4 text-right text-muted-foreground">
                      {label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={COLUMNS.length + 2} className="px-4 py-8 text-center text-muted-foreground">
                      No payroll in these months.
                    </TableCell>
                  </TableRow>
                ) : (
                  data.rows.map((row) => (
                    <TableRow key={row.yearMonth}>
                      <TableCell className="px-4">{formatMonth(row.yearMonth)}</TableCell>
                      <TableCell className="px-4 text-right tabular-nums">{row.staffCount}</TableCell>
                      {amounts(row)}
                    </TableRow>
                  ))
                )}
              </TableBody>
              <TableFooter>
                <TableRow className="hover:bg-transparent">
                  <TableCell className="px-4 font-medium" colSpan={2}>
                    Total
                  </TableCell>
                  {amounts(data.total)}
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        )}
      </ReportStates>
    </>
  );
}
