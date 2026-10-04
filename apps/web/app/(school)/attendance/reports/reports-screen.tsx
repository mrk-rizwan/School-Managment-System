'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { useId, useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { DataTable, SortHeader, type DataTableFeatures } from '@/components/data-table';
import { FilterSelect } from '@/components/list-filters';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { unwrap } from '@/lib/api/client';
import {
  attendanceApi,
  type AbsenteeRowDto,
  type AbsenteeSort,
  type AbsenteesQuery,
  type PercentageQuery,
  type PercentageRowDto,
  type PercentageSort,
} from '@/lib/api/school-attendance-contract';
import { todayInSchool } from '@/lib/format';
import { useDebounced, useListPage } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { addDays } from '../../calendar/_lib/calendar-ui';
import { NO_PLACEMENT, PlacementSelects, type Placement } from '../../students/_lib/placement';
import { AttendanceTabs } from '../_lib/attendance-nav';
import { AlertCell, STATUS_LABELS, attendanceKeys } from '../_lib/attendance-ui';
import { DateRangeFields, rangeProblem } from '../_lib/date-range';

// contracts/slice-11.md §10.3, §10.5, §13 "Reports": absentees and late arrivals of a day, with
// what the family was told, and attendance percentages over a range. All need
// attendance.student.view_all (§1.1); a teacher who opens the page sees the no-access state.

type Report = 'absentees' | 'late' | 'percentage';
const REPORTS: { id: Report; label: string }[] = [
  { id: 'absentees', label: 'Absent' },
  { id: 'late', label: 'Late' },
  { id: 'percentage', label: 'Percentage' },
];
const LIMIT = 25;

export function ReportsScreen() {
  const [report, setReport] = useState<Report>('absentees');
  const [placement, setPlacement] = useState<Placement>(NO_PLACEMENT);
  return (
    <>
      <PageHeader title="Attendance" description="Who was absent or late, and who is falling below the attendance they need." />
      <AttendanceTabs />
      <div role="tablist" aria-label="Report" className="mb-4 inline-flex rounded-lg border p-0.5">
        {REPORTS.map((r) => (
          <button
            key={r.id}
            type="button"
            role="tab"
            aria-selected={report === r.id}
            onClick={() => setReport(r.id)}
            className={cn(
              'rounded-md px-3 py-1 text-sm transition-colors',
              report === r.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {r.label}
          </button>
        ))}
      </div>
      {report === 'percentage' ? (
        <PercentageReport placement={placement} onPlacement={setPlacement} />
      ) : (
        <DayReport key={report} kind={report} placement={placement} onPlacement={setPlacement} />
      )}
    </>
  );
}

const place = (r: { className: string | null; sectionName: string | null }) =>
  r.className ? `${r.className} ${r.sectionName ?? ''}`.trim() : '—';

type AbsentFilter = '' | 'absent' | 'partial' | 'on_leave';

function DayReport({
  kind,
  placement,
  onPlacement,
}: {
  kind: 'absentees' | 'late';
  placement: Placement;
  onPlacement: (p: Placement) => void;
}) {
  const today = todayInSchool();
  const dateId = useId();
  const [date, setDate] = useState(today);
  const [status, setStatus] = useState<AbsentFilter>('');
  const [sort, setSort] = useState<AbsenteeSort>('className');
  const [page, setPage] = useListPage([date, status, placement.classId, placement.sectionId, sort]);
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= today;

  const query: AbsenteesQuery = {
    date,
    page,
    limit: LIMIT,
    sort,
    ...(placement.classId && { classId: placement.classId }),
    ...(placement.sectionId && { sectionId: placement.sectionId }),
    ...(kind === 'absentees' && status && { status }),
  };
  const list = useQuery({
    queryKey: [...attendanceKeys.reports, kind, query],
    queryFn: () =>
      unwrap(
        kind === 'late'
          ? attendanceApi.GET('/api/v1/attendance-reports/late', { params: { query } })
          : attendanceApi.GET('/api/v1/attendance-reports/absentees', { params: { query } }),
      ),
    placeholderData: keepPreviousData,
    enabled: validDate,
  });

  const column = createColumnHelper<DataTableFeatures, AbsenteeRowDto>();
  const columns = [
    column.accessor('fullName', {
      header: () => <SortHeader field="fullName" label="Name" sort={sort} onSort={(s) => setSort(s as AbsenteeSort)} />,
      cell: ({ row }) => (
        <Link href={`/students/${row.original.studentId}`} className="font-medium hover:underline">
          {row.original.fullName}
        </Link>
      ),
    }),
    column.accessor('className', {
      header: () => <SortHeader field="className" label="Class" sort={sort} onSort={(s) => setSort(s as AbsenteeSort)} />,
      cell: ({ row }) => place(row.original),
    }),
    column.accessor('rollNo', {
      header: () => <SortHeader field="rollNo" label="Roll" sort={sort} onSort={(s) => setSort(s as AbsenteeSort)} />,
      cell: ({ getValue }) => getValue() ?? '—',
    }),
    column.accessor('status', { header: 'Day', cell: ({ getValue }) => STATUS_LABELS[getValue()] }),
    ...(kind === 'late'
      ? [column.accessor('arrivedAt', { header: 'Arrived', cell: ({ getValue }) => getValue() ?? '—' })]
      : []),
    column.accessor('alert', { header: 'Family told', cell: ({ getValue }) => <AlertCell alert={getValue()} /> }),
  ];

  return (
    <section className="grid gap-4" aria-label={kind === 'late' ? 'Late' : 'Absent'}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid w-full gap-1.5 sm:w-44">
          <Label htmlFor={dateId}>Date</Label>
          <Input id={dateId} type="date" max={today} value={date} onChange={(event) => setDate(event.target.value)} />
        </div>
        <PlacementSelects value={placement} onChange={onPlacement} anyLabel="Any" includeClosedYears compact />
        {kind === 'absentees' && (
          <FilterSelect<AbsentFilter> label="Day" value={status} onChange={setStatus}>
            <option value="">Any</option>
            <option value="absent">Absent</option>
            <option value="partial">Part of the day</option>
            <option value="on_leave">On leave</option>
          </FilterSelect>
        )}
      </div>
      {!validDate ? (
        <p className="text-sm text-destructive">Choose a date that is not in the future.</p>
      ) : (
        <DataTable
          columns={columns}
          query={list}
          page={page}
          limit={LIMIT}
          onPageChange={setPage}
          getRowId={(row) => row.enrolmentId}
          emptyTitle={kind === 'late' ? 'Nobody was late' : 'Nobody was absent'}
          emptyDescription="These figures can trail the registers by a minute."
        />
      )}
    </section>
  );
}

function PercentageReport({ placement, onPlacement }: { placement: Placement; onPlacement: (p: Placement) => void }) {
  const today = todayInSchool();
  const belowId = useId();
  const [range, setRange] = useState({ dateFrom: addDays(today, -29), dateTo: today });
  const [belowRaw, setBelowRaw] = useState('75');
  const below = useDebounced(belowRaw);
  const [sort, setSort] = useState<PercentageSort>('percentage');
  const [page, setPage] = useListPage([range.dateFrom, range.dateTo, below, placement.classId, placement.sectionId, sort]);
  const problem = rangeProblem(range, 365);
  const belowNumber = below.trim() === '' ? undefined : Number(below);
  const belowValid = belowNumber === undefined || (Number.isInteger(belowNumber) && belowNumber >= 0 && belowNumber <= 100);

  const query: PercentageQuery = {
    ...range,
    page,
    limit: LIMIT,
    sort,
    ...(placement.classId && { classId: placement.classId }),
    ...(placement.sectionId && { sectionId: placement.sectionId }),
    ...(belowValid && belowNumber !== undefined && { below: belowNumber }),
  };
  const list = useQuery({
    queryKey: [...attendanceKeys.reports, 'percentage', query],
    queryFn: () => unwrap(attendanceApi.GET('/api/v1/attendance-reports/percentage', { params: { query } })),
    placeholderData: keepPreviousData,
    enabled: problem === null && belowValid,
  });

  const column = createColumnHelper<DataTableFeatures, PercentageRowDto>();
  const columns = [
    column.accessor('fullName', {
      header: () => <SortHeader field="fullName" label="Name" sort={sort} onSort={(s) => setSort(s as PercentageSort)} />,
      cell: ({ row }) => (
        <Link href={`/students/${row.original.studentId}`} className="font-medium hover:underline">
          {row.original.fullName}
        </Link>
      ),
    }),
    column.accessor('className', {
      header: () => <SortHeader field="className" label="Class" sort={sort} onSort={(s) => setSort(s as PercentageSort)} />,
      cell: ({ row }) => place(row.original),
    }),
    column.accessor('percentage', {
      header: () => <SortHeader field="percentage" label="Attendance" sort={sort} onSort={(s) => setSort(s as PercentageSort)} />,
      cell: ({ getValue }) => {
        const value = getValue();
        return value === null ? <span className="text-muted-foreground">No recorded days</span> : `${value.toFixed(1)}%`;
      },
    }),
    column.display({
      id: 'days',
      header: 'Days',
      cell: ({ row }) => `${row.original.countedDays} recorded of ${row.original.teachingDays}`,
    }),
  ];

  return (
    <section className="grid gap-4" aria-label="Percentage">
      <div className="flex flex-wrap items-end gap-3">
        <DateRangeFields value={range} onChange={setRange} />
        <PlacementSelects value={placement} onChange={onPlacement} anyLabel="Any" includeClosedYears compact />
        <div className="grid w-full gap-1.5 sm:w-32">
          <Label htmlFor={belowId}>Below (%)</Label>
          <Input
            id={belowId}
            inputMode="numeric"
            value={belowRaw}
            maxLength={3}
            aria-invalid={belowValid ? undefined : true}
            onChange={(event) => setBelowRaw(event.target.value.replace(/\D/g, ''))}
          />
        </div>
      </div>
      {problem || !belowValid ? (
        <p className="text-sm text-destructive">{problem ?? 'Enter a whole number from 0 to 100, or leave it blank.'}</p>
      ) : (
        <DataTable
          columns={columns}
          query={list}
          page={page}
          limit={LIMIT}
          onPageChange={setPage}
          getRowId={(row) => row.studentId}
          emptyTitle={belowNumber === undefined ? 'No students' : `Nobody is below ${belowNumber}%`}
          emptyDescription="Only students with a recorded day in the range have a percentage."
        />
      )}
    </section>
  );
}
