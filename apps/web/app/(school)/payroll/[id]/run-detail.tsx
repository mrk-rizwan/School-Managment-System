'use client';

import { Capability, COUNTER_PAYMENT_METHODS, formatDay, formatRupees, monthLabel, newIdempotencyKey, PAYMENT_METHOD_LABELS, todayInSchool } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { DataTable, type DataTableFeatures, type RowAction, RowActions } from '@/components/data-table';
import { BackLink, QueryStates } from '@/components/page-states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { unwrap } from '@/lib/api/client';
import { refusalMessage } from '@/lib/api/errors';
import { payrollApi, type CounterPaymentMethod, type PayrollRunDto, type PayslipDto } from '@/lib/api/school-payroll-contract';
import { useListPage } from '@/lib/hooks';
import { useCapabilities, useSchoolMe } from '@/lib/school-session';
import {
  PAYROLL_REFUSALS,
  PayslipBreakdown,
  PayslipStatusBadge,
  PrintLink,
  RunStatusBadge,
  SKIP_LABELS,
  payrollKeys,
  signedRupees,
} from '../_lib/payroll-ui';

// A payroll run (phase-3-financial.md slice 25, R214-R218, R245): review a draft with the
// attendance days behind each deduction and the unmarked days, adjust, recompute, finalise; then
// mark each payslip paid and print it.

const LIMIT = 50;

const days = (list: readonly string[]) => list.map((d) => formatDay(d)).join(', ');

export function RunDetail({ id }: { id: string }) {
  const run = useQuery({
    queryKey: payrollKeys.run(id),
    queryFn: () => unwrap(payrollApi.GET('/api/v1/payroll-runs/{id}', { params: { path: { id } } })),
  });
  return (
    <>
      <BackLink href="/payroll">Payroll</BackLink>
      <QueryStates query={run} notFound={{ title: 'Payroll run not found', description: 'Find it in the payroll list.' }}>
        {(data) => <Run run={data} />}
      </QueryStates>
    </>
  );
}

function Run({ run }: { run: PayrollRunDto }) {
  const { can } = useCapabilities();
  const me = useSchoolMe();
  const queryClient = useQueryClient();
  const [page, setPage] = useListPage([]);
  const [adjusting, setAdjusting] = useState<PayslipDto | null>(null);
  const [paying, setPaying] = useState<PayslipDto | null>(null);
  const [finalising, setFinalising] = useState(false);
  const draft = run.status === 'draft';
  const mayRun = can(Capability.PAYROLL_RUN);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: payrollKeys.run(run.id) });

  const payslips = useQuery({
    queryKey: [...payrollKeys.run(run.id), 'payslips', page],
    queryFn: () =>
      unwrap(payrollApi.GET('/api/v1/payroll-runs/{id}/payslips', { params: { path: { id: run.id }, query: { page, limit: LIMIT } } })),
    placeholderData: keepPreviousData,
  });
  const recompute = useMutation({
    mutationFn: () => unwrap(payrollApi.POST('/api/v1/payroll-runs/{id}/recompute', { params: { path: { id: run.id } } })),
    onSuccess: () => {
      toast.success('Recomputed from the latest attendance and leave.');
      refresh();
    },
    onError: (e) => toast.error(refusalMessage(e, PAYROLL_REFUSALS)),
  });
  const finalise = useMutation({
    mutationFn: (reason: string) =>
      unwrap(
        payrollApi.POST('/api/v1/payroll-runs/{id}/finalise', {
          params: { path: { id: run.id } },
          body: reason.trim() === '' ? {} : { reason: reason.trim() },
        }),
      ),
    onSuccess: () => {
      toast.success('Run finalised. Staff are told their payslips are ready.');
      setFinalising(false);
      refresh();
      void queryClient.invalidateQueries({ queryKey: payrollKeys.advances });
    },
    onError: (e) => toast.error(refusalMessage(e, PAYROLL_REFUSALS)),
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, PayslipDto>();
    return [
      column.display({
        id: 'staff',
        header: 'Staff member',
        cell: (info) => (
          <span>
            {info.row.original.staffName}
            {info.row.original.designation && <span className="block text-xs text-muted-foreground">{info.row.original.designation}</span>}
          </span>
        ),
      }),
      column.display({
        id: 'pay',
        header: 'Payslip',
        cell: (info) => (
          <div className="min-w-64">
            <PayslipBreakdown slip={info.row.original} />
          </div>
        ),
      }),
      column.display({
        id: 'days',
        header: 'Attendance',
        cell: (info) => {
          const s = info.row.original;
          return (
            <div className="grid max-w-72 gap-1 text-xs">
              <span>
                {s.unpaidDays} unpaid, {s.unmarkedDays} unmarked
              </span>
              {s.days && s.days.unpaid.length > 0 && <span className="text-muted-foreground">Unpaid: {days(s.days.unpaid)}</span>}
              {s.days && s.days.unmarked.length > 0 && <span className="text-muted-foreground">Unmarked: {days(s.days.unmarked)}</span>}
              {s.days && s.days.unapprovedLeave.length > 0 && (
                <span className="text-destructive">On leave without approval: {days(s.days.unapprovedLeave)}</span>
              )}
            </div>
          );
        },
      }),
      column.accessor('status', {
        header: 'Paid',
        cell: (info) => (
          <span className="grid gap-1">
            <PayslipStatusBadge status={info.getValue()} />
            {info.row.original.paidOn && <span className="text-xs text-muted-foreground">{formatDay(info.row.original.paidOn)}</span>}
          </span>
        ),
      }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => {
          const s = info.row.original;
          const own = s.staffId === me.data?.staffId;
          const actions: RowAction[] = [];
          if (mayRun && draft && !own) actions.push({ label: 'Adjust', onSelect: () => setAdjusting(s) });
          if (mayRun && !draft && s.status === 'pending') actions.push({ label: 'Mark paid', onSelect: () => setPaying(s) });
          return (
            <div className="flex items-center gap-3">
              <PrintLink href={`/api/v1/payslips/${s.id}/print`} />
              <RowActions label={s.staffName} actions={actions} />
            </div>
          );
        },
      }),
    ];
  }, [draft, mayRun, me.data?.staffId]);

  return (
    <>
      <PageHeader
        title={`Payroll, ${monthLabel(run.yearMonth)}`}
        description={`${run.workingDays} working days · ${run.staffCount} payslips · total net ${formatRupees(run.totalNet)}`}
        actions={
          <>
            <RunStatusBadge status={run.status} />
            {mayRun && draft && (
              <>
                <Button variant="outline" disabled={recompute.isPending} onClick={() => recompute.mutate()}>
                  {recompute.isPending ? 'Recomputing…' : 'Recompute'}
                </Button>
                <Button onClick={() => setFinalising(true)}>Finalise</Button>
              </>
            )}
          </>
        }
      />
      {draft && (
        <Alert className="mb-4">
          <AlertDescription>
            A draft: staff do not see it yet. Recompute after correcting attendance or approving leave; finalising freezes every payslip and
            recovers advances. {run.unmarkedDaysTotal > 0 && `${run.unmarkedDaysTotal} working days have no attendance mark (paid, not deducted).`}
          </AlertDescription>
        </Alert>
      )}
      {run.skipped.length > 0 && (
        <div className="mb-4 rounded-md border p-3 text-sm" aria-label="Skipped">
          <p className="mb-1 font-medium">Not paid in this run</p>
          <ul className="grid gap-0.5 text-muted-foreground">
            {run.skipped.map((s) => (
              <li key={s.staffId}>
                {s.name}: {SKIP_LABELS[s.reason] ?? s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      <DataTable
        columns={columns}
        query={payslips}
        getRowId={(r) => r.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle="No payslips"
        emptyDescription="Nobody with a salary was employed this month."
      />
      {adjusting && (
        <AdjustDialog
          slip={adjusting}
          onClose={() => setAdjusting(null)}
          onDone={() => {
            setAdjusting(null);
            toast.success('Adjustment added.');
            refresh();
          }}
        />
      )}
      {paying && (
        <MarkPaidDialog
          slip={paying}
          onClose={() => setPaying(null)}
          onDone={() => {
            setPaying(null);
            toast.success('Marked paid.');
            refresh();
          }}
        />
      )}
      <ConfirmWithReasonDialog
        open={finalising}
        onOpenChange={(open) => !open && setFinalising(false)}
        title={`Finalise ${monthLabel(run.yearMonth)}?`}
        description="Every payslip is recomputed from today's data and frozen; advances are recovered and staff are told. This cannot be undone: a later correction is an adjustment in a later run."
        confirmLabel="Finalise"
        minLength={0}
        pending={finalise.isPending}
        onConfirm={(reason) => finalise.mutate(reason)}
      />
    </>
  );
}

function AdjustDialog({ slip, onClose, onDone }: { slip: PayslipDto; onClose: () => void; onDone: () => void }) {
  const [key] = useState(newIdempotencyKey);
  const [form, setForm] = useState({ sign: '+', amount: '', name: '', reason: '', adjustsPayslipId: '' });
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const ids = { sign: useId(), amount: useId(), name: useId(), reason: useId(), target: useId() };
  const amount = Number(form.amount) * (form.sign === '-' ? -1 : 1);
  const complete = amount !== 0 && form.name.trim() !== '' && form.reason.trim().length >= 3;
  const adjust = useMutation({
    mutationFn: () =>
      unwrap(
        payrollApi.POST('/api/v1/payslips/{id}/adjust', {
          params: { path: { id: slip.id }, header: { 'Idempotency-Key': key } },
          body: {
            amount,
            name: form.name.trim(),
            reason: form.reason.trim(),
            ...(form.adjustsPayslipId.trim() === '' ? {} : { adjustsPayslipId: form.adjustsPayslipId.trim() }),
          },
        }),
      ),
    onSuccess: onDone,
    onError: (e) => setError(refusalMessage(e, PAYROLL_REFUSALS)),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && !adjust.isPending && onClose()}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (complete) adjust.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Adjust {slip.staffName}&apos;s payslip</DialogTitle>
            <DialogDescription>
              Added to or taken from this month&apos;s pay (now {formatRupees(slip.net)} net). An adjustment is kept: a wrong one is answered by
              another.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-[6rem_1fr] gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={ids.sign}>Add or take</Label>
              <NativeSelect id={ids.sign} value={form.sign} onChange={(e) => set({ sign: e.target.value })}>
                <option value="+">Add</option>
                <option value="-">Take</option>
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={ids.amount}>Amount (Rs)</Label>
              <Input id={ids.amount} inputMode="numeric" value={form.amount} onChange={(e) => set({ amount: e.target.value.replace(/\D/g, '') })} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.name}>Shown on the payslip as</Label>
            <Input id={ids.name} maxLength={60} value={form.name} onChange={(e) => set({ name: e.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.reason}>Reason</Label>
            <Input id={ids.reason} maxLength={500} value={form.reason} onChange={(e) => set({ reason: e.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.target}>Corrects an earlier payslip (its number, optional)</Label>
            <Input id={ids.target} inputMode="numeric" value={form.adjustsPayslipId} onChange={(e) => set({ adjustsPayslipId: e.target.value.replace(/\D/g, '') })} />
          </div>
          {form.amount !== '' && <p className="text-sm text-muted-foreground">Adjustment: {signedRupees(amount)}</p>}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={adjust.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!complete || adjust.isPending}>
              {adjust.isPending ? 'Saving…' : 'Add adjustment'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MarkPaidDialog({ slip, onClose, onDone }: { slip: PayslipDto; onClose: () => void; onDone: () => void }) {
  const today = todayInSchool();
  const [form, setForm] = useState({ paidOn: today, paidMethod: 'cash' as CounterPaymentMethod, paidReference: '' });
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const ids = { on: useId(), method: useId(), ref: useId() };
  const pay = useMutation({
    mutationFn: () =>
      unwrap(
        payrollApi.POST('/api/v1/payslips/{id}/mark-paid', {
          params: { path: { id: slip.id } },
          body: {
            paidOn: form.paidOn,
            paidMethod: form.paidMethod,
            ...(form.paidReference.trim() === '' ? {} : { paidReference: form.paidReference.trim() }),
          },
        }),
      ),
    onSuccess: onDone,
    onError: (e) => setError(refusalMessage(e, PAYROLL_REFUSALS)),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && !pay.isPending && onClose()}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            pay.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Mark {slip.staffName} paid</DialogTitle>
            <DialogDescription>{formatRupees(slip.net)} net. Recorded once; it cannot be changed afterwards.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={ids.on}>Paid on</Label>
              <Input id={ids.on} type="date" max={today} value={form.paidOn} onChange={(e) => set({ paidOn: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={ids.method}>Method</Label>
              <NativeSelect id={ids.method} value={form.paidMethod} onChange={(e) => set({ paidMethod: e.target.value as CounterPaymentMethod })}>
                {COUNTER_PAYMENT_METHODS.map((value) => (
                  <option key={value} value={value}>
                    {PAYMENT_METHOD_LABELS[value]}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.ref}>Reference (optional)</Label>
            <Input id={ids.ref} maxLength={60} value={form.paidReference} onChange={(e) => set({ paidReference: e.target.value })} />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pay.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pay.isPending}>
              {pay.isPending ? 'Saving…' : 'Mark paid'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
