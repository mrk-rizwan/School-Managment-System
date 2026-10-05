'use client';

import {
  ANNOUNCEMENT_CATEGORIES,
  ANNOUNCEMENT_CATEGORY_LABELS,
  ANNOUNCEMENT_PRIORITIES,
  ANNOUNCEMENT_STATUSES,
  ANNOUNCEMENT_STATUS_LABELS,
  type AnnouncementCategory,
  type AnnouncementPriority,
  type AnnouncementStatus,
} from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { DataTable, SortHeader, type DataTableFeatures } from '@/components/data-table';
import { FilterSelect } from '@/components/list-filters';
import { NoPermissionState, StateCard } from '@/components/page-states';
import { buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { unwrap } from '@/lib/api/client';
import {
  announcementsApi,
  type AnnouncementDto,
  type AnnouncementListQuery,
  type AnnouncementSort,
} from '@/lib/api/school-announcements-contract';
import { formatDateTime, todayInSchool } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { useSchoolMe } from '@/lib/school-session';
import {
  AnnouncementStatusBadge,
  PRIORITY_LABELS,
  PriorityBadge,
  announcementHref,
  announcementKeys,
  audienceLabel,
  senderReach,
} from './_lib/announcements-ui';

// contracts/slice-14.md §5.2 and §12 "Announcements list": filters status, category, priority and
// created dates; a `.scope`-only sender sees only their own rows (the API filters). Received
// announcements are the inbox's, not this list's.

const LIMIT = 25;
// `sending` lasts seconds while the server writes the messages, so it is not offered as a filter.
const STATUS_FILTERS = ANNOUNCEMENT_STATUSES.filter((s) => s !== 'sending');

export function AnnouncementList() {
  const me = useSchoolMe();
  const reach = senderReach(me.data, todayInSchool());
  const fromId = useId();
  const toId = useId();
  const [status, setStatus] = useState<AnnouncementStatus | ''>('');
  const [category, setCategory] = useState<AnnouncementCategory | ''>('');
  const [priority, setPriority] = useState<AnnouncementPriority | ''>('');
  const [createdFrom, setCreatedFrom] = useState('');
  const [createdTo, setCreatedTo] = useState('');
  const [sort, setSort] = useState<AnnouncementSort>('-createdAt');
  const [page, setPage] = useListPage([status, category, priority, createdFrom, createdTo, sort]);
  const datesInvalid = createdFrom !== '' && createdTo !== '' && createdTo < createdFrom;

  const query: AnnouncementListQuery = {
    page,
    limit: LIMIT,
    sort,
    ...(status && { status }),
    ...(category && { category }),
    ...(priority && { priority }),
    ...(createdFrom && { createdFrom }),
    ...(createdTo && !datesInvalid && { createdTo }),
  };
  const list = useQuery({
    queryKey: [...announcementKeys.list, query],
    queryFn: () => unwrap(announcementsApi.GET('/api/v1/announcements', { params: { query } })),
    placeholderData: keepPreviousData,
    enabled: reach.canSend,
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, AnnouncementDto>();
    return [
      column.accessor('title', {
        header: 'Title',
        cell: (info) => (
          <div className="grid max-w-xs gap-0.5">
            <Link href={announcementHref(info.row.original.id)} className="truncate font-medium underline-offset-4 hover:underline">
              {info.getValue()}
            </Link>
            <span className="truncate text-xs text-muted-foreground">
              {info.row.original.audiences.map(audienceLabel).join(', ')}
            </span>
          </div>
        ),
      }),
      column.accessor('category', { header: 'Category', cell: (info) => ANNOUNCEMENT_CATEGORY_LABELS[info.getValue()] }),
      column.accessor('priority', { header: 'Priority', cell: (info) => <PriorityBadge priority={info.getValue()} /> }),
      column.accessor('status', { header: 'Status', cell: (info) => <AnnouncementStatusBadge status={info.getValue()} /> }),
      column.accessor('recipientCount', {
        header: () => <span className="block text-right">Recipients</span>,
        cell: (info) => (
          <span className="block text-right tabular-nums">{info.row.original.status === 'sent' ? info.getValue() : '—'}</span>
        ),
      }),
      column.accessor('smsSegments', {
        header: () => <span className="block text-right">SMS segments</span>,
        cell: (info) => <span className="block text-right tabular-nums">{info.getValue() ?? '—'}</span>,
      }),
      column.display({
        id: 'when',
        header: () => <SortHeader field="createdAt" label="Written" sort={sort === 'createdAt' || sort === '-createdAt' ? sort : '-createdAt'} onSort={setSort} />,
        cell: (info) => {
          const a = info.row.original;
          return (
            <div className="grid gap-0.5 text-sm">
              <span className="tabular-nums">{formatDateTime(a.createdAt)}</span>
              <span className="text-xs text-muted-foreground">
                {a.sentAt
                  ? `Sent ${formatDateTime(a.sentAt)}`
                  : a.scheduledAt && a.status === 'scheduled'
                    ? `Goes ${formatDateTime(a.scheduledAt)}`
                    : a.createdByName}
              </span>
            </div>
          );
        },
      }),
    ];
  }, [sort]);

  const header = (
    <PageHeader
      title="Announcements"
      description="Notices to families, students and staff. Each person gets one copy, however many children they have."
      actions={
        reach.canSend && (
          <Link href="/announcements/new" className={buttonVariants()}>
            <PlusIcon />
            New announcement
          </Link>
        )
      }
    />
  );
  if (me.data && !reach.canSend) {
    return (
      <>
        {header}
        <StateCard>
          <NoPermissionState description="Announcements are sent by the principal, the office and teachers for their own classes. Messages to you are in your inbox." />
        </StateCard>
      </>
    );
  }

  const filtered = Boolean(status || category || priority || createdFrom || createdTo);
  return (
    <>
      {header}
      <section className="grid gap-4" aria-label="Announcement list">
        <div className="flex flex-wrap items-start gap-3">
          <FilterSelect label="Status" value={status} onChange={setStatus}>
            <option value="">Any</option>
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {ANNOUNCEMENT_STATUS_LABELS[s]}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect label="Category" value={category} onChange={setCategory}>
            <option value="">Any</option>
            {ANNOUNCEMENT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {ANNOUNCEMENT_CATEGORY_LABELS[c]}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect label="Priority" value={priority} onChange={setPriority}>
            <option value="">Any</option>
            {ANNOUNCEMENT_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </FilterSelect>
          <div className="grid w-full gap-1.5 sm:w-40">
            <Label htmlFor={fromId}>Written from</Label>
            <Input id={fromId} type="date" value={createdFrom} onChange={(event) => setCreatedFrom(event.target.value)} />
          </div>
          <div className="grid w-full gap-1.5 sm:w-40">
            <Label htmlFor={toId}>Written to</Label>
            <Input
              id={toId}
              type="date"
              value={createdTo}
              min={createdFrom || undefined}
              aria-invalid={datesInvalid ? true : undefined}
              aria-describedby={datesInvalid ? `${toId}-error` : undefined}
              onChange={(event) => setCreatedTo(event.target.value)}
            />
            {datesInvalid && (
              <p id={`${toId}-error`} className="text-xs text-destructive">
                Cannot be before the start date.
              </p>
            )}
          </div>
          <FilterSelect<AnnouncementSort> label="Order" value={sort} onChange={setSort} className="sm:w-44">
            <option value="-createdAt">Newest written</option>
            <option value="createdAt">Oldest written</option>
            <option value="-scheduledAt">Scheduled time</option>
            <option value="-sentAt">Newest sent</option>
          </FilterSelect>
        </div>
        <DataTable
          columns={columns}
          query={list}
          getRowId={(row) => row.id}
          page={page}
          limit={LIMIT}
          onPageChange={setPage}
          emptyTitle={filtered ? 'No announcements match' : 'No announcements yet'}
          emptyDescription={
            filtered
              ? 'Try different filters or dates.'
              : reach.canSchoolWide
                ? 'Write one to the whole school, a class, a section or one family.'
                : 'Announcements you write appear here.'
          }
        />
      </section>
    </>
  );
}
