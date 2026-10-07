'use client';

import { DEPOSIT_METHODS, ErrorCode, formatRupees, newIdempotencyKey, PAYMENT_METHOD_LABELS } from '@asms/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, LoadingState, QueryStates, StateCard } from '@/components/page-states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { unwrap } from '@/lib/api/client';
import { ApiError, toastApiError } from '@/lib/api/errors';
import {
  claimsApi,
  CLAIM_STATUS_LABELS,
  myClaimImageUrl,
  uploadSlip,
  type DepositMethod,
  type MyClaimDto,
  type MyReceiptDto,
} from '@/lib/api/school-claims-contract';
import { formatDate, todayInSchool } from '@/lib/format';
import { useSchoolMe } from '@/lib/school-session';
import { ACCEPT_ATTRIBUTE, ACCEPTED_TYPES, MAX_UPLOAD_BYTES } from '../students/_lib/documents';
import { digitsOnly, formatMonth } from '../fees/_lib/fees-ui';

const myFeesKey = ['school', 'my-fees'] as const;

/**
 * A guardian's children's fees (phase-3-financial.md slice 21, R198): per child what is owed and
 * when, the deposit slips sent and what became of them, and the family's receipts (their own
 * children's lines only). A parent who paid at a bank or by wallet sends the slip here; the office
 * verifies it and the receipt follows. Only the parent who sent a slip sees its picture.
 */
export function MyChildrenFees() {
  const me = useSchoolMe();
  const children = me.data?.children ?? [];
  if (me.isPending) return <LoadingState />;
  if (children.length === 0) {
    return (
      <StateCard>
        <EmptyState title="No children are linked to your account" description="Ask the school office." />
      </StateCard>
    );
  }
  return (
    <div className="grid gap-6">
      <WhereToPay />
      {children.map((child) => (
        <ChildFees key={child.studentId} studentId={child.studentId} name={child.fullName} />
      ))}
      <Receipts />
    </div>
  );
}

function WhereToPay() {
  const accounts = useQuery({
    queryKey: [...myFeesKey, 'accounts'],
    queryFn: () => unwrap(claimsApi.GET('/api/v1/me/payment-accounts', { params: { query: { page: 1, limit: 50 } } })),
  });
  if (!accounts.data || accounts.data.data.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Where to pay</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-1 text-sm">
          {accounts.data.data.map((a) => (
            <li key={a.id}>
              <span className="font-medium">{a.bankName ?? (a.kind === 'jazzcash' ? 'JazzCash' : a.kind === 'easypaisa' ? 'Easypaisa' : 'Bank')}</span>{' '}
              {a.accountNo} · {a.title}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-sm text-muted-foreground">After paying, send the slip below. Cash is paid at the school office.</p>
      </CardContent>
    </Card>
  );
}

function ChildFees({ studentId, name }: { studentId: string; name: string }) {
  const [sending, setSending] = useState(false);
  const dues = useQuery({
    queryKey: [...myFeesKey, 'dues', studentId],
    queryFn: () => unwrap(claimsApi.GET('/api/v1/me/children/{id}/dues', { params: { path: { id: studentId } } })),
  });
  const claims = useQuery({
    queryKey: [...myFeesKey, 'claims', studentId],
    queryFn: () =>
      unwrap(claimsApi.GET('/api/v1/me/children/{id}/payment-claims', { params: { path: { id: studentId }, query: { page: 1, limit: 10 } } })),
  });
  return (
    <Card data-testid={`myFees.child.${studentId}`}>
      <CardHeader>
        <CardTitle>{name}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <QueryStates query={dues} loadingRows={3}>
          {(d) => (
            <div className="grid gap-3">
              <p className="text-sm">
                <span className="text-lg font-semibold tabular-nums" data-testid={`myFees.outstanding.${studentId}`}>
                  {formatRupees(d.outstanding)}
                </span>{' '}
                owed
                {d.nextDueOn && <> · next due {formatDate(d.nextDueOn)}</>}
                {d.advance > 0 && <> · {formatRupees(d.advance)} paid in advance</>}
              </p>
              {d.charges.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>For</TableHead>
                      <TableHead>Due</TableHead>
                      <TableHead className="text-right">Owed</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {d.charges.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell>
                          {c.feeHeadName}
                          {c.period && ` ${formatMonth(c.period)}`}
                        </TableCell>
                        <TableCell>{formatDate(c.dueOn)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatRupees(c.outstanding)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {d.claimsAccepted ? (
                sending ? (
                  <SlipForm studentId={studentId} onClose={() => setSending(false)} />
                ) : (
                  <div>
                    <Button variant="outline" onClick={() => setSending(true)} data-testid={`myFees.send.${studentId}`}>
                      Send a deposit slip
                    </Button>
                  </div>
                )
              ) : (
                <p className="text-sm text-muted-foreground">The school takes fees at the office.</p>
              )}
            </div>
          )}
        </QueryStates>
        {claims.data && claims.data.data.length > 0 && <ClaimList studentId={studentId} claims={claims.data.data} />}
      </CardContent>
    </Card>
  );
}

function ClaimList({ studentId, claims }: { studentId: string; claims: MyClaimDto[] }) {
  const queryClient = useQueryClient();
  const withdraw = useMutation({
    mutationFn: (claimId: string) =>
      unwrap(claimsApi.POST('/api/v1/me/children/{id}/payment-claims/{claimId}/withdraw', { params: { path: { id: studentId, claimId } }, body: {} })),
    onSuccess: () => {
      toast.success('Slip withdrawn.');
      void queryClient.invalidateQueries({ queryKey: myFeesKey });
    },
    onError: toastApiError,
  });
  return (
    <div className="grid gap-2">
      <h3 className="text-sm font-medium">Deposit slips sent</h3>
      <ul className="grid gap-2 text-sm">
        {claims.map((c) => (
          <li key={c.id} className="rounded-md border p-3" data-testid={`myFees.claim.${c.id}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium tabular-nums">{formatRupees(c.verifiedAmount ?? c.claimedAmount)}</span>
              <span className="text-muted-foreground">
                {PAYMENT_METHOD_LABELS[c.method]}, paid {formatDate(c.verifiedPaidOn ?? c.paidOn)}
              </span>
              <Badge variant={c.status === 'verified' ? 'default' : c.status === 'rejected' ? 'destructive' : 'secondary'}>{CLAIM_STATUS_LABELS[c.status]}</Badge>
            </div>
            {c.decisionReason && <p className="mt-1 text-muted-foreground">{c.decisionReason}</p>}
            {c.status === 'pending' && !c.hasImage && <p className="mt-1 text-muted-foreground">The slip has not reached the school yet.</p>}
            <div className="mt-2 flex flex-wrap gap-2">
              {c.submittedByMe && c.hasImage && (
                <a className="text-primary hover:underline" href={myClaimImageUrl(studentId, c.id)} target="_blank" rel="noopener noreferrer">
                  View slip
                </a>
              )}
              {c.submittedByMe && c.status === 'pending' && (
                <Button variant="ghost" size="sm" disabled={withdraw.isPending} onClick={() => withdraw.mutate(c.id)}>
                  Withdraw
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const METHODS = DEPOSIT_METHODS;

function SlipForm({ studentId, onClose }: { studentId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const today = todayInSchool();
  const [method, setMethod] = useState<DepositMethod>('bank_transfer');
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(today);
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [key] = useState(newIdempotencyKey);

  const send = useMutation({
    mutationFn: async () => {
      const staged = file ? await uploadSlip(file) : null;
      return unwrap(
        claimsApi.POST('/api/v1/me/children/{id}/payment-claims', {
          params: { path: { id: studentId }, header: { 'Idempotency-Key': key } },
          body: {
            method,
            claimedAmount: Number(amount),
            paidOn,
            ...(reference.trim() && { reference: reference.trim() }),
            ...(note.trim() && { note: note.trim() }),
            ...(staged && { stagedUploadId: staged.id }),
          },
        }),
      );
    },
    onSuccess: () => {
      toast.success('Slip sent. The office will check it.');
      void queryClient.invalidateQueries({ queryKey: myFeesKey });
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.CLAIM_LIMIT_REACHED) {
        setProblem('At most ten slips a day. Try again tomorrow.');
        return;
      }
      toastApiError(error);
    },
  });

  function submit() {
    if (!(Number(amount) >= 1)) return setProblem('Enter the amount you paid.');
    if (!file) return setProblem('Choose the photo or PDF of the slip.');
    if (!ACCEPTED_TYPES.includes(file.type)) return setProblem('Choose a JPEG, PNG or PDF file.');
    if (file.size > MAX_UPLOAD_BYTES) return setProblem('The file is larger than 5 MB.');
    setProblem(null);
    send.mutate();
  }

  return (
    <div className="grid gap-3 rounded-md border p-4" data-testid={`myFees.form.${studentId}`}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`slip-method-${studentId}`}>Paid by</Label>
          <NativeSelect id={`slip-method-${studentId}`} value={method} onChange={(e) => setMethod(e.target.value as DepositMethod)}>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABELS[m]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`slip-amount-${studentId}`}>Amount (Rs)</Label>
          <Input id={`slip-amount-${studentId}`} inputMode="numeric" value={amount} onChange={(e) => setAmount(digitsOnly(e.target.value))} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`slip-date-${studentId}`}>Paid on</Label>
          <Input id={`slip-date-${studentId}`} type="date" max={today} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`slip-ref-${studentId}`}>Transaction or slip number (optional)</Label>
          <Input id={`slip-ref-${studentId}`} maxLength={60} value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`slip-note-${studentId}`}>Note (optional)</Label>
        <Textarea id={`slip-note-${studentId}`} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`slip-file-${studentId}`}>Slip (photo or PDF, up to 5 MB)</Label>
        <Input id={`slip-file-${studentId}`} type="file" accept={ACCEPT_ATTRIBUTE} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>
      {problem && (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button disabled={send.isPending} onClick={submit} data-testid={`myFees.submit.${studentId}`}>
          Send slip
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The family's receipts, rendered from MyReceiptDto (no print view: no collector, own children only). */
function Receipts() {
  const [open, setOpen] = useState<MyReceiptDto | null>(null);
  const receipts = useQuery({
    queryKey: [...myFeesKey, 'receipts'],
    queryFn: () => unwrap(claimsApi.GET('/api/v1/me/receipts', { params: { query: { page: 1, limit: 25 } } })),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Receipts</CardTitle>
      </CardHeader>
      <CardContent>
        <QueryStates query={receipts} loadingRows={3}>
          {(page) =>
            page.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">No receipts yet.</p>
            ) : (
              <ul className="grid gap-2 text-sm">
                {page.data.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2">
                    <Button variant="link" className="h-auto p-0" onClick={() => setOpen(r)} data-testid={`myFees.receipt.${r.id}`}>
                      Receipt {r.receiptLabel}
                    </Button>
                    <span className="tabular-nums">{formatRupees(r.amount)}</span>
                    <span className="text-muted-foreground">{formatDate(r.paidOn)}</span>
                    {r.voidedAt && <Badge variant="destructive">Void</Badge>}
                  </li>
                ))}
              </ul>
            )
          }
        </QueryStates>
      </CardContent>
      <Dialog open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <DialogContent>
          {open && (
            <>
              <DialogHeader>
                <DialogTitle>Receipt {open.receiptLabel}</DialogTitle>
              </DialogHeader>
              <div className="grid gap-2 text-sm">
                <p>
                  {formatRupees(open.amount)} paid {formatDate(open.paidOn)} · {open.academicYearName}
                </p>
                <ul className="grid gap-1">
                  {open.lines.map((l, i) => (
                    <li key={i} className="flex justify-between gap-4">
                      <span>
                        {l.studentName}: {l.feeHeadName ? `${l.feeHeadName}${l.period ? ` ${formatMonth(l.period)}` : ''}` : 'Advance (kept for later fees)'}
                      </span>
                      <span className="tabular-nums">{formatRupees(l.amount)}</span>
                    </li>
                  ))}
                  {open.otherChildrenAmount > 0 && (
                    <li className="flex justify-between gap-4 text-muted-foreground">
                      <span>Other children</span>
                      <span className="tabular-nums">{formatRupees(open.otherChildrenAmount)}</span>
                    </li>
                  )}
                </ul>
                {open.voidedAt && <p className="text-destructive">This receipt was voided.</p>}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
