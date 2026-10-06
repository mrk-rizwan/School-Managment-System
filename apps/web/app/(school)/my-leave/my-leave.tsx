'use client';

import { newIdempotencyKey, todayInSchool } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { PlusIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { DataTable, type DataTableFeatures, type RowAction, RowActions } from '@/components/data-table';
import { ErrorState, LoadingState } from '@/components/page-states';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { unwrap } from '@/lib/api/client';
import { refusalMessage } from '@/lib/api/errors';
import { leaveApi, type LeaveRequestDto } from '@/lib/api/school-leave-contract';
import { useListPage } from '@/lib/hooks';
import { useActiveTypes } from '../leave/leave-screen';
import { LEAVE_REFUSALS, LeaveStatusBadge, leaveKeys, leavePeriod, workingDaysLabel } from '../leave/_lib/leave-ui';

const LIMIT = 25;

/** Cancellable by its owner: pending, or approved and not yet started (the server's rule). */
const cancellable = (row: LeaveRequestDto, today: string) =>
  row.status === 'pending' || (row.status === 'approved' && row.startsOn > today);

/** A staff member's own leave (slice 24, R209): balances, requests, request and cancel. */
export function MyLeave() {
  const queryClient = useQueryClient();
  const [page, setPage] = useListPage([]);
  const [requesting, setRequesting] = useState(false);
  const [cancelling, setCancelling] = useState<LeaveRequestDto | null>(null);
  const today = todayInSchool();

  const balance = useQuery({
    queryKey: [...leaveKeys.mine, 'balance'],
    queryFn: () => unwrap(leaveApi.GET('/api/v1/me/staff/leave-balance', { params: { query: {} } })),
  });
  const requests = useQuery({
    queryKey: [...leaveKeys.mine, 'requests', page],
    queryFn: () => unwrap(leaveApi.GET('/api/v1/me/staff/leave-requests', { params: { query: { page, limit: LIMIT } } })),
    placeholderData: keepPreviousData,
  });
  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(leaveApi.POST('/api/v1/me/staff/leave-requests/{id}/cancel', { params: { path: { id } }, body: { reason } })),
    onSuccess: () => {
      toast.success('Request cancelled.');
      setCancelling(null);
      void queryClient.invalidateQueries({ queryKey: leaveKeys.mine });
    },
    onError: (error) => toast.error(refusalMessage(error, LEAVE_REFUSALS)),
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, LeaveRequestDto>();
    return [
      column.display({ id: 'type', header: 'Type', cell: (info) => info.row.original.leaveType.name }),
      column.display({
        id: 'dates',
        header: 'Dates',
        cell: (info) => (
          <span>
            {leavePeriod(info.row.original)}
            <span className="block text-xs text-muted-foreground">{workingDaysLabel(info.row.original.workingDays)}</span>
          </span>
        ),
      }),
      column.accessor('status', { header: 'Status', cell: (info) => <LeaveStatusBadge status={info.getValue()} /> }),
      column.accessor('decisionReason', { header: 'Note', cell: (info) => info.getValue() ?? '—' }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => {
          const row = info.row.original;
          const actions: RowAction[] = cancellable(row, today)
            ? [{ label: 'Cancel request', onSelect: () => setCancelling(row), destructive: true }]
            : [];
          return <RowActions label={row.leaveType.name} actions={actions} />;
        },
      }),
    ];
  }, [today]);

  return (
    <>
      <PageHeader
        title="My leave"
        description="Your balance this year and your requests. You are told when a request is decided."
        actions={
          <Button onClick={() => setRequesting(true)}>
            <PlusIcon />
            Request leave
          </Button>
        }
      />
      <div className="mb-8 grid gap-3 sm:grid-cols-3" aria-label="Balance">
        {balance.isPending ? (
          <LoadingState rows={2} />
        ) : balance.isError ? (
          <ErrorState error={balance.error} onRetry={() => void balance.refetch()} />
        ) : (
          balance.data.types.map((row) => (
            <Card key={row.leaveTypeId} data-testid={`balance-${row.leaveTypeId}`}>
              <CardContent className="grid gap-1">
                <span className="text-sm text-muted-foreground">{row.name}</span>
                <span className="text-2xl font-semibold tabular-nums">
                  {row.balance === null ? `${row.used} taken` : `${row.balance} of ${row.entitlement} left`}
                </span>
                {row.pending > 0 && <span className="text-xs text-muted-foreground">{row.pending} pending</span>}
              </CardContent>
            </Card>
          ))
        )}
      </div>
      <DataTable
        columns={columns}
        query={requests}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle="No requests yet"
        emptyDescription="Requests you make appear here."
      />
      {requesting && (
        <RequestLeaveDialog
          onClose={() => setRequesting(false)}
          onDone={() => {
            setRequesting(false);
            toast.success('Request sent.');
            void queryClient.invalidateQueries({ queryKey: leaveKeys.mine });
          }}
        />
      )}
      <ConfirmWithReasonDialog
        open={cancelling !== null}
        onOpenChange={(open) => !open && setCancelling(null)}
        title="Cancel this request?"
        description={cancelling ? `${cancelling.leaveType.name}, ${leavePeriod(cancelling)}. A cover arranged for it ends too.` : undefined}
        confirmLabel="Cancel the request"
        minLength={3}
        destructive
        pending={cancel.isPending}
        onConfirm={(reason) => cancelling && cancel.mutate({ id: cancelling.id, reason })}
      />
    </>
  );
}

function RequestLeaveDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const types = useActiveTypes();
  const [key] = useState(newIdempotencyKey);
  const today = todayInSchool();
  const [form, setForm] = useState({ leaveTypeId: '', startsOn: today, endsOn: today, reason: '' });
  const [error, setError] = useState<string | null>(null);
  const ids = { type: useId(), from: useId(), to: useId(), reason: useId() };
  const complete = form.leaveTypeId !== '' && form.reason.trim().length >= 3 && form.endsOn >= form.startsOn;
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        leaveApi.POST('/api/v1/me/staff/leave-requests', {
          params: { header: { 'Idempotency-Key': key } },
          body: { ...form, reason: form.reason.trim() },
        }),
      ),
    onSuccess: onDone,
    onError: (e) => setError(refusalMessage(e, LEAVE_REFUSALS)),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !create.isPending && onClose()}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (complete) create.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Request leave</DialogTitle>
            <DialogDescription>At most 60 days, starting no more than 7 days ago.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.type}>Type</Label>
            <NativeSelect id={ids.type} value={form.leaveTypeId} onChange={(e) => set({ leaveTypeId: e.target.value })}>
              <option value="">Choose…</option>
              {(types.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={ids.from}>First day</Label>
              <Input id={ids.from} type="date" value={form.startsOn} onChange={(e) => set({ startsOn: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={ids.to}>Last day</Label>
              <Input id={ids.to} type="date" value={form.endsOn} min={form.startsOn} onChange={(e) => set({ endsOn: e.target.value })} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.reason}>Reason</Label>
            <Textarea id={ids.reason} rows={2} maxLength={500} value={form.reason} onChange={(e) => set({ reason: e.target.value })} />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={create.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!complete || create.isPending}>
              {create.isPending ? 'Working…' : 'Send request'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
