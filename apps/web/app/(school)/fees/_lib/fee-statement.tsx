'use client';

import { Capability, formatRupees, newIdempotencyKey, yearMonthOf } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { TablePagination } from '@/components/data-table';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { QueryStates } from '@/components/page-states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { OPTIONS_LIMIT, unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { chargesApi } from '@/lib/api/school-charges-contract';
import { feesApi } from '@/lib/api/school-fees-contract';
import type { StudentDetailDto } from '@/lib/api/school-students-contract';
import { formatDate, todayInSchool } from '@/lib/format';
import { useCapabilities } from '@/lib/school-session';
import { concessionTerms } from '../concessions/concession-queue';
import {
  CHARGE_KIND_LABELS,
  CHARGE_STATUS_LABELS,
  CONCESSION_STATUS_LABELS,
  digitsOnly,
  feesKeys,
  formatMonth,
  rupeesSchema,
} from './fees-ui';

const LIMIT = 25;

/**
 * A student's fee statement (slice 19, R205) on their record: every charge with both dates, the
 * credits and concessions, and the totals; the office raises a one-off charge or requests a
 * concession from here.
 */
export function FeeStatementTab({ student }: { student: StudentDetailDto }) {
  const { can } = useCapabilities();
  const [page, setPage] = useState(1);
  const [raising, setRaising] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const statement = useQuery({
    queryKey: [...feesKeys.statement(student.id), page],
    queryFn: () =>
      unwrap(chargesApi.GET('/api/v1/students/{id}/fee-statement', { params: { path: { id: student.id }, query: { page, limit: LIMIT } } })),
    placeholderData: keepPreviousData,
  });
  const current = student.current;
  const canCreate = can(Capability.CHARGE_CREATE) && current !== null && (student.status === 'active' || student.status === 'suspended');

  return (
    <QueryStates query={statement}>
      {(data) => (
        <div className="grid gap-6">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-6">
            {(
              [
                ['Charged', data.totals.charged],
                ['Concession', data.totals.concession],
                ['Credits', data.totals.adjustments],
                ['Paid', data.totals.paid],
                ['Owed', data.totals.outstanding],
                ['Advance', data.totals.advance],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="rounded-md border p-3">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="text-lg font-medium tabular-nums">{formatRupees(value)}</dd>
              </div>
            ))}
          </dl>
          {canCreate && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setRaising(true)}>
                Raise a charge
              </Button>
              <Button variant="outline" onClick={() => setRequesting(true)}>
                Request a concession
              </Button>
            </div>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fee</TableHead>
                <TableHead>Due</TableHead>
                <TableHead>Raised</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Owed</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.charges.data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground">
                    No charges in this year yet.
                  </TableCell>
                </TableRow>
              )}
              {data.charges.data.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    {c.description}
                    <span className="block text-xs text-muted-foreground">{CHARGE_KIND_LABELS[c.kind]}</span>
                  </TableCell>
                  <TableCell>{formatDate(c.dueOn)}</TableCell>
                  <TableCell>{formatDate(c.createdAt)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatRupees(c.amount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatRupees(c.outstanding)}</TableCell>
                  <TableCell>
                    <Badge variant={c.status === 'open' ? 'default' : 'ghost'}>{CHARGE_STATUS_LABELS[c.status]}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <TablePagination page={page} limit={LIMIT} total={data.charges.total} loading={statement.isFetching} onPageChange={setPage} />
          {data.payments.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-medium">Payments</h3>
              <ul className="grid gap-1 text-sm">
                {data.payments.map((p) => (
                  <li key={p.paymentId}>
                    {formatDate(p.receivedOn)}: {formatRupees(p.allocated)} of {formatRupees(p.amount)}
                    {p.receiptLabel === null ? ' (carried forward)' : `, receipt ${p.receiptLabel}`}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.adjustments.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-medium">Credits</h3>
              <ul className="grid gap-1 text-sm">
                {data.adjustments.map((a) => (
                  <li key={a.id}>
                    {formatRupees(a.amount)} — {a.description} ({formatDate(a.createdAt)})
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.concessions.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-medium">Concessions</h3>
              <ul className="grid gap-1 text-sm">
                {data.concessions.map((c) => (
                  <li key={c.id}>
                    {concessionTerms(c)} on {c.heads.map((h) => h.name).join(', ')} from {formatMonth(c.effectiveFrom)} ·{' '}
                    {CONCESSION_STATUS_LABELS[c.status]}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {current && (
            <>
              <Dialog open={raising} onOpenChange={setRaising}>
                <DialogContent>
                  {raising && <RaiseChargeForm student={student} enrolmentId={current.enrolmentId} onDone={() => setRaising(false)} />}
                </DialogContent>
              </Dialog>
              <Dialog open={requesting} onOpenChange={setRequesting}>
                <DialogContent>
                  {requesting && (
                    <RequestConcessionForm student={student} academicYearId={current.academicYearId} onDone={() => setRequesting(false)} />
                  )}
                </DialogContent>
              </Dialog>
            </>
          )}
        </div>
      )}
    </QueryStates>
  );
}

function useHeadOptions(filter: (h: { frequency: string; concessionEligible: boolean }) => boolean) {
  const query = { status: 'active', limit: OPTIONS_LIMIT, sort: 'name' } as const;
  const heads = useQuery({
    queryKey: [...feesKeys.heads, 'options'],
    queryFn: () => unwrap(feesApi.GET('/api/v1/fee-heads', { params: { query } })),
  });
  return (heads.data?.data ?? []).filter(filter).map((h) => ({ value: h.id, label: h.name }));
}

const chargeSchema = z.object({
  feeHeadId: z.string().min(1, 'Pick a fee head.'),
  amount: rupeesSchema.refine((v) => Number(v) >= 1, 'Enter an amount.'),
  dueOn: z.string().min(1, 'Pick a due date.'),
  description: z.string().trim().min(1, 'Say what it is for.').max(200),
});
type ChargeValues = z.infer<typeof chargeSchema>;

function RaiseChargeForm({ student, enrolmentId, onDone }: { student: StudentDetailDto; enrolmentId: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const options = [{ value: '', label: 'Choose…' }, ...useHeadOptions(() => true)];
  const form = useForm<ChargeValues>({
    resolver: zodResolver(chargeSchema),
    defaultValues: { feeHeadId: '', amount: '', dueOn: todayInSchool(), description: '' },
  });
  const save = useMutation({
    mutationFn: (v: ChargeValues) =>
      unwrap(
        chargesApi.POST('/api/v1/charges', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: { enrolmentId, feeHeadId: v.feeHeadId, amount: Number(v.amount), dueOn: v.dueOn, description: v.description },
        }),
      ),
    onSuccess: (c) => {
      void queryClient.invalidateQueries({ queryKey: feesKeys.all });
      toast.success(`${formatRupees(c.amount)} charged to ${student.fullName}.`);
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'IDEMPOTENCY_KEY_REUSED') setIdempotencyKey(newIdempotencyKey());
      applyApiError(form, error);
    },
  });
  return (
    <form noValidate className="grid gap-4" onSubmit={form.handleSubmit((v) => save.mutate(v))}>
      <DialogHeader>
        <DialogTitle>Raise a charge: {student.fullName}</DialogTitle>
        <DialogDescription>A one-off charge, such as a fine or a trip. Monthly fees are generated by themselves.</DialogDescription>
      </DialogHeader>
      <FormRootError form={form} />
      <FormField control={form.control} name="description" label="What it is for" maxLength={200} autoFocus />
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField control={form.control} name="feeHeadId" label="Fee head" options={options} />
        <FormField control={form.control} name="amount" label="Amount (Rs)" inputMode="numeric" maxLength={8} format={digitsOnly} />
        <FormField control={form.control} name="dueOn" label="Due on" type="date" />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Raise charge'}
        </Button>
      </DialogFooter>
    </form>
  );
}

const concessionSchema = z
  .object({
    feeHeadId: z.string().min(1, 'Pick a fee head.'),
    kind: z.enum(['percentage', 'fixed']),
    value: z.string().regex(/^\d+$/, 'Enter a whole number.'),
    effectiveFrom: z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/, 'Pick a month.'),
    reason: z.string().trim().min(3, 'Give a reason.').max(500),
  })
  .refine((v) => Number(v.value) >= 1 && (v.kind === 'fixed' || Number(v.value) <= 100), {
    path: ['value'],
    message: 'A percentage is 1 to 100; a fixed amount at least 1.',
  });
type ConcessionValues = z.infer<typeof concessionSchema>;

function RequestConcessionForm({ student, academicYearId, onDone }: { student: StudentDetailDto; academicYearId: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  // The form pre-selects tuition only (rule 19); a fine is never offered.
  const options = useHeadOptions((h) => h.concessionEligible);
  const form = useForm<ConcessionValues>({
    resolver: zodResolver(concessionSchema),
    values: { feeHeadId: options[0]?.value ?? '', kind: 'percentage', value: '', effectiveFrom: yearMonthOf(todayInSchool()), reason: '' },
    resetOptions: { keepDirtyValues: true },
  });
  const save = useMutation({
    mutationFn: (v: ConcessionValues) =>
      unwrap(
        chargesApi.POST('/api/v1/concessions', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: {
            studentId: student.id,
            academicYearId,
            kind: v.kind,
            value: Number(v.value),
            feeHeadIds: [v.feeHeadId],
            effectiveFrom: v.effectiveFrom,
            reason: v.reason,
          },
        }),
      ),
    onSuccess: (c) => {
      void queryClient.invalidateQueries({ queryKey: feesKeys.all });
      toast.success(c.status === 'approved' ? 'Concession approved.' : 'Concession requested. A principal decides it.');
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'IDEMPOTENCY_KEY_REUSED') setIdempotencyKey(newIdempotencyKey());
      applyApiError(form, error);
    },
  });
  return (
    <form noValidate className="grid gap-4" onSubmit={form.handleSubmit((v) => save.mutate(v))}>
      <DialogHeader>
        <DialogTitle>Request a concession: {student.fullName}</DialogTitle>
        <DialogDescription>A fixed amount comes off each charge of the head; a percentage is rounded down.</DialogDescription>
      </DialogHeader>
      <FormRootError form={form} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField control={form.control} name="feeHeadId" label="Fee head" options={options} />
        <FormField
          control={form.control}
          name="kind"
          label="Kind"
          options={[
            { value: 'percentage', label: 'Percentage' },
            { value: 'fixed', label: 'Fixed amount (Rs)' },
          ]}
        />
        <FormField control={form.control} name="value" label="Value" inputMode="numeric" maxLength={8} format={digitsOnly} />
        <FormField control={form.control} name="effectiveFrom" label="From month" type="month" />
      </div>
      <FormField control={form.control} name="reason" label="Reason" maxLength={500} />
      <DialogFooter>
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Request'}
        </Button>
      </DialogFooter>
    </form>
  );
}
