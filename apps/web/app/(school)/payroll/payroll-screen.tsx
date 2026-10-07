'use client';

import { Capability, COUNTER_PAYMENT_METHODS, formatRupees, monthLabel, newIdempotencyKey, PAYMENT_METHOD_LABELS, todayInSchool } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { DataTable, type DataTableFeatures, type RowAction, RowActions } from '@/components/data-table';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { OPTIONS_LIMIT, unwrap } from '@/lib/api/client';
import { refusalMessage } from '@/lib/api/errors';
import { payrollApi, type AdvanceDto, type CounterPaymentMethod, type PayrollRunDto } from '@/lib/api/school-payroll-contract';
import { formatDay } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { useCapabilities, useSchoolMe } from '@/lib/school-session';
import { cn } from '@/lib/utils';
import { AdvanceStatusBadge, PAYROLL_REFUSALS, RunStatusBadge, payrollKeys } from './_lib/payroll-ui';

// Payroll (phase-3-financial.md slice 25): the monthly runs (prepare → review → finalise → mark
// paid, on the run's own page) and salary advances (granted and written off by a principal).

const LIMIT = 25;

export function PayrollScreen() {
  const [tab, setTab] = useState<'runs' | 'advances'>('runs');
  return (
    <>
      <PageHeader title="Payroll" description="Monthly salary runs and salary advances." />
      <div role="tablist" aria-label="Payroll" className="mb-6 flex gap-1 border-b">
        {(['runs', 'advances'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm',
              tab === t ? 'border-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t === 'runs' ? 'Runs' : 'Advances'}
          </button>
        ))}
      </div>
      {tab === 'runs' ? <Runs /> : <Advances />}
    </>
  );
}

function Runs() {
  const { can } = useCapabilities();
  const router = useRouter();
  const [page, setPage] = useListPage([]);
  const [preparing, setPreparing] = useState(false);
  const runs = useQuery({
    queryKey: [...payrollKeys.runs, page],
    queryFn: () => unwrap(payrollApi.GET('/api/v1/payroll-runs', { params: { query: { page, limit: LIMIT } } })),
    placeholderData: keepPreviousData,
  });
  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, PayrollRunDto>();
    return [
      column.accessor('yearMonth', {
        header: 'Month',
        cell: (info) => (
          <Link className="font-medium underline-offset-4 hover:underline" href={`/payroll/${info.row.original.id}`}>
            {monthLabel(info.getValue())}
          </Link>
        ),
      }),
      column.accessor('status', { header: 'Status', cell: (info) => <RunStatusBadge status={info.getValue()} /> }),
      column.accessor('staffCount', { header: 'Payslips' }),
      column.accessor('totalNet', { header: 'Total net', cell: (info) => formatRupees(info.getValue()) }),
      column.accessor('unmarkedDaysTotal', { header: 'Unmarked days' }),
    ];
  }, []);
  return (
    <>
      {can(Capability.PAYROLL_RUN) && (
        <div className="mb-4 flex justify-end">
          <Button onClick={() => setPreparing(true)}>Prepare a run</Button>
        </div>
      )}
      <DataTable
        columns={columns}
        query={runs}
        getRowId={(r) => r.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle="No payroll runs yet"
        emptyDescription="On the school's pay day last month's run is prepared as a draft."
      />
      {preparing && <PrepareDialog onClose={() => setPreparing(false)} onDone={(id) => router.push(`/payroll/${id}`)} />}
    </>
  );
}

function PrepareDialog({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const today = todayInSchool();
  const [yearMonth, setYearMonth] = useState(previousMonth(today));
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const prepare = useMutation({
    mutationFn: () => unwrap(payrollApi.POST('/api/v1/payroll-runs', { body: { yearMonth } })),
    onSuccess: (run) => onDone(run.id),
    onError: (e) => setError(refusalMessage(e, PAYROLL_REFUSALS)),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && !prepare.isPending && onClose()}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            prepare.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Prepare a payroll run</DialogTitle>
            <DialogDescription>
              A month that has ended, or this month from its last working day. The run is a draft until you finalise it.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor={id}>Month</Label>
            <Input id={id} type="month" value={yearMonth} max={today.slice(0, 7)} onChange={(e) => setYearMonth(e.target.value)} />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={prepare.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={yearMonth === '' || prepare.isPending}>
              {prepare.isPending ? 'Preparing…' : 'Prepare'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const previousMonth = (today: string): string => {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

function Advances() {
  const { can } = useCapabilities();
  const me = useSchoolMe();
  const queryClient = useQueryClient();
  const isPrincipal = (me.data?.roles ?? []).includes('principal');
  const mayGrant = can(Capability.PAYROLL_RUN) && isPrincipal;
  const [page, setPage] = useListPage([]);
  const [granting, setGranting] = useState(false);
  const [writingOff, setWritingOff] = useState<AdvanceDto | null>(null);
  const advances = useQuery({
    queryKey: [...payrollKeys.advances, page],
    queryFn: () => unwrap(payrollApi.GET('/api/v1/salary-advances', { params: { query: { page, limit: LIMIT } } })),
    placeholderData: keepPreviousData,
  });
  const writeOff = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(payrollApi.POST('/api/v1/salary-advances/{id}/write-off', { params: { path: { id } }, body: { reason } })),
    onSuccess: () => {
      toast.success('Advance written off.');
      setWritingOff(null);
      void queryClient.invalidateQueries({ queryKey: payrollKeys.advances });
    },
    onError: (e) => toast.error(refusalMessage(e, PAYROLL_REFUSALS)),
  });
  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, AdvanceDto>();
    return [
      column.accessor('staffName', { header: 'Staff member' }),
      column.accessor('grantedOn', { header: 'Granted', cell: (info) => formatDay(info.getValue()) }),
      column.accessor('amount', { header: 'Amount', cell: (info) => formatRupees(info.getValue()) }),
      column.display({
        id: 'recovery',
        header: 'Recovery',
        cell: (info) => {
          const a = info.row.original;
          return `${formatRupees(a.instalmentAmount)} a month from ${monthLabel(a.recoverFrom)}`;
        },
      }),
      column.accessor('outstanding', { header: 'Outstanding', cell: (info) => formatRupees(info.getValue()) }),
      column.accessor('status', { header: 'Status', cell: (info) => <AdvanceStatusBadge status={info.getValue()} /> }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => {
          const a = info.row.original;
          const actions: RowAction[] =
            mayGrant && a.status === 'open' && a.staffId !== me.data?.staffId
              ? [{ label: 'Write off', onSelect: () => setWritingOff(a), destructive: true }]
              : [];
          return <RowActions label={a.staffName} actions={actions} />;
        },
      }),
    ];
  }, [mayGrant, me.data?.staffId]);
  return (
    <>
      {mayGrant && (
        <div className="mb-4 flex justify-end">
          <Button onClick={() => setGranting(true)}>Grant an advance</Button>
        </div>
      )}
      <DataTable
        columns={columns}
        query={advances}
        getRowId={(r) => r.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle="No salary advances"
        emptyDescription="An advance is recovered from later payslips in instalments."
      />
      {granting && (
        <GrantDialog
          onClose={() => setGranting(false)}
          onDone={() => {
            setGranting(false);
            toast.success('Advance granted.');
            void queryClient.invalidateQueries({ queryKey: payrollKeys.advances });
          }}
        />
      )}
      <ConfirmWithReasonDialog
        open={writingOff !== null}
        onOpenChange={(open) => !open && setWritingOff(null)}
        title="Write off this advance?"
        description={writingOff ? `${writingOff.staffName}: ${formatRupees(writingOff.outstanding)} will no longer be recovered.` : undefined}
        confirmLabel="Write off"
        minLength={3}
        destructive
        pending={writeOff.isPending}
        onConfirm={(reason) => writingOff && writeOff.mutate({ id: writingOff.id, reason })}
      />
    </>
  );
}

function GrantDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const me = useSchoolMe();
  const [key] = useState(newIdempotencyKey);
  const today = todayInSchool();
  const [form, setForm] = useState({
    staffId: '',
    amount: '',
    instalmentAmount: '',
    grantedOn: today,
    recoverFrom: '',
    paidMethod: 'cash' as CounterPaymentMethod,
    paidReference: '',
    recordAsExpense: true,
  });
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const ids = { staff: useId(), amount: useId(), instalment: useId(), granted: useId(), recover: useId(), method: useId(), ref: useId(), expense: useId() };
  const staff = useQuery({
    queryKey: ['school', 'staff', 'options', 'active'],
    queryFn: () => unwrap(payrollApi.GET('/api/v1/staff', { params: { query: { status: 'active', limit: OPTIONS_LIMIT } } })),
  });
  const amount = Number(form.amount);
  const instalment = Number(form.instalmentAmount);
  const complete = form.staffId !== '' && amount > 0 && instalment > 0 && instalment <= amount;
  const grant = useMutation({
    mutationFn: () =>
      unwrap(
        payrollApi.POST('/api/v1/salary-advances', {
          params: { header: { 'Idempotency-Key': key } },
          body: {
            staffId: form.staffId,
            amount,
            instalmentAmount: instalment,
            grantedOn: form.grantedOn,
            ...(form.recoverFrom === '' ? {} : { recoverFrom: form.recoverFrom }),
            paidMethod: form.paidMethod,
            ...(form.paidReference.trim() === '' ? {} : { paidReference: form.paidReference.trim() }),
            recordAsExpense: form.recordAsExpense,
          },
        }),
      ),
    onSuccess: onDone,
    onError: (e) => setError(refusalMessage(e, PAYROLL_REFUSALS)),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && !grant.isPending && onClose()}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (complete) grant.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Grant a salary advance</DialogTitle>
            <DialogDescription>Recovered from later payslips, oldest advance first, never taking a payslip below zero.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.staff}>Staff member</Label>
            <NativeSelect id={ids.staff} value={form.staffId} onChange={(e) => set({ staffId: e.target.value })}>
              <option value="">Choose…</option>
              {(staff.data?.data ?? [])
                .filter((s) => s.id !== me.data?.staffId)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fullName}
                  </option>
                ))}
            </NativeSelect>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={ids.amount}>Amount (Rs)</Label>
              <Input id={ids.amount} inputMode="numeric" value={form.amount} onChange={(e) => set({ amount: e.target.value.replace(/\D/g, '') })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={ids.instalment}>Monthly instalment (Rs)</Label>
              <Input id={ids.instalment} inputMode="numeric" value={form.instalmentAmount} onChange={(e) => set({ instalmentAmount: e.target.value.replace(/\D/g, '') })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={ids.granted}>Granted on</Label>
              <Input id={ids.granted} type="date" max={today} value={form.grantedOn} onChange={(e) => set({ grantedOn: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={ids.recover}>Recover from (default next month)</Label>
              <Input id={ids.recover} type="month" value={form.recoverFrom} onChange={(e) => set({ recoverFrom: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={ids.method}>Paid by</Label>
              <NativeSelect id={ids.method} value={form.paidMethod} onChange={(e) => set({ paidMethod: e.target.value as CounterPaymentMethod })}>
                {COUNTER_PAYMENT_METHODS.map((value) => (
                  <option key={value} value={value}>
                    {PAYMENT_METHOD_LABELS[value]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={ids.ref}>Reference (optional)</Label>
              <Input id={ids.ref} maxLength={60} value={form.paidReference} onChange={(e) => set({ paidReference: e.target.value })} />
            </div>
          </div>
          <label htmlFor={ids.expense} className="flex items-center gap-2 text-sm">
            <input id={ids.expense} type="checkbox" checked={form.recordAsExpense} onChange={(e) => set({ recordAsExpense: e.target.checked })} />
            Record it as an expense (salary advance)
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={grant.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!complete || grant.isPending}>
              {grant.isPending ? 'Granting…' : 'Grant'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
