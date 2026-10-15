'use client';

import { formatRupees } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { DownloadCsvButton } from '@/components/download-csv-button';
import { FilterSelect } from '@/components/list-filters';
import { EmptyState, StateCard } from '@/components/page-states';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import {
  reportsApi,
  type FinancialStatementDto,
  type FinancialStatementQuery,
  type StatementBasis,
  type StatementFiguresDto,
} from '@/lib/api/school-reports-contract';
import { formatDay, todayInSchool } from '@/lib/format';
import { cn } from '@/lib/utils';
import { formatMonth } from '../../fees/_lib/fees-ui';
import { DateFilter, ReportStates, YearFilter, reportsKeys, useDefaultYearId, useTerms } from '../_lib/reports-ui';

// The financial statement (Phase 5 slice 42, R332; contracts/slice-42.md §2.1): income against
// expenditure, one row per month of the window and the total. One window at a time: a range of
// dates, a term, or an academic year (the default: the current year). The basis is the school's
// setting unless one is chosen; the response says which was used.

type Window = 'year' | 'term' | 'range';

const BASIS_LABELS: Record<StatementBasis, string> = { received: 'Received', verified: 'Verified' };

type Figure = Exclude<keyof StatementFiguresDto, 'period' | 'from' | 'to'>;

const COLUMNS: readonly { key: Figure; label: string; muted?: boolean; strong?: boolean }[] = [
  { key: 'receipts', label: 'Receipts' },
  { key: 'refundReversals', label: 'Refund reversals' },
  { key: 'refunds', label: 'Refunds' },
  { key: 'netReceipts', label: 'Net receipts', strong: true },
  { key: 'expenses', label: 'Expenses' },
  { key: 'shortfallWriteOffs', label: 'Shortfall write-offs' },
  { key: 'salaries', label: 'Salaries' },
  { key: 'advancesPaid', label: 'Advances paid' },
  { key: 'advanceRecoveries', label: 'Advance recoveries', muted: true },
  { key: 'staff', label: 'Staff' },
  { key: 'expenditure', label: 'Expenditure', strong: true },
  { key: 'net', label: 'Net', strong: true },
];

export function FinancialStatementReport() {
  const [windowKind, setWindowKind] = useState<Window>('year');
  const [chosenYear, setChosenYear] = useState('');
  const academicYearId = useDefaultYearId(chosenYear);
  const terms = useTerms(windowKind === 'term' ? academicYearId : '');
  const [termId, setTermId] = useState('');
  const today = todayInSchool();
  const [range, setRange] = useState({ from: `${today.slice(0, 4)}-01-01`, to: today });
  const [basis, setBasis] = useState<StatementBasis | ''>('');

  const windowQuery: FinancialStatementQuery =
    windowKind === 'range'
      ? { from: range.from, to: range.to }
      : windowKind === 'term'
        ? { termId }
        : { academicYearId };
  const query: FinancialStatementQuery = { ...windowQuery, ...(basis && { basis }) };
  const ready =
    windowKind === 'range' ? range.from !== '' && range.to !== '' : windowKind === 'term' ? termId !== '' : academicYearId !== '';

  const report = useQuery({
    queryKey: reportsKeys.report('financial-statement', query),
    queryFn: () => unwrap(reportsApi.GET('/api/v1/finance-reports/financial-statement', { params: { query } })),
    enabled: ready,
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <FilterSelect<Window> label="Window" value={windowKind} onChange={setWindowKind}>
          <option value="year">Academic year</option>
          <option value="term">Term</option>
          <option value="range">Dates</option>
        </FilterSelect>
        {windowKind !== 'range' && <YearFilter value={academicYearId} onChange={(id) => { setChosenYear(id); setTermId(''); }} />}
        {windowKind === 'term' && (
          <FilterSelect label="Term" value={termId} onChange={setTermId} disabled={terms.isPending}>
            <option value="">Choose a term</option>
            {(terms.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </FilterSelect>
        )}
        {windowKind === 'range' && (
          <>
            <DateFilter label="From" value={range.from} onChange={(from) => setRange((r) => ({ ...r, from }))} />
            <DateFilter label="To" value={range.to} onChange={(to) => setRange((r) => ({ ...r, to }))} />
          </>
        )}
        <FilterSelect<StatementBasis | ''> label="Basis" value={basis} onChange={setBasis}>
          <option value="">School default</option>
          <option value="received">Received</option>
          <option value="verified">Verified</option>
        </FilterSelect>
        <div className="sm:ml-auto">
          <DownloadCsvButton
            path="/api/v1/finance-reports/financial-statement"
            filters={query}
            disabled={!ready || report.isFetching || !report.data?.months.length}
          />
        </div>
      </div>
      {windowKind === 'term' && termId === '' ? (
        <StateCard>
          <EmptyState title="Choose a term" description="The statement covers the term's dates." />
        </StateCard>
      ) : windowKind === 'range' && !ready ? (
        <p className="text-sm text-destructive">Choose both dates.</p>
      ) : (
        <ReportStates query={report}>{(data) => <Statement data={data} chosenBasis={basis} />}</ReportStates>
      )}
    </>
  );
}

function Statement({ data, chosenBasis }: { data: FinancialStatementDto; chosenBasis: StatementBasis | '' }) {
  const cells = (row: StatementFiguresDto) =>
    COLUMNS.map(({ key, muted, strong }) => {
      const value = row[key];
      return (
        <TableCell
          key={key}
          className={cn(
            'px-4 text-right tabular-nums',
            muted && 'text-muted-foreground',
            strong && 'font-medium',
            key === 'net' && value < 0 && 'text-destructive',
          )}
        >
          {formatRupees(value)}
        </TableCell>
      );
    });

  return (
    <div className="grid gap-3" data-testid="financial-statement">
      <p className="text-sm text-muted-foreground">
        {formatDay(data.from)} to {formatDay(data.to)} · Basis:{' '}
        <span className="font-medium text-foreground" data-testid="statement-basis">
          {BASIS_LABELS[data.basis]}
        </span>
        {chosenBasis === '' && ' (school default)'}
      </p>
      {data.months.length === 0 ? (
        <StateCard>
          <EmptyState title="Nothing in this window" />
        </StateCard>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="px-4 text-muted-foreground">Month</TableHead>
                {COLUMNS.map(({ key, label, muted }) => (
                  <TableHead key={key} className={cn('px-4 text-right text-muted-foreground', muted && 'font-normal')}>
                    {label}
                    {muted && <span className="block text-xs font-normal">already inside salaries</span>}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.months.map((row) => (
                <TableRow key={row.period}>
                  <TableCell className="px-4 whitespace-nowrap">{formatMonth(row.period)}</TableCell>
                  {cells(row)}
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow className="hover:bg-transparent">
                <TableCell className="px-4 font-medium">Total</TableCell>
                {cells(data.total)}
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Net receipts are receipts and refund reversals less refunds. Expenditure is expenses, shortfall write-offs,
        salaries and advances paid (salaries and advances together are the staff column); advance recoveries are already inside salaries and are not subtracted again.
      </p>
    </div>
  );
}
