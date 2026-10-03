'use client';

import { SCHOOL_STATUSES, type SchoolStatus, type WhatsAppStatus } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { DataTable, type DataTableFeatures } from '@/components/data-table';
import { FilterSelect, SearchField } from '@/components/list-filters';
import { Badge } from '@/components/ui/badge';
import { unwrap } from '@/lib/api/client';
import {
  platformMessagingApi,
  type ChannelDayCounts,
  type DeliveryHealthQuery,
  type DeliveryHealthSort,
  type DeliveryHealthWhatsAppFilter,
  type HealthChannel,
  type PlatformDeliveryHealthDto,
} from '@/lib/api/platform-messaging-contract';
import { formatDateTime } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { useListSearch } from '@/lib/list-search';
import { platformKeys } from '@/lib/platform-session';
import { SCHOOL_STATUS_LABELS, SchoolStatusBadge } from '../schools/school-ui';

// contracts/slice-9.md §6.3 and §14: per school, the WhatsApp number's state, today's and
// yesterday's deliveries by channel, and SMS use against the cap. From the daily rollup only: no
// message, recipient or phone number is ever shown here.

const LIMIT = 25;

const WHATSAPP_LABELS: Record<WhatsAppStatus | 'none', string> = {
  pending: 'Waiting to connect',
  connected: 'Connected',
  down: 'Down',
  disabled: 'Disabled',
  none: 'No number',
};
const WHATSAPP_VARIANT = {
  pending: 'outline',
  connected: 'secondary',
  down: 'destructive',
  disabled: 'outline',
  none: 'ghost',
} as const satisfies Record<WhatsAppStatus | 'none', string>;
const WHATSAPP_FILTERS: DeliveryHealthWhatsAppFilter[] = ['connected', 'down', 'pending', 'none'];

const CHANNEL_LABELS: Record<HealthChannel, string> = {
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  push: 'Push',
  email: 'Email',
};
const CHANNEL_ORDER: HealthChannel[] = ['whatsapp', 'sms', 'push', 'email'];

const SORT_OPTIONS: { value: DeliveryHealthSort; label: string }[] = [
  { value: 'name', label: 'Name, A–Z' },
  { value: '-name', label: 'Name, Z–A' },
  { value: '-failedToday', label: 'Most failures today' },
  { value: '-smsUsed', label: 'Most SMS used' },
];

/** Per channel: accepted and failed, with held-back and delivered counts when there are any. */
function DayCounts({ counts }: { counts: ChannelDayCounts[] }) {
  const active = CHANNEL_ORDER.map((channel) => counts.find((c) => c.channel === channel)).filter(
    (c): c is ChannelDayCounts => c !== undefined && c.accepted + c.failed + c.suppressed > 0,
  );
  if (active.length === 0) return <span className="text-muted-foreground">None</span>;
  return (
    <ul className="grid gap-0.5 text-xs">
      {active.map((c) => (
        <li key={c.channel} className="whitespace-nowrap tabular-nums">
          <span className="font-medium">{CHANNEL_LABELS[c.channel]}</span> {c.accepted} sent
          {c.delivered > 0 && <span className="text-muted-foreground"> · {c.delivered} delivered</span>}
          {c.failed > 0 && <span className="text-destructive"> · {c.failed} failed</span>}
          {c.suppressed > 0 && <span className="text-muted-foreground"> · {c.suppressed} held</span>}
        </li>
      ))}
    </ul>
  );
}

export function DeliveryHealth() {
  const [search, setSearch] = useState('');
  const [whatsappStatus, setWhatsappStatus] = useState<DeliveryHealthWhatsAppFilter | ''>('');
  const [schoolStatus, setSchoolStatus] = useState<SchoolStatus | ''>('');
  const [sort, setSort] = useState<DeliveryHealthSort>('name');
  const { q, identity, hint } = useListSearch(search);
  const [page, setPage] = useListPage([q, whatsappStatus, schoolStatus, sort]);

  const query: DeliveryHealthQuery = {
    page,
    limit: LIMIT,
    sort,
    ...(q && { q }),
    ...(whatsappStatus && { whatsappStatus }),
    ...(schoolStatus && { schoolStatus }),
  };
  const health = useQuery({
    queryKey: [...platformKeys.deliveryHealth, query],
    queryFn: () => unwrap(platformMessagingApi.GET('/api/v1/platform/messaging/health', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, PlatformDeliveryHealthDto>();
    return [
      column.accessor('name', {
        header: 'School',
        cell: (info) => {
          const row = info.row.original;
          return (
            <span className="grid gap-0.5">
              <Link
                href={`/platform/schools/${row.schoolId}`}
                className="font-medium underline-offset-4 hover:underline"
              >
                {row.name}
              </Link>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono">{row.shortCode}</span>
                {row.schoolStatus !== 'active' && <SchoolStatusBadge status={row.schoolStatus} />}
              </span>
            </span>
          );
        },
      }),
      column.accessor('whatsapp', {
        header: 'WhatsApp',
        cell: (info) => {
          const w = info.getValue();
          return (
            <span className="grid gap-0.5">
              <Badge variant={WHATSAPP_VARIANT[w.status]}>{WHATSAPP_LABELS[w.status]}</Badge>
              {w.lastHealthyAt && (
                <span className="text-xs whitespace-nowrap text-muted-foreground">
                  Last working {formatDateTime(w.lastHealthyAt)}
                </span>
              )}
              {w.lastErrorCode && w.status !== 'connected' && (
                <span className="font-mono text-xs text-muted-foreground">{w.lastErrorCode}</span>
              )}
            </span>
          );
        },
      }),
      column.accessor('today', { header: 'Today', cell: (info) => <DayCounts counts={info.getValue()} /> }),
      column.accessor('yesterday', { header: 'Yesterday', cell: (info) => <DayCounts counts={info.getValue()} /> }),
      column.accessor('sms', {
        header: 'SMS this month',
        cell: (info) => {
          const { used, cap } = info.getValue();
          return (
            <span className={used >= cap ? 'text-destructive tabular-nums' : 'tabular-nums'}>
              {used} / {cap}
            </span>
          );
        },
      }),
      column.accessor('computedAt', {
        header: 'Computed',
        cell: (info) => {
          const at = info.getValue();
          return at ? (
            <span className="text-xs whitespace-nowrap">{formatDateTime(at)}</span>
          ) : (
            <span className="text-xs text-muted-foreground">Not yet</span>
          );
        },
      }),
    ];
  }, []);

  const filtered = Boolean(q || whatsappStatus || schoolStatus);
  return (
    <>
      <PageHeader
        title="Delivery health"
        description="How each school’s messages are getting through, from the rollup. No message content or phone numbers are shown."
      />
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="School name or short code"
          hint={identity ? 'Search by the school’s name or short code.' : hint}
          hintTone={identity ? 'destructive' : 'muted'}
        />
        <FilterSelect label="WhatsApp" value={whatsappStatus} onChange={setWhatsappStatus}>
          <option value="">Any</option>
          {WHATSAPP_FILTERS.map((s) => (
            <option key={s} value={s}>
              {WHATSAPP_LABELS[s]}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label="School status" value={schoolStatus} onChange={setSchoolStatus}>
          <option value="">All but terminated</option>
          {SCHOOL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {SCHOOL_STATUS_LABELS[s]}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label="Sort" value={sort} onChange={setSort} className="sm:w-48">
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </FilterSelect>
      </div>
      <div className="overflow-x-auto">
        <DataTable
          columns={columns}
          query={health}
          getRowId={(row) => row.schoolId}
          page={page}
          limit={LIMIT}
          onPageChange={setPage}
          emptyTitle={filtered ? 'No schools match' : 'No schools yet'}
          emptyDescription={filtered ? 'Try a different search or filter.' : 'Schools appear here once created.'}
        />
      </div>
    </>
  );
}
