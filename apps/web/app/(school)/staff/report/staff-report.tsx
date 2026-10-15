'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { DataTable, type DataTableFeatures } from '@/components/data-table';
import { DownloadCsvButton } from '@/components/download-csv-button';
import { SearchField } from '@/components/list-filters';
import { BackLink } from '@/components/page-states';
import { Badge } from '@/components/ui/badge';
import { unwrap } from '@/lib/api/client';
import { staffApi, type StaffReportQuery, type StaffReportRowDto } from '@/lib/api/school-staff-contract';
import { formatDay, todayInSchool } from '@/lib/format';
import { useDebounced, useListPage } from '@/lib/hooks';
import { DateFilter, ReportStates } from '../../reports/_lib/reports-ui';
import { CONTRACT_TYPE_LABELS, ContractStatusBadge } from '../[id]/contracts-tab';
import { staffKeys } from '../_lib/staff-ui';

// The staff report (Phase 5 slice 42, R337; contracts/slice-42.md §2.4): per member, the
// attendance marks and leave taken in the window, and where their contract stands. Default
// window: 1 January of this year to today (at most 366 days).

const LIMIT = 25;

const NUMBERS = [
  ['present', 'Present'],
  ['late', 'Late'],
  ['absent', 'Absent'],
  ['onLeave', 'On leave'],
] as const;

const right = (label: string) => <span className="block text-right">{label}</span>;

export function StaffReport() {
  const today = todayInSchool();
  const [range, setRange] = useState({ from: `${today.slice(0, 4)}-01-01`, to: today });
  const [search, setSearch] = useState('');
  const staffName = useDebounced(search.trim());
  const [page, setPage] = useListPage([range.from, range.to, staffName]);
  const ready = range.from !== '' && range.to !== '';

  const query: StaffReportQuery = { from: range.from, to: range.to, page, limit: LIMIT, ...(staffName && { staffName }) };
  const report = useQuery({
    queryKey: [...staffKeys.all, 'report', query],
    queryFn: () => unwrap(staffApi.GET('/api/v1/staff-reports/summary', { params: { query } })),
    enabled: ready,
    placeholderData: keepPreviousData,
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, StaffReportRowDto>();
    return [
      column.accessor('fullName', {
        header: 'Staff',
        cell: (info) => (
          <span className="grid">
            <Link href={`/staff/${info.row.original.staffId}`} className="font-medium hover:underline">
              {info.getValue()}
            </Link>
            <span className="text-xs text-muted-foreground">{info.row.original.designation ?? 'No designation'}</span>
          </span>
        ),
      }),
      ...NUMBERS.map(([key, label]) =>
        column.accessor(key, {
          header: () => right(label),
          cell: (info) => <span className="block text-right tabular-nums">{info.getValue()}</span>,
        }),
      ),
      column.accessor('attendancePercent', {
        header: () => right('Attendance'),
        cell: (info) => {
          const value = info.getValue();
          return (
            <span className="block text-right tabular-nums">
              {value === null ? <span className="text-muted-foreground">—</span> : `${value.toFixed(1)}%`}
            </span>
          );
        },
      }),
      column.accessor('leaveTakenDays', {
        header: () => right('Leave taken'),
        cell: (info) => <span className="block text-right tabular-nums">{info.getValue()}</span>,
      }),
      column.accessor('contractStatus', {
        header: 'Contract',
        cell: (info) => {
          const r = info.row.original;
          const status = info.getValue();
          return (
            <span className="flex flex-wrap items-center gap-1">
              {status === 'none' ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                <ContractStatusBadge status={status === 'expired_not_ended' ? 'expired' : status} />
              )}
              {r.contractType && <span className="text-xs text-muted-foreground">{CONTRACT_TYPE_LABELS[r.contractType]}</span>}
            </span>
          );
        },
      }),
      column.accessor('contractEndsOn', {
        header: 'Ends on',
        cell: (info) => {
          const value = info.getValue();
          return (
            <span className="flex flex-wrap items-center gap-1 whitespace-nowrap">
              {value ? formatDay(value) : <span className="text-muted-foreground">—</span>}
              {info.row.original.contractEndingSoon && <Badge variant="outline">Ending soon</Badge>}
            </span>
          );
        },
      }),
    ];
  }, []);

  return (
    <>
      <BackLink href="/staff">Staff</BackLink>
      <PageHeader
        title="Staff report"
        description="Attendance, leave taken and contract standing of every member of staff over a window of up to a year."
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <DateFilter label="From" value={range.from} onChange={(from) => setRange((r) => ({ ...r, from }))} />
        <DateFilter label="To" value={range.to} onChange={(to) => setRange((r) => ({ ...r, to }))} />
        <SearchField value={search} onChange={setSearch} placeholder="Staff name" className="sm:w-56" />
        <div className="sm:ml-auto">
          <DownloadCsvButton
            path="/api/v1/staff-reports/summary"
            filters={query}
            disabled={!ready || report.isFetching || !report.data?.data.length}
          />
        </div>
      </div>
      {report.data && (
        <p className="mb-3 text-sm text-muted-foreground">
          {formatDay(report.data.from)} to {formatDay(report.data.to)}
        </p>
      )}
      {!ready ? (
        <p className="text-sm text-destructive">Choose both dates.</p>
      ) : report.error ? (
        <ReportStates query={report}>{() => null}</ReportStates>
      ) : (
        <DataTable
          columns={columns}
          query={report}
          getRowId={(row) => row.staffId}
          page={page}
          limit={LIMIT}
          onPageChange={setPage}
          emptyTitle="No staff"
          emptyDescription={staffName ? 'Nobody on the staff matches this name.' : 'Nobody was on the staff in this window.'}
        />
      )}
    </>
  );
}
