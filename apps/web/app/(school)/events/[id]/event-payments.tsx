'use client';

import { Capability, ErrorCode, MAX_RUPEES, formatRupees, newIdempotencyKey, todayInSchool } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { ErrorState, LoadingState } from '@/components/page-states';
import { TablePagination } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { OPTIONS_LIMIT, unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { chargesApi } from '@/lib/api/school-charges-contract';
import { eventsApi, type EventDto } from '@/lib/api/school-events-contract';
import { formatDay } from '@/lib/format';
import { useCapabilities } from '@/lib/school-session';
import { allPages } from '../../academics/_lib/options';
import { digitsOnly } from '../../fees/_lib/fees-ui';
import { eventErrorMessage, eventKeys } from '../_lib/events-ui';
import { useEventRoster } from './event-participation';

// contracts/slice-38.md §2.7, R317: a collection-duty holder (their own payments) or a
// payment.record holder (all) lists the event's payments and records a cash payment against one
// child's event charge, never more than it still owes, with an Idempotency-Key per opening of the
// form. The children with something owing come from the roster; a payment.record holder the
// roster does not reach reads them from the campaign's charges instead.

const LIMIT = 25;

type Payable = { studentId: string; label: string; outstanding: number };

/** The children who still owe on the event charge. */
function usePayable(e: EventDto) {
  const { can } = useCapabilities();
  const roster = useEventRoster(e.id);
  const canReadCharges = can(Capability.FEE_STATEMENT_VIEW) || can(Capability.CHARGE_CREATE);
  const charges = useQuery({
    queryKey: eventKeys.payable(e.id),
    queryFn: () =>
      allPages((page) =>
        unwrap(
          chargesApi.GET('/api/v1/charges', {
            params: { query: { campaignId: e.campaignId!, status: 'open', page, limit: OPTIONS_LIMIT } },
          }),
        ),
      ),
    enabled: roster.data === null && canReadCharges,
  });
  if (roster.isPending) return { isPending: true as const, rows: [] as Payable[] };
  if (roster.data) {
    return {
      isPending: false as const,
      rows: roster.data.rows
        .filter((r) => r.charge !== null && r.charge.outstanding > 0)
        .map((r) => ({ studentId: r.studentId, label: `${r.fullName} · ${r.className} ${r.sectionName}`, outstanding: r.charge!.outstanding })),
    };
  }
  if (!canReadCharges) return { isPending: false as const, rows: [] as Payable[] };
  if (charges.isPending) return { isPending: true as const, rows: [] as Payable[] };
  return {
    isPending: false as const,
    rows: (charges.data ?? [])
      .filter((c) => c.outstanding > 0)
      .map((c) => ({ studentId: c.studentId, label: `${c.studentName} · ${c.className} ${c.sectionName}`, outstanding: c.outstanding })),
  };
}

export function EventPayments({ event: e }: { event: EventDto }) {
  const [page, setPage] = useState(1);
  const payments = useQuery({
    queryKey: [...eventKeys.payments(e.id), page],
    queryFn: () => unwrap(eventsApi.GET('/api/v1/events/{id}/payments', { params: { path: { id: e.id }, query: { page, limit: LIMIT } } })),
    placeholderData: keepPreviousData,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Event payments</CardTitle>
        <CardDescription>
          Cash taken for this event goes to the child’s event charge only. A collector hands the cash to the office afterwards.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {e.status === 'published' && <RecordPayment event={e} />}
        {payments.isPending ? (
          <LoadingState rows={3} />
        ) : payments.isError ? (
          <ErrorState error={payments.error} onRetry={() => void payments.refetch()} />
        ) : payments.data.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No payments taken for this event yet.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table aria-label="Event payments">
                <TableHeader>
                  <TableRow>
                    <TableHead>Receipt</TableHead>
                    <TableHead>Student</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Received</TableHead>
                    <TableHead>Taken by</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.data.data.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="tabular-nums">
                        {p.receipt?.receiptLabel ?? '—'}
                        {p.status === 'voided' && (
                          <Badge variant="ghost" className="ml-2">
                            Voided
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>{p.students.map((s) => s.fullName).join(', ')}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatRupees(p.amount)}</TableCell>
                      <TableCell>{formatDay(p.receivedOn)}</TableCell>
                      <TableCell>{p.recordedByName}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <TablePagination
              page={page}
              limit={LIMIT}
              total={payments.data.total}
              loading={payments.isPlaceholderData}
              onPageChange={setPage}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RecordPayment({ event: e }: { event: EventDto }) {
  const queryClient = useQueryClient();
  const payable = usePayable(e);
  const studentId = useId();
  const amountId = useId();
  const referenceId = useId();
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [student, setStudent] = useState('');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const chosen = payable.rows.find((r) => r.studentId === student);
  const value = Number(amount);
  const amountProblem =
    amount === '' || !chosen
      ? null
      : value < 1 || value > MAX_RUPEES
        ? 'Enter a whole number of rupees.'
        : value > chosen.outstanding
          ? `No more than ${formatRupees(chosen.outstanding)}, what the child still owes.`
          : null;

  const record = useMutation({
    mutationFn: () =>
      unwrap(
        eventsApi.POST('/api/v1/events/{id}/payments', {
          params: { path: { id: e.id }, header: { 'Idempotency-Key': idempotencyKey } },
          body: { studentId: student, amount: value, receivedOn: todayInSchool(), ...(reference.trim() && { reference: reference.trim() }) },
        }),
      ),
    onMutate: () => setProblem(null),
    onSuccess: (payment) => {
      toast.success(`${formatRupees(payment.amount)} received${payment.receipt ? `, receipt ${payment.receipt.receiptLabel}` : ''}.`);
      setIdempotencyKey(newIdempotencyKey());
      setStudent('');
      setAmount('');
      setReference('');
      void queryClient.invalidateQueries({ queryKey: eventKeys.payments(e.id) });
      void queryClient.invalidateQueries({ queryKey: eventKeys.roster(e.id) });
      void queryClient.invalidateQueries({ queryKey: eventKeys.payable(e.id) });
      void queryClient.invalidateQueries({ queryKey: eventKeys.report(e.id) });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.IDEMPOTENCY_KEY_REUSED) setIdempotencyKey(newIdempotencyKey());
      setProblem(eventErrorMessage(error));
      void queryClient.invalidateQueries({ queryKey: eventKeys.roster(e.id) });
      void queryClient.invalidateQueries({ queryKey: eventKeys.payable(e.id) });
    },
  });

  if (!payable.isPending && payable.rows.length === 0) {
    return <p className="text-sm text-muted-foreground">Nobody owes anything for this event.</p>;
  }
  return (
    <form
      className="grid gap-3 sm:grid-cols-[1fr_9rem_10rem_auto] sm:items-end"
      aria-label="Take a payment"
      onSubmit={(event) => {
        event.preventDefault();
        if (chosen && amount !== '' && !amountProblem) record.mutate();
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={studentId}>Student</Label>
        <NativeSelect
          id={studentId}
          value={student}
          disabled={payable.isPending}
          onChange={(event) => {
            setStudent(event.target.value);
            const row = payable.rows.find((r) => r.studentId === event.target.value);
            setAmount(row ? String(row.outstanding) : '');
          }}
        >
          <option value="">{payable.isPending ? 'Loading…' : 'Choose a student'}</option>
          {payable.rows.map((r) => (
            <option key={r.studentId} value={r.studentId}>
              {r.label} · owes {formatRupees(r.outstanding)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={amountId}>Amount (Rs)</Label>
        <Input
          id={amountId}
          inputMode="numeric"
          autoComplete="off"
          value={amount}
          aria-invalid={amountProblem ? true : undefined}
          onChange={(event) => setAmount(digitsOnly(event.target.value))}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={referenceId}>Slip no. (optional)</Label>
        <Input id={referenceId} maxLength={60} autoComplete="off" value={reference} onChange={(event) => setReference(event.target.value)} />
      </div>
      <Button type="submit" disabled={!chosen || amount === '' || amountProblem !== null || record.isPending}>
        {record.isPending ? 'Recording…' : 'Record cash'}
      </Button>
      {(amountProblem ?? problem) && (
        <p role="alert" className="text-sm text-destructive sm:col-span-4">
          {amountProblem ?? problem}
        </p>
      )}
    </form>
  );
}
