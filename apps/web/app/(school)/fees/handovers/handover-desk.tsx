'use client';

import { Capability, formatRupees } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { DataTable, type DataTableFeatures, type RowAction, RowActions } from '@/components/data-table';
import { QueryStates } from '@/components/page-states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { unwrap } from '@/lib/api/client';
import { ApiError, toastApiError } from '@/lib/api/errors';
import { paymentsApi, type HandoverDto, type HandoverListQuery, type HandoverStatus } from '@/lib/api/school-payments-contract';
import { formatDateTime } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { useCapabilities } from '@/lib/school-session';
import { digitsOnly, feesKeys, useIsPrincipal } from '../_lib/fees-ui';

const LIMIT = 25;
const handoverKeys = [...feesKeys.all, 'handovers'] as const;

/**
 * Cash custody and handovers (slice 20, §3.4, R193, R194): my cash in hand and handing it over;
 * for confirm-key holders the queue to count, and for principals the shortfalls to resolve.
 * Opening a handover on behalf of a collector who has left is API-only for now.
 */
export function HandoverDesk() {
  const { can } = useCapabilities();
  const canConfirm = can(Capability.COLLECTION_HANDOVER_CONFIRM);
  return (
    <div className="grid gap-8">
      {can(Capability.PAYMENT_RECORD) && <MyCustody />}
      {canConfirm && <ConfirmQueue />}
    </div>
  );
}

const STATUS_LABELS: Record<HandoverStatus, string> = { open: 'Waiting to be counted', confirmed: 'Counted' };

function useHandoverColumns(actions?: (h: HandoverDto) => RowAction[]) {
  return useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, HandoverDto>();
    return [
      column.accessor('openedAt', { header: 'Handed over', cell: (info) => formatDateTime(info.getValue()) }),
      column.accessor('collector', {
        header: 'Collector',
        cell: (info) => (
          <span>
            {info.getValue().name}
            {info.row.original.onBehalf && <span className="block text-xs text-muted-foreground">opened by {info.row.original.openedByName}</span>}
          </span>
        ),
      }),
      column.accessor('expectedAmount', {
        header: () => <span className="block text-right">Expected</span>,
        cell: (info) => (
          <span className="block text-right tabular-nums">
            {formatRupees(info.getValue())}
            <span className="block text-xs text-muted-foreground">{info.row.original.paymentCount} payments</span>
          </span>
        ),
      }),
      column.accessor('countedAmount', {
        header: () => <span className="block text-right">Counted</span>,
        cell: (info) => {
          const h = info.row.original;
          if (info.getValue() === null) return <span className="block text-right text-muted-foreground">—</span>;
          return (
            <span className="block text-right tabular-nums">
              {formatRupees(info.getValue() ?? 0)}
              {(h.shortfallAmount ?? 0) > 0 && <span className="block text-xs text-destructive">short {formatRupees(h.shortfallAmount ?? 0)}</span>}
              {(h.surplusAmount ?? 0) > 0 && <span className="block text-xs text-muted-foreground">over {formatRupees(h.surplusAmount ?? 0)}</span>}
            </span>
          );
        },
      }),
      column.accessor('status', {
        header: 'Status',
        cell: (info) => (
          <span className="flex flex-col gap-1">
            <Badge variant={info.getValue() === 'open' ? 'default' : 'ghost'}>{STATUS_LABELS[info.getValue()]}</Badge>
            {info.row.original.shortfallResolution && (
              <span className="text-xs text-muted-foreground">Shortfall {info.row.original.shortfallResolution.replaceAll('_', ' ')}</span>
            )}
          </span>
        ),
      }),
      ...(actions
        ? [
            column.display({
              id: 'actions',
              header: () => <span className="sr-only">Actions</span>,
              cell: (info) => <RowActions label={`Handover of ${info.row.original.collector.name}`} actions={actions(info.row.original)} />,
            }),
          ]
        : []),
    ];
  }, [actions]);
}

function MyCustody() {
  const queryClient = useQueryClient();
  const custody = useQuery({
    queryKey: [...handoverKeys, 'custody'],
    queryFn: () => unwrap(paymentsApi.GET('/api/v1/me/staff/custody')),
  });
  const [page, setPage] = useListPage([]);
  const query = { page, limit: LIMIT };
  const mine = useQuery({
    queryKey: [...handoverKeys, 'mine', query],
    queryFn: () => unwrap(paymentsApi.GET('/api/v1/me/staff/cash-handovers', { params: { query } })),
    placeholderData: keepPreviousData,
  });
  const handOver = useMutation({
    mutationFn: () => unwrap(paymentsApi.POST('/api/v1/me/staff/cash-handovers', { body: {} })),
    onSuccess: (h) => {
      toast.success(`${formatRupees(h.expectedAmount)} handed over. Someone else will count it.`);
      void queryClient.invalidateQueries({ queryKey: handoverKeys });
    },
    onError: (e) => {
      toastApiError(e);
      void queryClient.invalidateQueries({ queryKey: handoverKeys });
    },
  });
  const columns = useHandoverColumns();
  return (
    <section className="grid gap-4">
      <h2 className="text-lg font-medium">My cash</h2>
      <QueryStates query={custody} loadingRows={1}>
        {(c) => (
          <div className="flex flex-wrap items-center gap-4 rounded-md border p-4">
            <div>
              <p className="text-2xl font-medium tabular-nums">{formatRupees(c.cashInHand)}</p>
              <p className="text-sm text-muted-foreground">
                {c.paymentCount} cash payment{c.paymentCount === 1 ? '' : 's'} in hand{c.since && ` since ${formatDateTime(c.since)}`}
              </p>
            </div>
            <Button className="ml-auto" disabled={c.paymentCount === 0 || handOver.isPending} onClick={() => handOver.mutate()}>
              {handOver.isPending ? 'Handing over…' : 'Hand over'}
            </Button>
          </div>
        )}
      </QueryStates>
      <DataTable
        columns={columns}
        query={mine}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle="No handovers yet"
        emptyDescription="Hand over your cash at the end of the day; a colleague counts it."
      />
    </section>
  );
}

function ConfirmQueue() {
  const queryClient = useQueryClient();
  const principal = useIsPrincipal();
  const [status, setStatus] = useState<HandoverStatus | ''>('open');
  const [page, setPage] = useListPage([status]);
  const [counting, setCounting] = useState<HandoverDto | null>(null);
  const [resolving, setResolving] = useState<HandoverDto | null>(null);
  const query: HandoverListQuery = { page, limit: LIMIT, ...(status && { status }) };
  const list = useQuery({
    queryKey: [...handoverKeys, 'queue', query],
    queryFn: () => unwrap(paymentsApi.GET('/api/v1/cash-handovers', { params: { query } })),
    placeholderData: keepPreviousData,
  });
  const shortQuery: HandoverListQuery = { page: 1, limit: 1, unresolvedShortfall: true };
  const shortfalls = useQuery({
    queryKey: [...handoverKeys, 'shortfalls', shortQuery],
    queryFn: () => unwrap(paymentsApi.GET('/api/v1/cash-handovers', { params: { query: shortQuery } })),
    enabled: principal,
  });
  const actions = useMemo(
    () => (h: HandoverDto): RowAction[] => [
      ...(h.status === 'open' ? [{ label: 'Count…', onSelect: () => setCounting(h) }] : []),
      ...(principal && (h.shortfallAmount ?? 0) > 0 && h.shortfallResolution === null ? [{ label: 'Resolve shortfall…', onSelect: () => setResolving(h) }] : []),
    ],
    [principal],
  );
  const columns = useHandoverColumns(actions);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: handoverKeys });
  return (
    <section className="grid gap-4">
      <h2 className="text-lg font-medium">Handovers to count</h2>
      {principal && (shortfalls.data?.total ?? 0) > 0 && (
        <Alert variant="destructive">
          <AlertDescription>
            {shortfalls.data?.total} counted handover{shortfalls.data?.total === 1 ? ' has' : 's have'} a shortfall to resolve.{' '}
            <button type="button" className="underline" onClick={() => setStatus('confirmed')}>
              Show counted
            </button>
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Status">
        {(['open', 'confirmed', ''] as const).map((s) => (
          <Button key={s || 'all'} role="radio" aria-checked={status === s} variant={status === s ? 'default' : 'outline'} onClick={() => setStatus(s)}>
            {s === '' ? 'All' : STATUS_LABELS[s]}
          </Button>
        ))}
      </div>
      <DataTable
        columns={columns}
        query={list}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle="Nothing to count"
        emptyDescription="Handovers appear here when a collector hands over their cash."
      />
      <CountDialog handover={counting} onClose={() => setCounting(null)} onDone={refresh} />
      <ResolveDialog handover={resolving} onClose={() => setResolving(null)} onDone={refresh} />
    </section>
  );
}

function CountDialog({ handover, onClose, onDone }: { handover: HandoverDto | null; onClose: () => void; onDone: () => void }) {
  const [counted, setCounted] = useState('');
  const confirm = useMutation({
    mutationFn: (h: HandoverDto) =>
      unwrap(paymentsApi.POST('/api/v1/cash-handovers/{id}/confirm', { params: { path: { id: h.id } }, body: { countedAmount: Number(counted) } })),
    onSuccess: (h) => {
      toast.success((h.shortfallAmount ?? 0) > 0 ? `Counted ${formatRupees(h.countedAmount ?? 0)}: short ${formatRupees(h.shortfallAmount ?? 0)}. The principals are told.` : 'Counted.');
      setCounted('');
      onDone();
      onClose();
    },
    onError: (e) => {
      toastApiError(e);
      if (e instanceof ApiError && e.status === 409) {
        onDone();
        onClose();
      }
    },
  });
  return (
    <Dialog open={handover !== null} onOpenChange={(open) => !open && !confirm.isPending && onClose()}>
      <DialogContent>
        {handover && (
          <form
            noValidate
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (counted !== '') confirm.mutate(handover);
            }}
          >
            <DialogHeader>
              <DialogTitle>Count {handover.collector.name}’s cash</DialogTitle>
              <DialogDescription>
                Expected {formatRupees(handover.expectedAmount)} from {handover.paymentCount} payments. Enter what you counted; a
                difference is recorded as a shortfall or a surplus.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor="count-amount">Counted (Rs)</Label>
              <Input id="count-amount" inputMode="numeric" maxLength={8} value={counted} onChange={(e) => setCounted(digitsOnly(e.target.value))} autoFocus />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={confirm.isPending} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={counted === '' || confirm.isPending}>
                {confirm.isPending ? 'Saving…' : 'Confirm count'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ResolveDialog({ handover, onClose, onDone }: { handover: HandoverDto | null; onClose: () => void; onDone: () => void }) {
  const [resolution, setResolution] = useState<'recovered' | 'written_off'>('recovered');
  const resolve = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(paymentsApi.POST('/api/v1/cash-handovers/{id}/resolve-shortfall', { params: { path: { id } }, body: { resolution, reason } })),
    onSuccess: () => {
      toast.success('Shortfall resolved.');
      onDone();
      onClose();
    },
    onError: (e) => {
      toastApiError(e);
      if (e instanceof ApiError && e.status === 409) {
        onDone();
        onClose();
      }
    },
  });
  return (
    <ConfirmWithReasonDialog
      open={handover !== null}
      onOpenChange={(open) => !open && onClose()}
      title={`Resolve the shortfall of ${formatRupees(handover?.shortfallAmount ?? 0)}`}
      description="Recovered: the collector made it good. Written off: recorded as a cash shortfall expense."
      confirmLabel="Resolve"
      minLength={3}
      pending={resolve.isPending}
      onConfirm={(reason) => handover && resolve.mutate({ id: handover.id, reason })}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="resolve-kind">Resolution</Label>
        <NativeSelect id="resolve-kind" value={resolution} onChange={(e) => setResolution(e.target.value as 'recovered' | 'written_off')}>
          <option value="recovered">Recovered from the collector</option>
          <option value="written_off">Written off</option>
        </NativeSelect>
      </div>
    </ConfirmWithReasonDialog>
  );
}
