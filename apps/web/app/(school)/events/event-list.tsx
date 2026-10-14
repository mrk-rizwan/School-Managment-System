'use client';

import { Capability, EVENT_STATUSES, EVENT_TYPES, EVENT_TYPE_LABELS, formatRupees, type EventStatus, type EventType } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { DataTable, type DataTableFeatures } from '@/components/data-table';
import { FilterSelect } from '@/components/list-filters';
import { buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { unwrap } from '@/lib/api/client';
import { eventsApi, type EventDto, type EventListQuery, type EventSort } from '@/lib/api/school-events-contract';
import { useListPage } from '@/lib/hooks';
import { useCapabilities } from '@/lib/school-session';
import { EVENT_STATUS_LABELS, EventStatusBadge, eventHref, eventKeys, eventSpan, sectionsLabel } from './_lib/events-ui';

// contracts/slice-38.md §1 and §6: every member of staff reads the published and completed
// events; drafts and New are for holiday.manage holders (the API returns no drafts to others).

const LIMIT = 25;

export function EventList() {
  const { can } = useCapabilities();
  const canManage = can(Capability.HOLIDAY_MANAGE);
  const fromId = useId();
  const toId = useId();
  const [type, setType] = useState<EventType | ''>('');
  const [status, setStatus] = useState<EventStatus | ''>('');
  const [startsFrom, setStartsFrom] = useState('');
  const [startsTo, setStartsTo] = useState('');
  const [sort, setSort] = useState<EventSort>('-startsAt');
  const [page, setPage] = useListPage([type, status, startsFrom, startsTo, sort]);
  const datesInvalid = startsFrom !== '' && startsTo !== '' && startsTo < startsFrom;

  const query: EventListQuery = {
    page,
    limit: LIMIT,
    sort,
    ...(type && { type }),
    ...(status && { status }),
    ...(startsFrom && { startsFrom }),
    ...(startsTo && !datesInvalid && { startsTo }),
  };
  const list = useQuery({
    queryKey: [...eventKeys.list, query],
    queryFn: () => unwrap(eventsApi.GET('/api/v1/events', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, EventDto>();
    return [
      column.accessor('title', {
        header: 'Event',
        cell: (info) => (
          <div className="grid max-w-xs gap-0.5">
            <Link href={eventHref(info.row.original.id)} className="truncate font-medium underline-offset-4 hover:underline">
              {info.getValue()}
            </Link>
            <span className="truncate text-xs text-muted-foreground">{info.row.original.venue}</span>
          </div>
        ),
      }),
      column.accessor('type', { header: 'Type', cell: (info) => EVENT_TYPE_LABELS[info.getValue()] }),
      column.display({ id: 'when', header: 'When', cell: (info) => <span className="tabular-nums">{eventSpan(info.row.original)}</span> }),
      column.display({
        id: 'sections',
        header: 'Sections',
        cell: (info) => <span className="block max-w-48 truncate">{sectionsLabel(info.row.original)}</span>,
      }),
      column.accessor('charge', {
        header: () => <span className="block text-right">Charge</span>,
        cell: (info) => {
          const charge = info.getValue();
          return <span className="block text-right tabular-nums">{charge ? formatRupees(charge.amount) : '—'}</span>;
        },
      }),
      column.accessor('status', { header: 'Status', cell: (info) => <EventStatusBadge status={info.getValue()} /> }),
    ];
  }, []);

  const statuses = canManage ? EVENT_STATUSES : EVENT_STATUSES.filter((s) => s !== 'draft');
  const filtered = Boolean(type || status || startsFrom || startsTo);
  return (
    <>
      <PageHeader
        title="Events"
        description="Parent-teacher meetings, trips, sports days and other school events, with their duties and collections."
        actions={
          canManage && (
            <Link href="/events/new" className={buttonVariants()}>
              <PlusIcon />
              New event
            </Link>
          )
        }
      />
      <section className="grid gap-4" aria-label="Event list">
        <div className="flex flex-wrap items-start gap-3">
          <FilterSelect label="Type" value={type} onChange={setType} className="sm:w-48">
            <option value="">Any</option>
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {EVENT_TYPE_LABELS[t]}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect label="Status" value={status} onChange={setStatus}>
            <option value="">Any</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {EVENT_STATUS_LABELS[s]}
              </option>
            ))}
          </FilterSelect>
          <div className="grid w-full gap-1.5 sm:w-40">
            <Label htmlFor={fromId}>Starting from</Label>
            <Input id={fromId} type="date" value={startsFrom} onChange={(event) => setStartsFrom(event.target.value)} />
          </div>
          <div className="grid w-full gap-1.5 sm:w-40">
            <Label htmlFor={toId}>Starting by</Label>
            <Input
              id={toId}
              type="date"
              value={startsTo}
              min={startsFrom || undefined}
              aria-invalid={datesInvalid ? true : undefined}
              aria-describedby={datesInvalid ? `${toId}-error` : undefined}
              onChange={(event) => setStartsTo(event.target.value)}
            />
            {datesInvalid && (
              <p id={`${toId}-error`} className="text-xs text-destructive">
                Cannot be before the start date.
              </p>
            )}
          </div>
          <FilterSelect<EventSort> label="Order" value={sort} onChange={setSort}>
            <option value="-startsAt">Latest first</option>
            <option value="startsAt">Earliest first</option>
          </FilterSelect>
        </div>
        <DataTable
          columns={columns}
          query={list}
          getRowId={(row) => row.id}
          page={page}
          limit={LIMIT}
          onPageChange={setPage}
          emptyTitle={filtered ? 'No events match' : 'No events yet'}
          emptyDescription={
            filtered
              ? 'Try different filters or dates.'
              : canManage
                ? 'Create a draft, choose its sections, then publish it to invite the families.'
                : 'Published events appear here.'
          }
        />
      </section>
    </>
  );
}
