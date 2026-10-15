'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { DataTable, RowActions, type DataTableFeatures, type RowAction } from '@/components/data-table';
import { FilterSelect } from '@/components/list-filters';
import { Badge } from '@/components/ui/badge';
import { unwrap } from '@/lib/api/client';
import { toastApiError } from '@/lib/api/errors';
import {
  supportApi,
  type SupportSessionDto,
  type SupportSessionListQuery,
  type SupportSessionStatus,
} from '@/lib/api/platform-support-contract';
import { formatDateTime } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { platformKeys } from '@/lib/platform-session';

const LIMIT = 25;

const ENDED: Record<string, string> = { closed: 'Closed', revoked: 'Revoked by the school', expired: 'Expired' };

export function SessionStatusBadge({ session }: { session: SupportSessionDto }) {
  return session.status === 'open' ? (
    <Badge>Open until {formatDateTime(session.expiresAt)}</Badge>
  ) : (
    <Badge variant="secondary">{ENDED[session.endKind ?? 'expired'] ?? 'Ended'}</Badge>
  );
}

/** Closing ends the holder's access at once; the school is told. */
export function useCloseSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(supportApi.POST('/api/v1/platform/support-sessions/{id}/close', { params: { path: { id } }, body: {} })),
    onSuccess: (session) => {
      toast.success(`Access to ${session.schoolName} closed.`);
      void queryClient.invalidateQueries({ queryKey: platformKeys.support });
    },
    onError: (error) => {
      toastApiError(error);
      void queryClient.invalidateQueries({ queryKey: platformKeys.support });
    },
  });
}

/**
 * Phase 5 slice 45 (rule 40): every support session, newest first. Only the admin who opened a
 * session reads through it or closes it; the others see that it exists. Access is opened from a
 * school's page, with a reason, a ticket and a fresh authenticator code.
 */
export function SupportSessionList() {
  const [status, setStatus] = useState<SupportSessionStatus | ''>('open');
  const [page, setPage] = useListPage([status]);
  const close = useCloseSession();
  const query: SupportSessionListQuery = { page, limit: LIMIT, ...(status && { status }) };
  const sessions = useQuery({
    queryKey: [...platformKeys.support, 'list', query],
    queryFn: () => unwrap(supportApi.GET('/api/v1/platform/support-sessions', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, SupportSessionDto>();
    return [
      column.accessor('schoolName', {
        header: 'School',
        cell: (info) => {
          const s = info.row.original;
          return s.mine && s.status === 'open' ? (
            <Link className="font-medium underline-offset-4 hover:underline" href={`/platform/support/${s.id}`}>
              {info.getValue()}
            </Link>
          ) : (
            <span className="font-medium">{info.getValue()}</span>
          );
        },
      }),
      column.display({ id: 'status', header: 'Status', cell: (info) => <SessionStatusBadge session={info.row.original} /> }),
      column.accessor('platformUserEmail', {
        header: 'Opened by',
        cell: (info) => <span className="break-all">{info.row.original.mine ? 'You' : info.getValue()}</span>,
      }),
      column.display({
        id: 'why',
        header: 'Ticket and reason',
        cell: (info) => (
          <span className="text-muted-foreground">
            {info.row.original.ticketRef} · {info.row.original.reason}
          </span>
        ),
      }),
      column.accessor('openedAt', { header: 'Opened', cell: (info) => formatDateTime(info.getValue()) }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => {
          const s = info.row.original;
          const actions: RowAction[] =
            s.mine && s.status === 'open' ? [{ label: 'Close access', onSelect: () => close.mutate(s.id), destructive: true }] : [];
          return <RowActions label={s.schoolName} actions={actions} />;
        },
      }),
    ];
  }, [close]);

  return (
    <>
      <PageHeader
        title="Support access"
        description="Read-only sessions on a school, opened from the school's page. Each lasts a few hours, the principals are told, and every read is in both audit logs."
      />
      <div className="mb-4">
        <FilterSelect<SupportSessionStatus | ''> label="Status" value={status} onChange={setStatus} className="sm:w-44">
          <option value="open">Open</option>
          <option value="ended">Ended</option>
          <option value="">All</option>
        </FilterSelect>
      </div>
      <DataTable
        columns={columns}
        query={sessions}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle={status === 'open' ? 'No open support access' : 'No support sessions'}
        emptyDescription="Open access from a school's page when a ticket needs it."
      />
    </>
  );
}
