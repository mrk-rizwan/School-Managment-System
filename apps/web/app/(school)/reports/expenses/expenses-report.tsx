'use client';

import { formatRupees } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FilterSelect } from '@/components/list-filters';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import { reportsApi, type ExpenseGroup, type ExpensesReportQuery } from '@/lib/api/school-reports-contract';
import { DateFilter, ReportRowsTable, ReportStates, last30Days, plural, reportsKeys } from '../_lib/reports-ui';

const GROUP_LABELS: Record<ExpenseGroup, string> = { category: 'Category', day: 'Day', method: 'Method', recorder: 'Recorded by' };

/**
 * Expenses (slice 22): what was spent in a range of at most 92 days, grouped; the expenses still
 * waiting for the principal; and each recorder's expenses under the approval threshold, so a run
 * of small ones is visible.
 */
export function ExpensesReport() {
  const [range, setRange] = useState(last30Days);
  const [groupBy, setGroupBy] = useState<ExpenseGroup>('category');
  const query: ExpensesReportQuery = { spentFrom: range.from, spentTo: range.to, groupBy };
  const report = useQuery({
    queryKey: reportsKeys.report('expenses', query),
    queryFn: () => unwrap(reportsApi.GET('/api/v1/finance-reports/expenses', { params: { query } })),
    enabled: range.from !== '' && range.to !== '',
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <DateFilter label="From" value={range.from} onChange={(from) => setRange((r) => ({ ...r, from }))} />
        <DateFilter label="To" value={range.to} onChange={(to) => setRange((r) => ({ ...r, to }))} />
        <FilterSelect<ExpenseGroup> label="Group by" value={groupBy} onChange={setGroupBy}>
          {Object.entries(GROUP_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </FilterSelect>
      </div>
      <ReportStates query={report}>
        {(data) => (
          <div className="grid gap-6">
            <ReportRowsTable rows={data.rows} keyLabel={GROUP_LABELS[groupBy]} total={data.total} emptyText="No expenses in this range." />
            <p className="text-sm text-muted-foreground">
              Waiting for approval (not in the total): {formatRupees(data.pendingApproval.amount)} ({plural(data.pendingApproval.count, 'expense')}).
            </p>
            <section className="grid gap-2">
              <h2 className="text-sm font-medium">At or below the approval threshold, by recorder</h2>
              <div className="overflow-x-auto rounded-lg border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="px-4 text-muted-foreground">Recorded by</TableHead>
                      <TableHead className="px-4 text-right text-muted-foreground">Count</TableHead>
                      <TableHead className="px-4 text-right text-muted-foreground">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.subThresholdByRecorder.length === 0 ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={3} className="px-4 py-6 text-center text-muted-foreground">
                          None in this range.
                        </TableCell>
                      </TableRow>
                    ) : (
                      data.subThresholdByRecorder.map((row) => (
                        <TableRow key={row.recorderUserId}>
                          <TableCell className="px-4">{row.recorder}</TableCell>
                          <TableCell className="px-4 text-right tabular-nums">{row.count}</TableCell>
                          <TableCell className="px-4 text-right tabular-nums">{formatRupees(row.amount)}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </section>
          </div>
        )}
      </ReportStates>
    </>
  );
}
