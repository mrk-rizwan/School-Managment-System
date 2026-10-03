'use client';

import { Capability, HOLIDAY_KINDS, HOLIDAY_STATUSES, type HolidayKind, type HolidayStatus } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { useId, useMemo, useState } from 'react';
import { DataTable, RowActions, SortHeader, type DataTableFeatures, type RowAction } from '@/components/data-table';
import { FilterSelect } from '@/components/list-filters';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { unwrap } from '@/lib/api/client';
import {
  calendarApi,
  type HolidayDto,
  type HolidayListQuery,
  type HolidaySort,
} from '@/lib/api/school-calendar-contract';
import { useListPage } from '@/lib/hooks';
import { useCapabilities } from '@/lib/school-session';
import {
  HOLIDAY_KIND_LABELS,
  HOLIDAY_STATUS_LABELS,
  HolidayStatusBadge,
  calendarKeys,
  holidayDates,
} from './_lib/calendar-ui';
import type { HolidayAction } from './holiday-dialogs';

// contracts/slice-10.md §4.1 and §13: filters status, kind and dates. Drafts are filtered out by
// the API for anyone without holiday.manage, so the Draft filter is offered to managers only.

const LIMIT = 25;

export function HolidayList({ onAction }: { onAction: (action: HolidayAction) => void }) {
  const { can } = useCapabilities();
  const canManage = can(Capability.HOLIDAY_MANAGE);
  const fromId = useId();
  const toId = useId();
  const [status, setStatus] = useState<HolidayStatus | ''>('');
  const [kind, setKind] = useState<HolidayKind | ''>('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sort, setSort] = useState<HolidaySort>('-startsOn');
  const [page, setPage] = useListPage([status, kind, dateFrom, dateTo, sort]);
  const datesInvalid = dateFrom !== '' && dateTo !== '' && dateTo < dateFrom;

  const query: HolidayListQuery = {
    page,
    limit: LIMIT,
    sort,
    ...(status && { status }),
    ...(kind && { kind }),
    ...(dateFrom && { dateFrom }),
    ...(dateTo && !datesInvalid && { dateTo }),
  };
  const holidays = useQuery({
    queryKey: [...calendarKeys.holidays, query],
    queryFn: () => unwrap(calendarApi.GET('/api/v1/holidays', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, HolidayDto>();
    return [
      column.display({
        id: 'dates',
        header: () => <SortHeader field="startsOn" label="Dates" sort={sort} onSort={setSort} />,
        cell: (info) => <span className="tabular-nums">{holidayDates(info.row.original)}</span>,
      }),
      column.accessor('name', {
        header: 'Name',
        cell: (info) => (
          <button
            type="button"
            className="text-left font-medium underline-offset-4 hover:underline"
            onClick={() => onAction({ kind: 'detail', holiday: info.row.original })}
          >
            {info.getValue()}
          </button>
        ),
      }),
      column.accessor('kind', { header: 'Kind', cell: (info) => HOLIDAY_KIND_LABELS[info.getValue()] }),
      column.accessor('appliesToStaff', {
        header: 'Staff',
        cell: (info) => (info.getValue() ? 'Off' : 'Working'),
      }),
      column.accessor('status', { header: 'Status', cell: (info) => <HolidayStatusBadge status={info.getValue()} /> }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => {
          const holiday = info.row.original;
          if (!canManage || holiday.status === 'cancelled') return null;
          const actions: RowAction[] = [
            { label: 'Edit', onSelect: () => onAction({ kind: 'edit', holiday }) },
            ...(holiday.status === 'draft'
              ? [{ label: 'Publish', onSelect: () => onAction({ kind: 'publish', holiday }) }]
              : []),
            { label: 'Cancel holiday', destructive: true, onSelect: () => onAction({ kind: 'cancel', holiday }) },
          ];
          return <RowActions label={holiday.name} actions={actions} />;
        },
      }),
    ];
  }, [sort, canManage, onAction]);

  const filtered = Boolean(status || kind || dateFrom || dateTo);
  const statuses = HOLIDAY_STATUSES.filter((s) => canManage || s !== 'draft');

  return (
    <section className="grid gap-4" aria-label="Holiday list">
      <div className="flex flex-wrap items-start gap-3">
        <FilterSelect label="Status" value={status} onChange={setStatus}>
          <option value="">Any</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {HOLIDAY_STATUS_LABELS[s]}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label="Kind" value={kind} onChange={setKind} className="sm:w-44">
          <option value="">Any</option>
          {HOLIDAY_KINDS.map((k) => (
            <option key={k} value={k}>
              {HOLIDAY_KIND_LABELS[k]}
            </option>
          ))}
        </FilterSelect>
        <div className="grid w-full gap-1.5 sm:w-40">
          <Label htmlFor={fromId}>From</Label>
          <Input id={fromId} type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
        </div>
        <div className="grid w-full gap-1.5 sm:w-40">
          <Label htmlFor={toId}>To</Label>
          <Input
            id={toId}
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            aria-invalid={datesInvalid ? true : undefined}
            aria-describedby={datesInvalid ? `${toId}-error` : undefined}
            onChange={(event) => setDateTo(event.target.value)}
          />
          {datesInvalid && (
            <p id={`${toId}-error`} className="text-xs text-destructive">
              Cannot be before From.
            </p>
          )}
        </div>
      </div>
      <DataTable
        columns={columns}
        query={holidays}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle={filtered ? 'No holidays match' : 'No holidays yet'}
        emptyDescription={
          filtered
            ? 'Try different filters or dates.'
            : canManage
              ? 'Add the year’s public holidays and vacations. They are drafts until you publish them.'
              : 'Holidays appear here once the school publishes them.'
        }
      />
    </section>
  );
}
