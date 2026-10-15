'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { DataTable, type DataTableFeatures } from '@/components/data-table';
import { DownloadCsvButton } from '@/components/download-csv-button';
import { FilterSelect } from '@/components/list-filters';
import { unwrap } from '@/lib/api/client';
import {
  attendanceApi,
  type DiscrepanciesQuery,
  type DiscrepancyDto,
  type DiscrepancyKind,
} from '@/lib/api/school-attendance-contract';
import { formatDay, todayInSchool } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { addDays } from '../../calendar/_lib/calendar-ui';
import { attendanceKeys } from '../_lib/attendance-ui';
import { DateRangeFields, rangeProblem } from '../_lib/date-range';

// Attendance discrepancies (Phase 5 slice 42, R335; contracts/slice-42.md §2.5): a pupil present
// in one period and absent in another of the same day with no late arrival recorded, and a
// register whose marks were amended more than once. At most 92 days; newest day first.

const LIMIT = 25;
/** `to − from` at most 91 days: 92 days counted inclusively. */
const MAX_SPAN = 91;

const KIND_LABELS: Record<DiscrepancyKind, string> = {
  mixed_day: 'Present and absent on one day',
  amended_register: 'Register amended more than once',
};

const periods = (list: readonly number[]) => (list.length === 0 ? '—' : list.join(', '));

export function DiscrepanciesReport() {
  const today = todayInSchool();
  const [range, setRange] = useState({ dateFrom: addDays(today, -29), dateTo: today });
  const [kind, setKind] = useState<DiscrepancyKind | ''>('');
  const [page, setPage] = useListPage([range.dateFrom, range.dateTo, kind]);
  const problem = rangeProblem(range, MAX_SPAN);

  const query: DiscrepanciesQuery = { from: range.dateFrom, to: range.dateTo, page, limit: LIMIT, ...(kind && { kind }) };
  const list = useQuery({
    queryKey: [...attendanceKeys.reports, 'discrepancies', query],
    queryFn: () => unwrap(attendanceApi.GET('/api/v1/attendance-reports/discrepancies', { params: { query } })),
    placeholderData: keepPreviousData,
    enabled: problem === null,
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, DiscrepancyDto>();
    return [
      column.accessor('date', { header: 'Date', cell: (info) => <span className="whitespace-nowrap">{formatDay(info.getValue())}</span> }),
      column.accessor('kind', { header: 'Kind', cell: (info) => KIND_LABELS[info.getValue()] }),
      column.display({
        id: 'place',
        header: 'Class',
        cell: ({ row }) => `${row.original.className} ${row.original.sectionName}`,
      }),
      column.accessor('studentName', {
        header: 'Student',
        cell: (info) => {
          const r = info.row.original;
          return r.studentId && r.studentName ? (
            <Link href={`/students/${r.studentId}`} className="font-medium hover:underline">
              {r.studentName}
            </Link>
          ) : (
            <span className="text-muted-foreground">—</span>
          );
        },
      }),
      column.accessor('period', { header: 'Period', cell: (info) => info.getValue() ?? '—' }),
      column.accessor('presentPeriods', { header: 'Present periods', cell: (info) => periods(info.getValue()) }),
      column.accessor('absentPeriods', { header: 'Absent periods', cell: (info) => periods(info.getValue()) }),
      column.accessor('amendments', {
        header: 'Amendments',
        cell: (info) => <span className="tabular-nums">{info.getValue() ?? '—'}</span>,
      }),
    ];
  }, []);

  return (
    <section className="grid gap-4" aria-label="Discrepancies">
      <div className="flex flex-wrap items-end gap-3">
        <DateRangeFields value={range} onChange={setRange} max={today} />
        <FilterSelect<DiscrepancyKind | ''> label="Kind" value={kind} onChange={setKind} className="sm:w-64">
          <option value="">All</option>
          <option value="mixed_day">{KIND_LABELS.mixed_day}</option>
          <option value="amended_register">{KIND_LABELS.amended_register}</option>
        </FilterSelect>
        <div className="sm:ml-auto">
          <DownloadCsvButton
            path="/api/v1/attendance-reports/discrepancies"
            filters={query}
            disabled={problem !== null || list.isFetching || !list.data?.data.length}
          />
        </div>
      </div>
      {problem ? (
        <p className="text-sm text-destructive">{problem}</p>
      ) : (
        <DataTable
          columns={columns}
          query={list}
          page={page}
          limit={LIMIT}
          onPageChange={setPage}
          getRowId={(row) => `${row.kind}-${row.date}-${row.sectionId}-${row.studentId ?? ''}-${row.period ?? ''}`}
          emptyTitle="No discrepancies"
          emptyDescription="No pupil was marked both present and absent on a day, and no register was amended more than once."
        />
      )}
    </section>
  );
}
