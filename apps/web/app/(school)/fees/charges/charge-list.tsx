'use client';

import { Capability, ErrorCode, formatRupees, newIdempotencyKey, yearMonthOf } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { CalendarPlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { CheckboxField } from '@/components/checkbox-field';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { DataTable, type DataTableFeatures, type RowAction, RowActions } from '@/components/data-table';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { FilterSelect } from '@/components/list-filters';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { unwrap } from '@/lib/api/client';
import { ApiError, toastApiError } from '@/lib/api/errors';
import {
  chargesApi,
  type ChargeDto,
  type ChargeKind,
  type ChargeListQuery,
  type ChargeNotOpen,
  type ChargeStatus,
  type MonthNotGeneratable,
} from '@/lib/api/school-charges-contract';
import { formatDate, todayInSchool } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { useCapabilities } from '@/lib/school-session';
import { useYears } from '../../academics/_lib/options';
import {
  CHARGE_KIND_LABELS,
  CHARGE_STATUS_LABELS,
  digitsOnly,
  feesKeys,
  formatMonth,
  rupeesSchema,
  useIsPrincipal,
} from '../_lib/fees-ui';

const LIMIT = 25;

/** Seven days back, school time: the start of "this week" for the voided tile. */
const weekAgo = () => {
  const day = new Date(`${todayInSchool()}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 7);
  return day.toISOString().slice(0, 10);
};

/**
 * Charges (slice 19, R179-R186): the school's receivable rows, newest due first, with the voids,
 * late-fee waivers and credits each role may make, and the month's generation.
 */
export function ChargeList() {
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  const principal = useIsPrincipal();
  const canCreate = can(Capability.CHARGE_CREATE);
  const canGrant = can(Capability.CONCESSION_GRANT);
  const [status, setStatus] = useState<ChargeStatus | ''>('open');
  const [kind, setKind] = useState<ChargeKind | ''>('');
  const [period, setPeriod] = useState('');
  const [page, setPage] = useListPage([status, kind, period]);
  const [voiding, setVoiding] = useState<ChargeDto | null>(null);
  const [waiving, setWaiving] = useState<ChargeDto | null>(null);
  const [adjusting, setAdjusting] = useState<ChargeDto | null>(null);
  const [generating, setGenerating] = useState(false);

  const query: ChargeListQuery = {
    page,
    limit: LIMIT,
    sort: '-dueOn',
    ...(status && { status }),
    ...(kind && { kind }),
    ...(period && { period }),
  };
  const charges = useQuery({
    queryKey: [...feesKeys.charges, 'list', query],
    queryFn: () => unwrap(chargesApi.GET('/api/v1/charges', { params: { query } })),
    placeholderData: keepPreviousData,
  });
  const voidedQuery: ChargeListQuery = { page: 1, limit: 1, status: 'voided', voidedFrom: weekAgo() };
  const voidedThisWeek = useQuery({
    queryKey: [...feesKeys.charges, 'voided-week', voidedQuery],
    queryFn: () => unwrap(chargesApi.GET('/api/v1/charges', { params: { query: voidedQuery } })),
    enabled: principal,
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: feesKeys.all });
  const settle = (error: unknown, close: () => void) => {
    toastApiError(error);
    if (error instanceof ApiError && error.status === 409) {
      refresh();
      close();
    }
  };
  const voidCharge = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(chargesApi.POST('/api/v1/charges/{id}/void', { params: { path: { id } }, body: { reason } })),
    onSuccess: (charge) => {
      toast.success(`${charge.feeHeadName} for ${charge.studentName} voided.`);
      refresh();
      setVoiding(null);
    },
    onError: (error) => settle(error, () => setVoiding(null)),
  });
  const waive = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(chargesApi.POST('/api/v1/charges/{id}/waive', { params: { path: { id } }, body: { reason } })),
    onSuccess: (charge) => {
      toast.success(`Late fee for ${charge.studentName} waived.`);
      refresh();
      setWaiving(null);
    },
    onError: (error) => settle(error, () => setWaiving(null)),
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, ChargeDto>();
    return [
      column.accessor('studentName', {
        header: 'Student',
        cell: (info) => (
          <Link href={`/students/${info.row.original.studentId}`} className="font-medium hover:underline">
            {info.getValue()}
          </Link>
        ),
      }),
      column.accessor('className', {
        header: 'Class',
        cell: (info) => `${info.getValue()} ${info.row.original.sectionName}`,
      }),
      column.accessor('feeHeadName', {
        header: 'Fee',
        cell: (info) => (
          <span className="flex flex-col">
            <span>{info.row.original.description}</span>
            <span className="text-xs text-muted-foreground">{CHARGE_KIND_LABELS[info.row.original.kind]}</span>
          </span>
        ),
      }),
      column.accessor('dueOn', { header: 'Due', cell: (info) => formatDate(info.getValue()) }),
      column.accessor('amount', {
        header: () => <span className="block text-right">Amount</span>,
        cell: (info) => (
          <span className="block text-right tabular-nums">
            {formatRupees(info.getValue())}
            {info.row.original.concessionAmount > 0 && (
              <span className="block text-xs text-muted-foreground">
                after {formatRupees(info.row.original.concessionAmount)} concession
              </span>
            )}
          </span>
        ),
      }),
      column.accessor('outstanding', {
        header: () => <span className="block text-right">Owed</span>,
        cell: (info) => <span className="block text-right tabular-nums">{formatRupees(info.getValue())}</span>,
      }),
      column.accessor('status', {
        header: 'Status',
        cell: (info) => (
          <Badge variant={info.getValue() === 'open' ? 'default' : 'ghost'}>{CHARGE_STATUS_LABELS[info.getValue()]}</Badge>
        ),
      }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => {
          const charge = info.row.original;
          const actions: RowAction[] = [];
          if (charge.status === 'open' && charge.allocatedAmount === 0) {
            const officeVoid = (charge.kind === 'manual' || charge.kind === 'campaign') && canCreate;
            const principalVoid = (charge.kind === 'generated' || charge.kind === 'late_fee') && canGrant && principal;
            if (officeVoid || principalVoid) actions.push({ label: 'Void', onSelect: () => setVoiding(charge), destructive: true });
            if (charge.kind === 'late_fee' && canGrant && principal) actions.push({ label: 'Waive late fee', onSelect: () => setWaiving(charge) });
          }
          if (charge.status === 'open' && charge.kind !== 'adjustment' && canGrant && principal) {
            actions.push({ label: 'Credit…', onSelect: () => setAdjusting(charge) });
          }
          return <RowActions label={`${charge.studentName} ${charge.description}`} actions={actions} />;
        },
      }),
    ];
  }, [canCreate, canGrant, principal]);

  return (
    <>
      {principal && voidedThisWeek.data && (
        <p className="mb-4 text-sm text-muted-foreground">
          Charges voided in the last 7 days: <span className="font-medium text-foreground">{voidedThisWeek.data.total}</span>
        </p>
      )}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <FilterSelect<ChargeStatus | ''> label="Status" value={status} onChange={setStatus}>
            <option value="open">Open</option>
            <option value="settled">Settled</option>
            <option value="voided">Voided</option>
            <option value="waived">Waived</option>
            <option value="">All</option>
          </FilterSelect>
          <FilterSelect<ChargeKind | ''> label="Kind" value={kind} onChange={setKind}>
            <option value="">All</option>
            {(Object.keys(CHARGE_KIND_LABELS) as ChargeKind[]).map((k) => (
              <option key={k} value={k}>
                {CHARGE_KIND_LABELS[k]}
              </option>
            ))}
          </FilterSelect>
          <div className="grid gap-1.5">
            <Label htmlFor="charges-period">Month</Label>
            <Input id="charges-period" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="w-40" />
          </div>
        </div>
        {canCreate && (
          <Button onClick={() => setGenerating(true)}>
            <CalendarPlusIcon />
            Generate a month
          </Button>
        )}
      </div>
      <DataTable
        columns={columns}
        query={charges}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle="No charges match"
        emptyDescription="Monthly charges are generated on the 1st, and every night for students admitted since. Open a student to raise a one-off charge."
      />
      <ConfirmWithReasonDialog
        open={voiding !== null}
        onOpenChange={(open) => !open && setVoiding(null)}
        title={`Void: ${voiding?.description ?? ''}`}
        description="A void says the charge was wrong; it never returns by itself. To forgive a correct charge, give a credit or a concession instead. Its open late fee is voided with it."
        confirmLabel="Void charge"
        minLength={3}
        destructive
        pending={voidCharge.isPending}
        onConfirm={(reason) => voiding && voidCharge.mutate({ id: voiding.id, reason })}
      />
      <ConfirmWithReasonDialog
        open={waiving !== null}
        onOpenChange={(open) => !open && setWaiving(null)}
        title={`Waive late fee: ${waiving?.studentName ?? ''}`}
        confirmLabel="Waive"
        minLength={3}
        pending={waive.isPending}
        onConfirm={(reason) => waiving && waive.mutate({ id: waiving.id, reason })}
      />
      <AdjustDialog charge={adjusting} onClose={() => setAdjusting(null)} />
      <GenerateMonthDialog open={generating} principal={principal && canGrant} onClose={() => setGenerating(false)} />
    </>
  );
}

// ---- Credit (adjustment) ----

const adjustSchema = z.object({ amount: rupeesSchema, reason: z.string().trim().min(3, 'Give a reason.').max(500) });
type AdjustValues = z.infer<typeof adjustSchema>;

function AdjustDialog({ charge, onClose }: { charge: ChargeDto | null; onClose: () => void }) {
  return (
    <Dialog open={charge !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>{charge !== null && <AdjustForm charge={charge} onDone={onClose} />}</DialogContent>
    </Dialog>
  );
}

function AdjustForm({ charge, onDone }: { charge: ChargeDto; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const form = useForm<AdjustValues>({ resolver: zodResolver(adjustSchema), defaultValues: { amount: '', reason: '' } });
  const save = useMutation({
    mutationFn: (values: AdjustValues) =>
      unwrap(
        chargesApi.POST('/api/v1/charges/{id}/adjust', {
          params: { path: { id: charge.id }, header: { 'Idempotency-Key': idempotencyKey } },
          body: { amount: Number(values.amount), reason: values.reason },
        }),
      ),
    onSuccess: (credit) => {
      void queryClient.invalidateQueries({ queryKey: feesKeys.all });
      toast.success(`${formatRupees(credit.amount)} credited to ${charge.studentName}.`);
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.CHARGE_NOT_OPEN) {
        const details = error.details as Partial<ChargeNotOpen> | null;
        if (details?.reason === 'exceeds_outstanding') {
          form.setError('amount', { message: `At most ${formatRupees(details.outstanding ?? 0)}, what is still owed.` }, { shouldFocus: true });
          return;
        }
      }
      if (error instanceof ApiError && error.code === ErrorCode.IDEMPOTENCY_KEY_REUSED) setIdempotencyKey(newIdempotencyKey());
      applyApiError(form, error);
    },
  });
  return (
    <form noValidate className="grid gap-4" onSubmit={form.handleSubmit((v) => save.mutate(v))}>
      <DialogHeader>
        <DialogTitle>Credit: {charge.description}</DialogTitle>
        <DialogDescription>
          {charge.studentName} still owes {formatRupees(charge.outstanding)}. A credit is recorded as its own line; the charge
          itself never changes.
        </DialogDescription>
      </DialogHeader>
      <FormRootError form={form} />
      <FormField control={form.control} name="amount" label="Credit (Rs)" inputMode="numeric" maxLength={8} format={digitsOnly} autoFocus />
      <FormField control={form.control} name="reason" label="Reason" maxLength={500} />
      <DialogFooter>
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Give credit'}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---- Generate a month ----

const generateSchema = z.object({
  academicYearId: z.string().min(1, 'Pick a year.'),
  period: z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/, 'Pick a month.'),
  regenerateVoided: z.boolean(),
});
type GenerateValues = z.infer<typeof generateSchema>;

const NOT_GENERATABLE: Record<MonthNotGeneratable['reason'], string> = {
  future: 'That month has not started yet.',
  outside_year: 'That month is outside the academic year.',
  year_closed: 'That academic year is closed.',
};

function GenerateMonthDialog({ open, principal, onClose }: { open: boolean; principal: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>{open && <GenerateMonthForm principal={principal} onDone={onClose} />}</DialogContent>
    </Dialog>
  );
}

function GenerateMonthForm({ principal, onDone }: { principal: boolean; onDone: () => void }) {
  const queryClient = useQueryClient();
  const years = useYears();
  const options = (years.data?.data ?? [])
    .filter((y) => y.status !== 'closed')
    .map((y) => ({ value: y.id, label: y.name }));
  const active = years.data?.data.find((y) => y.status === 'active');
  const form = useForm<GenerateValues>({
    resolver: zodResolver(generateSchema),
    values: { academicYearId: active?.id ?? '', period: yearMonthOf(todayInSchool()), regenerateVoided: false },
  });
  const generate = useMutation({
    mutationFn: (values: GenerateValues) =>
      unwrap(
        chargesApi.POST('/api/v1/charges/generate-month', {
          body: { academicYearId: values.academicYearId, period: values.period, ...(values.regenerateVoided && { regenerateVoided: true }) },
        }),
      ),
    onSuccess: (run) => {
      void queryClient.invalidateQueries({ queryKey: feesKeys.runs });
      toast.success(`${formatMonth(run.period)} is being generated. Follow it under Generation runs.`);
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.MONTH_NOT_GENERATABLE) {
        const reason = (error.details as Partial<MonthNotGeneratable> | null)?.reason;
        form.setError('period', { message: reason ? NOT_GENERATABLE[reason] : error.message }, { shouldFocus: true });
        return;
      }
      applyApiError(form, error);
    },
  });
  return (
    <form noValidate className="grid gap-4" onSubmit={form.handleSubmit((v) => generate.mutate(v))}>
      <DialogHeader>
        <DialogTitle>Generate a month</DialogTitle>
        <DialogDescription>
          Charges every enrolled student the month’s fees once. Running it again charges only students who have none yet.
        </DialogDescription>
      </DialogHeader>
      <FormRootError form={form} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField control={form.control} name="academicYearId" label="Academic year" options={options} />
        <FormField control={form.control} name="period" label="Month" type="month" />
      </div>
      {principal && (
        <CheckboxField
          control={form.control}
          name="regenerateVoided"
          label="Recreate voided charges"
          hint="After voiding charges raised from a wrong amount and fixing the fee structure."
        />
      )}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={generate.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={generate.isPending}>
          {generate.isPending ? 'Starting…' : 'Generate'}
        </Button>
      </DialogFooter>
    </form>
  );
}
