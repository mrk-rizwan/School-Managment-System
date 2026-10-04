'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { DataTable, SortHeader, type DataTableFeatures } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { unwrap } from '@/lib/api/client';
import {
  attendanceApi,
  type DailySummaryDto,
  type DailySummaryQuery,
  type DailySummarySort,
} from '@/lib/api/school-attendance-contract';
import { formatDay, todayInSchool } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { addDays } from '../../calendar/_lib/calendar-ui';
import { NO_PLACEMENT, PlacementSelects, type Placement } from '../../students/_lib/placement';
import { AttendanceTabs, registerHref } from '../_lib/attendance-nav';
import { attendanceKeys } from '../_lib/attendance-ui';
import { DateRangeFields, rangeProblem } from '../_lib/date-range';

// contracts/slice-11.md §10.2, §13 "Section summary": per section-day counts from the summary
// table, which trails the registers by up to a minute; a stale row says "updating…".

const LIMIT = 25;

export function SummaryScreen() {
  const today = todayInSchool();
  const [range, setRange] = useState({ dateFrom: addDays(today, -6), dateTo: today });
  const [placement, setPlacement] = useState<Placement>(NO_PLACEMENT);
  const [sort, setSort] = useState<DailySummarySort>('-date');
  const [page, setPage] = useListPage([range.dateFrom, range.dateTo, placement.classId, placement.sectionId, sort]);
  const problem = rangeProblem(range, 91);

  const query: DailySummaryQuery = {
    ...range,
    page,
    limit: LIMIT,
    sort,
    ...(placement.classId && { classId: placement.classId }),
    ...(placement.sectionId && { sectionId: placement.sectionId }),
  };
  const list = useQuery({
    queryKey: [...attendanceKeys.summary, query],
    queryFn: () => unwrap(attendanceApi.GET('/api/v1/attendance-reports/daily-summary', { params: { query } })),
    placeholderData: keepPreviousData,
    enabled: problem === null,
  });

  const column = createColumnHelper<DataTableFeatures, DailySummaryDto>();
  const columns = [
    column.accessor('date', {
      header: () => <SortHeader field="date" label="Date" sort={sort} onSort={(s) => setSort(s as DailySummarySort)} />,
      cell: ({ getValue }) => formatDay(getValue()),
    }),
    column.accessor('className', {
      header: () => <SortHeader field="className" label="Class" sort={sort} onSort={(s) => setSort(s as DailySummarySort)} />,
      cell: ({ row }) => (
        <Link className="font-medium hover:underline" href={registerHref(row.original.sectionId, row.original.date)}>
          {row.original.className} {row.original.sectionName}
        </Link>
      ),
    }),
    column.accessor('present', { header: 'Present' }),
    column.accessor('absent', { header: 'Absent' }),
    column.accessor('late', { header: 'Late' }),
    column.accessor('onLeave', { header: 'On leave' }),
    column.accessor('partial', { header: 'Part day' }),
    column.accessor('unrecorded', { header: 'Not recorded' }),
    column.display({
      id: 'state',
      header: 'Registers',
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="flex flex-wrap gap-1.5">
            <span className="tabular-nums">
              {r.registersRecorded}
              {r.registersExpected > 0 && ` of ${r.registersExpected}`}
            </span>
            {r.stale && <Badge variant="outline">updating…</Badge>}
            {!r.teachingDay && <Badge variant="ghost">Not a teaching day</Badge>}
          </div>
        );
      },
    }),
  ];

  return (
    <>
      <PageHeader title="Attendance" description="Each section’s day, counted. Figures can trail the registers by a minute." />
      <AttendanceTabs />
      <section className="grid gap-4" aria-label="Daily summary">
        <div className="flex flex-wrap items-end gap-3">
          <DateRangeFields value={range} onChange={setRange} max={today} />
          <PlacementSelects value={placement} onChange={setPlacement} anyLabel="Any" includeClosedYears compact />
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
            getRowId={(row) => `${row.sectionId}|${row.date}`}
            emptyTitle="Nothing counted for these days"
            emptyDescription="A section appears once its register has been taken."
          />
        )}
      </section>
    </>
  );
}
