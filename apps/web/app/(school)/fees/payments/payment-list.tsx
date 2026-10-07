'use client';

import { Capability, COUNTER_PAYMENT_METHODS, formatRupees, newIdempotencyKey, PAYMENT_METHOD_LABELS } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { DataTable, type DataTableFeatures, type RowAction, RowActions } from '@/components/data-table';
import { FilterSelect } from '@/components/list-filters';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { unwrap } from '@/lib/api/client';
import { ApiError, toastApiError } from '@/lib/api/errors';
import {
  paymentsApi,
  receiptPrintUrl,
  type CounterPaymentMethod,
  type PaymentDto,
  type PaymentListQuery,
  type PaymentStatus,
  type ReversalDto,
} from '@/lib/api/school-payments-contract';
import { formatDate } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { useCapabilities } from '@/lib/school-session';
import { useYears } from '../../academics/_lib/options';
import { digitsOnly, feesKeys, useIsPrincipal } from '../_lib/fees-ui';

const LIMIT = 25;

type Dialog =
  | { kind: 'void'; payment: PaymentDto }
  | { kind: 'refund'; payment: PaymentDto }
  | { kind: 'reverse'; payment: PaymentDto; refund: ReversalDto }
  | { kind: 'carry'; payment: PaymentDto }
  | { kind: 'undoCarry'; payment: PaymentDto; carry: ReversalDto };

/**
 * Payments (slice 20, R190-R192, R251): every payment newest first with its receipt to print, and
 * the corrections each role may make: void (payment.void, never one's own), refund and its
 * reversal (payment.void and the principal), carry an advance into another year and undo that
 * while the carried payment is untouched (payment.record).
 */
export function PaymentList() {
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  const principal = useIsPrincipal();
  const canVoid = can(Capability.PAYMENT_VOID);
  const canRecord = can(Capability.PAYMENT_RECORD);
  const [status, setStatus] = useState<PaymentStatus | ''>('verified');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useListPage([status, from, to]);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const query: PaymentListQuery = {
    page,
    limit: LIMIT,
    ...(status && { status }),
    ...(from && { receivedFrom: from }),
    ...(to && { receivedTo: to }),
  };
  const payments = useQuery({
    queryKey: [...feesKeys.all, 'payments', query],
    queryFn: () => unwrap(paymentsApi.GET('/api/v1/payments', { params: { query } })),
    placeholderData: keepPreviousData,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: feesKeys.all });
  const done = (message: string) => {
    toast.success(message);
    refresh();
    setDialog(null);
  };
  const failed = (error: unknown) => {
    toastApiError(error);
    if (error instanceof ApiError && error.status === 409) {
      refresh();
      setDialog(null);
    }
  };
  const voidPayment = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(paymentsApi.POST('/api/v1/payments/{id}/void', { params: { path: { id } }, body: { reason } })),
    onSuccess: (p) => done(`Payment of ${formatRupees(p.amount)} voided.`),
    onError: failed,
  });
  const reverse = useMutation({
    mutationFn: ({ id, reversalId, reason }: { id: string; reversalId: string; reason: string }) =>
      unwrap(
        paymentsApi.POST('/api/v1/payments/{id}/reverse-refund', {
          params: { path: { id }, header: { 'Idempotency-Key': newIdempotencyKey() } },
          body: { reversalId, reason },
        }),
      ),
    onSuccess: (r) => done(`Refund of ${formatRupees(r.amount)} reversed.`),
    onError: failed,
  });
  const undoCarry = useMutation({
    mutationFn: ({ id, reversalId, reason }: { id: string; reversalId: string; reason: string }) =>
      unwrap(
        paymentsApi.POST('/api/v1/payments/{id}/carry-forward/undo', {
          params: { path: { id }, header: { 'Idempotency-Key': newIdempotencyKey() } },
          body: { reversalId, reason },
        }),
      ),
    onSuccess: (r) => done(`Carry-forward of ${formatRupees(r.amount)} undone.`),
    onError: failed,
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, PaymentDto>();
    return [
      column.accessor('receivedOn', { header: 'Received', cell: (info) => formatDate(info.getValue()) }),
      column.accessor('receipt', {
        header: 'Receipt',
        cell: (info) => {
          const receipt = info.getValue();
          if (!receipt) return <span className="text-muted-foreground">Carried forward</span>;
          return (
            <a className="font-medium text-primary hover:underline" href={receiptPrintUrl(receipt.id)} target="_blank" rel="noopener noreferrer">
              {receipt.receiptLabel}
            </a>
          );
        },
      }),
      column.accessor('payerName', {
        header: 'From',
        cell: (info) => (
          <span className="flex flex-col">
            <span>{info.getValue()}</span>
            <span className="text-xs text-muted-foreground">{info.row.original.students.map((s) => s.fullName).join(', ')}</span>
          </span>
        ),
      }),
      column.accessor('method', {
        header: 'Method',
        cell: (info) => (
          <span>
            {PAYMENT_METHOD_LABELS[info.getValue()]}
            {info.row.original.possibleDuplicate && (
              <Badge variant="destructive" className="ml-1">
                possible duplicate
              </Badge>
            )}
          </span>
        ),
      }),
      column.accessor('amount', {
        header: () => <span className="block text-right">Amount</span>,
        cell: (info) => (
          <span className="block text-right tabular-nums">
            {formatRupees(info.getValue())}
            {info.row.original.unallocatedAmount > 0 && (
              <span className="block text-xs text-muted-foreground">advance {formatRupees(info.row.original.unallocatedAmount)}</span>
            )}
          </span>
        ),
      }),
      column.accessor('status', {
        header: 'Status',
        cell: (info) => <Badge variant={info.getValue() === 'verified' ? 'default' : 'ghost'}>{info.getValue() === 'verified' ? 'Paid' : 'Voided'}</Badge>,
      }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => {
          const p = info.row.original;
          const actions: RowAction[] = [];
          if (p.status === 'verified') {
            if (canVoid && p.method !== 'carried_forward') actions.push({ label: 'Void', destructive: true, onSelect: () => setDialog({ kind: 'void', payment: p }) });
            if (canVoid && principal && p.unallocatedAmount > 0) actions.push({ label: 'Refund advance…', onSelect: () => setDialog({ kind: 'refund', payment: p }) });
            for (const r of p.reversals.filter((x) => x.kind === 'refund' && !x.reversed)) {
              if (canVoid && principal) actions.push({ label: `Reverse refund of ${formatRupees(r.amount)}`, onSelect: () => setDialog({ kind: 'reverse', payment: p, refund: r }) });
            }
            if (canRecord && p.unallocatedAmount > 0) actions.push({ label: 'Carry advance forward…', onSelect: () => setDialog({ kind: 'carry', payment: p }) });
            for (const r of p.reversals.filter((x) => x.kind === 'carried_forward' && !x.reversed)) {
              if (canRecord) actions.push({ label: `Undo carry-forward of ${formatRupees(r.amount)}`, onSelect: () => setDialog({ kind: 'undoCarry', payment: p, carry: r }) });
            }
          }
          return <RowActions label={`Payment ${p.receipt?.receiptLabel ?? p.id}`} actions={actions} />;
        },
      }),
    ];
  }, [canVoid, canRecord, principal]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <FilterSelect<PaymentStatus | ''> label="Status" value={status} onChange={setStatus}>
          <option value="verified">Paid</option>
          <option value="voided">Voided</option>
          <option value="">All</option>
        </FilterSelect>
        <div className="grid gap-1.5">
          <Label htmlFor="payments-from">From</Label>
          <Input id="payments-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="payments-to">To</Label>
          <Input id="payments-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
        </div>
      </div>
      <DataTable
        columns={columns}
        query={payments}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle="No payments match"
        emptyDescription="Payments are recorded at the counter."
      />
      <ConfirmWithReasonDialog
        open={dialog?.kind === 'void'}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Void this payment"
        description="The charges it paid reopen and its receipt is marked void (the number is never reused). Cash still in the recorder's hands leaves their custody; cash in a handover waiting to be counted cannot be voided."
        confirmLabel="Void payment"
        minLength={3}
        destructive
        pending={voidPayment.isPending}
        onConfirm={(reason) => dialog?.kind === 'void' && voidPayment.mutate({ id: dialog.payment.id, reason })}
      />
      <ConfirmWithReasonDialog
        open={dialog?.kind === 'reverse'}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Reverse this refund"
        description="The refunded amount becomes the child's advance again."
        confirmLabel="Reverse refund"
        minLength={3}
        pending={reverse.isPending}
        onConfirm={(reason) =>
          dialog?.kind === 'reverse' && reverse.mutate({ id: dialog.payment.id, reversalId: dialog.refund.id, reason })
        }
      />
      <ConfirmWithReasonDialog
        open={dialog?.kind === 'undoCarry'}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Undo this carry-forward"
        description="The advance comes back to this payment and the carried payment in the new year is voided. Refused once the carried advance has paid a charge or been refunded."
        confirmLabel="Undo carry-forward"
        minLength={3}
        pending={undoCarry.isPending}
        onConfirm={(reason) =>
          dialog?.kind === 'undoCarry' && undoCarry.mutate({ id: dialog.payment.id, reversalId: dialog.carry.id, reason })
        }
      />
      {dialog?.kind === 'refund' && <RefundDialog payment={dialog.payment} onDone={done} onError={failed} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'carry' && <CarryDialog payment={dialog.payment} onDone={done} onError={failed} onClose={() => setDialog(null)} />}
    </>
  );
}

type ActionDialogProps = { payment: PaymentDto; onDone: (message: string) => void; onError: (e: unknown) => void; onClose: () => void };

function RefundDialog({ payment, onDone, onError, onClose }: ActionDialogProps) {
  const [amount, setAmount] = useState(String(payment.unallocatedAmount));
  const [method, setMethod] = useState<CounterPaymentMethod>('cash');
  const [key] = useState(newIdempotencyKey);
  const refund = useMutation({
    mutationFn: (reason: string) =>
      unwrap(
        paymentsApi.POST('/api/v1/payments/{id}/refund', {
          params: { path: { id: payment.id }, header: { 'Idempotency-Key': key } },
          body: { amount: Number(amount), reason, method },
        }),
      ),
    onSuccess: (r) => onDone(`${formatRupees(r.amount)} refunded.`),
    onError,
  });
  return (
    <ConfirmWithReasonDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Refund the advance"
      description={`Only the advance (${formatRupees(payment.unallocatedAmount)}) is refundable; money already paid against fees is not.`}
      confirmLabel="Refund"
      minLength={3}
      pending={refund.isPending}
      confirmDisabled={!(Number(amount) > 0 && Number(amount) <= payment.unallocatedAmount)}
      onConfirm={(reason) => refund.mutate(reason)}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="refund-amount">Amount (Rs)</Label>
        <Input id="refund-amount" inputMode="numeric" maxLength={8} value={amount} onChange={(e) => setAmount(digitsOnly(e.target.value))} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="refund-method">Paid back by</Label>
        <NativeSelect id="refund-method" value={method} onChange={(e) => setMethod(e.target.value as CounterPaymentMethod)}>
          {COUNTER_PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {PAYMENT_METHOD_LABELS[m]}
            </option>
          ))}
        </NativeSelect>
      </div>
    </ConfirmWithReasonDialog>
  );
}

function CarryDialog({ payment, onDone, onError, onClose }: ActionDialogProps) {
  const years = useYears();
  const targets = (years.data?.data ?? []).filter((y) => y.id !== payment.academicYearId && y.status !== 'closed');
  const [yearId, setYearId] = useState('');
  const [key] = useState(newIdempotencyKey);
  const carry = useMutation({
    mutationFn: (reason: string) =>
      unwrap(
        paymentsApi.POST('/api/v1/payments/{id}/carry-forward', {
          params: { path: { id: payment.id }, header: { 'Idempotency-Key': key } },
          body: { academicYearId: yearId, reason },
        }),
      ),
    onSuccess: (r) => onDone(`${formatRupees(r.reversal.amount)} carried forward.`),
    onError,
  });
  return (
    <ConfirmWithReasonDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Carry the advance forward"
      description={`Moves the advance of ${formatRupees(payment.unallocatedAmount)} into another academic year, where it pays the child's dues. No cash moves.`}
      confirmLabel="Carry forward"
      minLength={3}
      pending={carry.isPending}
      confirmDisabled={yearId === ''}
      onConfirm={(reason) => carry.mutate(reason)}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="carry-year">Into</Label>
        <NativeSelect id="carry-year" value={yearId} onChange={(e) => setYearId(e.target.value)}>
          <option value="">Choose a year</option>
          {targets.map((y) => (
            <option key={y.id} value={y.id}>
              {y.name}
            </option>
          ))}
        </NativeSelect>
      </div>
    </ConfirmWithReasonDialog>
  );
}
