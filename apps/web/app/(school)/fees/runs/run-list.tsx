'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { useMemo } from 'react';
import { DataTable, type DataTableFeatures } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { unwrap } from '@/lib/api/client';
import { chargesApi, type ChargeRunDto, type ChargeRunListQuery } from '@/lib/api/school-charges-contract';
import { formatDateTime } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { RUN_STATUS_LABELS, feesKeys, formatMonth } from '../_lib/fees-ui';

const LIMIT = 25;

const ERRORS: Record<string, string> = {
  stale: 'Stopped responding; run it again',
  year_closed: 'The year is closed',
  campaign_gone: 'The campaign changed',
  error: 'Failed; run it again',
};

/** Generation runs (slice 19, R179, R252): what each run charged and which classes it skipped. */
export function RunList() {
  const [page, setPage] = useListPage([]);
  const query: ChargeRunListQuery = { page, limit: LIMIT };
  const runs = useQuery({
    queryKey: [...feesKeys.runs, 'list', query],
    queryFn: () => unwrap(chargesApi.GET('/api/v1/charges/generation-runs', { params: { query } })),
    placeholderData: keepPreviousData,
    // A queued run moves on its own: look again while one is in flight.
    refetchInterval: (q) => (q.state.data?.data.some((r) => r.status === 'queued' || r.status === 'running') ? 5000 : false),
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, ChargeRunDto>();
    return [
      column.accessor('period', {
        header: 'Month',
        cell: (info) => (
          <span className="flex flex-col">
            <span className="font-medium">{formatMonth(info.getValue())}</span>
            <span className="text-xs text-muted-foreground">
              {info.row.original.kind === 'campaign' ? 'Campaign' : info.row.original.triggeredBy ? 'Requested' : 'Scheduled'}
              {info.row.original.regenerateVoided && ' · recreating voided'}
            </span>
          </span>
        ),
      }),
      column.accessor('queuedAt', { header: 'Started', cell: (info) => formatDateTime(info.getValue()) }),
      column.accessor('status', {
        header: 'Status',
        cell: (info) => (
          <span className="flex flex-col gap-1">
            <Badge variant={info.getValue() === 'failed' ? 'destructive' : info.getValue() === 'done' ? 'ghost' : 'default'}>
              {RUN_STATUS_LABELS[info.getValue()]}
            </Badge>
            {info.row.original.errorCode && (
              <span className="text-xs text-muted-foreground">{ERRORS[info.row.original.errorCode] ?? info.row.original.errorCode}</span>
            )}
          </span>
        ),
      }),
      column.accessor('chargesInserted', {
        header: () => <span className="block text-right">Charges</span>,
        cell: (info) => (
          <span className="block text-right tabular-nums">
            {info.getValue()}
            <span className="block text-xs text-muted-foreground">
              {info.row.original.studentsCharged} students · {info.row.original.chargesSkipped} already charged
            </span>
          </span>
        ),
      }),
      column.accessor('skippedClasses', {
        header: 'Classes skipped',
        cell: (info) =>
          info.getValue().length === 0 ? (
            <span className="text-muted-foreground">None</span>
          ) : (
            <span title="A fee priced for other classes has no amount for these">
              {info.getValue().map((c) => c.className).join(', ')}
            </span>
          ),
      }),
    ];
  }, []);

  return (
    <DataTable
      columns={columns}
      query={runs}
      getRowId={(row) => row.id}
      page={page}
      limit={LIMIT}
      onPageChange={setPage}
      emptyTitle="No runs yet"
      emptyDescription="The month is generated on the 1st by itself; a run requested from Charges appears here too."
    />
  );
}
