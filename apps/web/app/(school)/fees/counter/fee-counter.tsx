'use client';

import { COUNTER_PAYMENT_METHODS, ErrorCode, formatRupees, newIdempotencyKey, PAYMENT_METHOD_LABELS } from '@asms/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PrinterIcon, SearchIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, ErrorState, LoadingState, QueryStates, StateCard } from '@/components/page-states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import { ApiError, toastApiError } from '@/lib/api/errors';
import { guardiansApi } from '@/lib/api/school-guardians-contract';
import {
  paymentsApi,
  receiptPrintUrl,
  type CounterPaymentMethod,
  type GuardianChildDuesDto,
  type PaymentDto,
  type PaymentIntent,
  type PaymentPreviewDto,
} from '@/lib/api/school-payments-contract';
import { formatDate, todayInSchool } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { digitsOnly, feesKeys, formatMonth } from '../_lib/fees-ui';

/**
 * The counter (slice 20, R187-R190): find the guardian, see the family's dues grouped by academic
 * year, name the children and the amount, preview where the money goes (advances first, then the
 * oldest dues), save, print. One academic year per payment: arrears of a past year are a second
 * payment.
 */
export function FeeCounter() {
  const [guardianId, setGuardianId] = useState<string | null>(null);
  const [done, setDone] = useState<PaymentDto | null>(null);

  if (done) {
    return (
      <StateCard>
        <div className="grid gap-4">
          <p className="text-lg font-medium">
            Receipt {done.receipt?.receiptLabel}: {formatRupees(done.amount)} from {done.payerName}
          </p>
          {done.possibleDuplicate && (
            <Alert>
              <AlertDescription>The same method, reference and date were recorded before. Check it is not the same slip twice.</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            {done.receipt && (
              <a className={buttonVariants()} href={receiptPrintUrl(done.receipt.id)} target="_blank" rel="noopener noreferrer">
                <PrinterIcon />
                Print receipt
              </a>
            )}
            <Button variant="outline" onClick={() => setDone(null)}>
              Same family again
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setDone(null);
                setGuardianId(null);
              }}
            >
              Next family
            </Button>
          </div>
        </div>
      </StateCard>
    );
  }
  if (guardianId === null) return <GuardianSearch onPick={setGuardianId} />;
  return <FamilyDues guardianId={guardianId} onBack={() => setGuardianId(null)} onDone={setDone} />;
}

function GuardianSearch({ onPick }: { onPick: (id: string) => void }) {
  const [text, setText] = useState('');
  const q = useDebounced(text.trim());
  const query = { q, limit: 10, status: 'active' as const };
  const found = useQuery({
    queryKey: ['school', 'guardians', 'counter', query],
    queryFn: () => unwrap(guardiansApi.GET('/api/v1/guardians', { params: { query } })),
    enabled: q.length >= 2,
  });
  return (
    <div className="grid max-w-xl gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="counter-search">Guardian</Label>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input
            id="counter-search"
            className="pl-8"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Name or phone digits"
            autoFocus
          />
        </div>
      </div>
      {q.length < 2 ? (
        <p className="text-sm text-muted-foreground">Type at least two letters of the guardian’s name, or phone digits.</p>
      ) : found.isPending ? (
        <LoadingState rows={3} />
      ) : found.error ? (
        <ErrorState error={found.error} onRetry={() => void found.refetch()} />
      ) : found.data.data.length === 0 ? (
        <EmptyState title="No guardian found" description="Check the spelling, or search by phone digits." />
      ) : (
        <ul className="grid gap-2">
          {found.data.data.map((g) => (
            <li key={g.id}>
              <button
                type="button"
                className="w-full rounded-md border p-3 text-left hover:bg-muted"
                onClick={() => onPick(g.id)}
              >
                <span className="font-medium">{g.fullName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FamilyDues({ guardianId, onBack, onDone }: { guardianId: string; onBack: () => void; onDone: (p: PaymentDto) => void }) {
  const dues = useQuery({
    queryKey: [...feesKeys.all, 'dues', guardianId],
    queryFn: () => unwrap(paymentsApi.GET('/api/v1/guardians/{id}/dues', { params: { path: { id: guardianId } } })),
  });
  return (
    <QueryStates query={dues} notFound={{ title: 'Guardian not found', description: 'Search again.' }}>
      {(data) => (
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-medium">{data.fullName}</h2>
            <Button variant="outline" onClick={onBack}>
              Another guardian
            </Button>
          </div>
          {data.children.length === 0 ? (
            <EmptyState title="No children linked" description="This guardian has no live link to a student." />
          ) : (
            <PaymentForm guardianId={guardianId} rows={data.children} onDone={onDone} />
          )}
        </div>
      )}
    </QueryStates>
  );
}

function PaymentForm({ guardianId, rows, onDone }: { guardianId: string; rows: GuardianChildDuesDto[]; onDone: (p: PaymentDto) => void }) {
  const queryClient = useQueryClient();
  const years = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; owed: number; closed: boolean }>();
    for (const r of rows) {
      const y = seen.get(r.academicYearId) ?? { id: r.academicYearId, name: r.academicYearName, owed: 0, closed: r.academicYearClosed };
      y.owed += r.outstanding;
      seen.set(r.academicYearId, y);
    }
    return [...seen.values()];
  }, [rows]);
  const [yearId, setYearId] = useState(years.find((y) => y.owed > 0)?.id ?? years[0]?.id ?? '');
  const children = rows.filter((r) => r.academicYearId === yearId);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(children.filter((c) => c.outstanding > 0).map((c) => c.studentId)));
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<CounterPaymentMethod>('cash');
  const [reference, setReference] = useState('');
  const [receivedOn, setReceivedOn] = useState(todayInSchool());
  const [advanceFor, setAdvanceFor] = useState('');
  const [preview, setPreview] = useState<PaymentPreviewDto | null>(null);
  const [key, setKey] = useState(newIdempotencyKey);
  const [error, setError] = useState<string | null>(null);

  const studentIds = children.map((c) => c.studentId).filter((id) => picked.has(id));
  const intent: PaymentIntent = { academicYearId: yearId, payerGuardianId: guardianId, studentIds, amount: Number(amount) };
  const ready = studentIds.length > 0 && Number(amount) > 0;
  const nameOf = (id: string) => rows.find((r) => r.studentId === id)?.fullName ?? '';

  const changed = () => {
    setPreview(null);
    setError(null);
  };
  const runPreview = useMutation({
    mutationFn: () => unwrap(paymentsApi.POST('/api/v1/payments/preview', { body: intent })),
    onSuccess: setPreview,
    onError: (e) => setError(e instanceof ApiError ? e.message : 'The preview failed.'),
  });
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        paymentsApi.POST('/api/v1/payments', {
          params: { header: { 'Idempotency-Key': key } },
          body: {
            ...intent,
            method,
            receivedOn,
            ...(method !== 'cash' && { reference: reference.trim() }),
            ...(advanceFor && { advanceForStudentId: advanceFor }),
          },
        }),
      ),
    onSuccess: (payment) => {
      void queryClient.invalidateQueries({ queryKey: feesKeys.all });
      toast.success(`Receipt ${payment.receipt?.receiptLabel ?? ''} recorded.`);
      onDone(payment);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === ErrorCode.IDEMPOTENCY_KEY_REUSED) setKey(newIdempotencyKey());
      if (e instanceof ApiError && (e.status === 409 || e.status === 422)) {
        const field = (e.details as { fields?: { message: string }[] } | null)?.fields?.[0]?.message;
        setError(field ?? e.message);
        return;
      }
      toastApiError(e);
    },
  });

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="grid gap-4">
        {years.length > 1 && (
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Academic year">
            {years.map((y) => (
              <Button
                key={y.id}
                role="radio"
                aria-checked={y.id === yearId}
                variant={y.id === yearId ? 'default' : 'outline'}
                onClick={() => {
                  setYearId(y.id);
                  setPicked(new Set(rows.filter((r) => r.academicYearId === y.id && r.outstanding > 0).map((r) => r.studentId)));
                  changed();
                }}
              >
                {y.name} · owes {formatRupees(y.owed)}
                {y.closed && ' (closed)'}
              </Button>
            ))}
          </div>
        )}
        {children.map((child) => (
          <section key={child.studentId} className="rounded-md border p-3">
            <label className="flex items-center gap-2 font-medium">
              <input
                type="checkbox"
                checked={picked.has(child.studentId)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(child.studentId);
                  else next.delete(child.studentId);
                  setPicked(next);
                  changed();
                }}
              />
              {child.fullName}
              <span className="text-sm font-normal text-muted-foreground">{child.className}</span>
              <span className="ml-auto tabular-nums">owes {formatRupees(child.outstanding)}</span>
            </label>
            {child.advance > 0 && (
              <p className="mt-1 text-sm text-muted-foreground">Advance held: {formatRupees(child.advance)} (spent first)</p>
            )}
            {child.openCharges.length > 0 && (
              <Table className="mt-2">
                <TableBody>
                  {child.openCharges.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>{c.description}</TableCell>
                      <TableCell>Due {formatDate(c.dueOn)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatRupees(c.outstanding)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>
        ))}
      </div>
      <form
        noValidate
        className="grid content-start gap-4 rounded-md border p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (preview) save.mutate();
          else if (ready) runPreview.mutate();
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="counter-amount">Amount (Rs)</Label>
          <Input
            id="counter-amount"
            inputMode="numeric"
            maxLength={8}
            value={amount}
            onChange={(e) => {
              setAmount(digitsOnly(e.target.value));
              changed();
            }}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="counter-method">Method</Label>
          <NativeSelect
            id="counter-method"
            value={method}
            onChange={(e) => {
              setMethod(e.target.value as CounterPaymentMethod);
              changed();
            }}
          >
            {COUNTER_PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABELS[m]}
              </option>
            ))}
          </NativeSelect>
        </div>
        {method !== 'cash' && (
          <div className="grid gap-1.5">
            <Label htmlFor="counter-reference">Slip reference</Label>
            <Input id="counter-reference" maxLength={60} value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor="counter-date">Received on</Label>
          <Input id="counter-date" type="date" max={todayInSchool()} value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
        </div>
        {studentIds.length > 1 && (
          <div className="grid gap-1.5">
            <Label htmlFor="counter-advance">Any money left over is an advance for</Label>
            <NativeSelect id="counter-advance" value={advanceFor} onChange={(e) => setAdvanceFor(e.target.value)}>
              <option value="">Choose if asked</option>
              {studentIds.map((id) => (
                <option key={id} value={id}>
                  {nameOf(id)}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
        {preview && (
          <div className="grid gap-2 text-sm">
            <p className="font-medium">Where the money goes</p>
            <ul className="grid gap-1">
              {preview.allocations.map((a) => (
                <li key={`${a.chargeId}-${a.fromAdvance}`} className="flex justify-between gap-2">
                  <span>
                    {a.studentName}: {a.feeHeadName} {a.period ? formatMonth(a.period) : ''}
                    {a.fromAdvance && (
                      <Badge variant="ghost" className="ml-1">
                        advance
                      </Badge>
                    )}
                  </span>
                  <span className="tabular-nums">{formatRupees(a.amount)}</span>
                </li>
              ))}
            </ul>
            {preview.remainder > 0 && <p>Left over as an advance: {formatRupees(preview.remainder)}</p>}
          </div>
        )}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" disabled={!ready || runPreview.isPending || save.isPending}>
          {save.isPending ? 'Saving…' : preview ? `Save ${formatRupees(Number(amount))}` : runPreview.isPending ? 'Checking…' : 'Preview'}
        </Button>
      </form>
    </div>
  );
}
