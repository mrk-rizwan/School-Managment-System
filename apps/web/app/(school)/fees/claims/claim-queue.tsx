'use client';

import { Capability, ErrorCode, formatRupees } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { ExternalLinkIcon, PrinterIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { DataTable, type DataTableFeatures } from '@/components/data-table';
import { FilterSelect } from '@/components/list-filters';
import { EmptyState, LoadingState, QueryStates } from '@/components/page-states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { unwrap } from '@/lib/api/client';
import { ApiError, toastApiError } from '@/lib/api/errors';
import {
  claimImageUrl,
  claimsApi,
  CLAIM_STATUS_LABELS,
  DEPOSIT_METHOD_LABELS,
  type ClaimDto,
  type ClaimListQuery,
  type ClaimStatus,
  type VerifyClaimBody,
} from '@/lib/api/school-claims-contract';
import { paymentsApi, receiptPrintUrl } from '@/lib/api/school-payments-contract';
import { formatDate, formatDateTime } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { useCapabilities } from '@/lib/school-session';
import { digitsOnly, feesKeys, formatMonth } from '../_lib/fees-ui';

const LIMIT = 25;
const claimsKey = [...feesKeys.all, 'claims'] as const;

/**
 * Deposit slips (slice 21, R196-R200, R243, R249): the claims parents send from the app or the web,
 * oldest first, with the slip and the family's dues side by side. Verifying records the payment
 * exactly as the counter does (allocation, receipt, the message to the family); a lower amount or
 * another paid date needs a reason, which the guardian sees. Nobody decides a claim of their own
 * family; the API refuses it.
 */
export function ClaimQueue() {
  const [status, setStatus] = useState<ClaimStatus>('pending');
  const [withSlip, setWithSlip] = useState<'true' | 'false'>('true');
  const [page, setPage] = useListPage([status, withSlip]);
  const [selected, setSelected] = useState<string | null>(null);

  const query: ClaimListQuery = { page, limit: LIMIT, status, hasImage: withSlip === 'true' };
  const claims = useQuery({
    queryKey: [...claimsKey, query],
    queryFn: () => unwrap(claimsApi.GET('/api/v1/payment-claims', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, ClaimDto>();
    return [
      column.accessor('createdAt', { header: 'Sent', cell: (info) => formatDateTime(info.getValue()) }),
      column.accessor('studentName', {
        header: 'Child',
        cell: (info) => (
          <span className="flex flex-col">
            <span>{info.getValue()}</span>
            <span className="text-xs text-muted-foreground">
              {info.row.original.className} · from {info.row.original.guardianName}
            </span>
          </span>
        ),
      }),
      column.accessor('method', {
        header: 'Paid by',
        cell: (info) => (
          <span>
            {DEPOSIT_METHOD_LABELS[info.getValue()]}
            {info.row.original.possibleDuplicate && (
              <Badge variant="destructive" className="ml-1">
                possible duplicate
              </Badge>
            )}
          </span>
        ),
      }),
      column.accessor('claimedAmount', {
        header: () => <span className="block text-right">Amount</span>,
        cell: (info) => <span className="block text-right tabular-nums">{formatRupees(info.getValue())}</span>,
      }),
      column.display({
        id: 'review',
        header: () => <span className="sr-only">Review</span>,
        cell: (info) => (
          <Button
            size="sm"
            variant={selected === info.row.original.id ? 'default' : 'outline'}
            onClick={() => setSelected(info.row.original.id)}
            data-testid={`claims.review.${info.row.original.id}`}
          >
            Review
          </Button>
        ),
      }),
    ];
  }, [selected]);

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <FilterSelect<ClaimStatus> label="Status" value={status} onChange={setStatus}>
            {(Object.keys(CLAIM_STATUS_LABELS) as ClaimStatus[]).map((s) => (
              <option key={s} value={s}>
                {CLAIM_STATUS_LABELS[s]}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect<'true' | 'false'> label="Slip" value={withSlip} onChange={setWithSlip}>
            <option value="true">With slip</option>
            <option value="false">Slip not sent yet</option>
          </FilterSelect>
        </div>
        <DataTable
          columns={columns}
          query={claims}
          getRowId={(row) => row.id}
          page={page}
          limit={LIMIT}
          onPageChange={setPage}
          emptyTitle="No deposit slips here"
          emptyDescription="Parents send a slip from the app or the web after paying at a bank or by wallet."
        />
      </div>
      {selected ? (
        <ClaimReview key={selected} claimId={selected} onDecided={() => setSelected(null)} />
      ) : (
        <Card>
          <CardContent>
            <EmptyState title="Choose a slip to review" description="The slip and the family's dues show here side by side." />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ClaimReview({ claimId, onDecided }: { claimId: string; onDecided: () => void }) {
  const queryClient = useQueryClient();
  const claim = useQuery({
    queryKey: [...claimsKey, 'one', claimId],
    queryFn: () => unwrap(claimsApi.GET('/api/v1/payment-claims/{id}', { params: { path: { id: claimId } } })),
  });
  return (
    <QueryStates query={claim} notFound={{ title: 'No such claim', description: 'It may belong to another school.' }}>
      {(c) => (
        <div className="grid gap-4" data-testid="claims.review">
          <Card>
            <CardHeader>
              <CardTitle>
                {c.studentName} · {formatRupees(c.claimedAmount)}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt className="text-muted-foreground">Status</dt>
                <dd>{CLAIM_STATUS_LABELS[c.status]}</dd>
                <dt className="text-muted-foreground">Paid by</dt>
                <dd>{DEPOSIT_METHOD_LABELS[c.method]}</dd>
                <dt className="text-muted-foreground">Paid on (parent)</dt>
                <dd>{formatDate(c.paidOn)}</dd>
                <dt className="text-muted-foreground">Reference</dt>
                <dd>{c.reference ?? '—'}</dd>
                <dt className="text-muted-foreground">Sent by</dt>
                <dd>
                  {c.guardianName}, {formatDateTime(c.createdAt)}
                </dd>
                {c.note && (
                  <>
                    <dt className="text-muted-foreground">Note</dt>
                    <dd className="whitespace-pre-wrap">{c.note}</dd>
                  </>
                )}
                {c.decisionReason && (
                  <>
                    <dt className="text-muted-foreground">Decision</dt>
                    <dd>{c.decisionReason}</dd>
                  </>
                )}
              </dl>
              {c.possibleDuplicate && (
                <Alert>
                  <AlertDescription>
                    Another slip has the same method, reference and date. Check it is not the same payment twice.
                  </AlertDescription>
                </Alert>
              )}
              {c.reopenedAt && (
                <Alert>
                  <AlertDescription>Back in the queue: the payment it recorded was voided on {formatDateTime(c.reopenedAt)}.</AlertDescription>
                </Alert>
              )}
              {c.receiptId && (
                <a className={buttonVariants({ variant: 'outline' })} href={receiptPrintUrl(c.receiptId)} target="_blank" rel="noopener noreferrer">
                  <PrinterIcon />
                  Print receipt
                </a>
              )}
            </CardContent>
          </Card>
          <Slip claim={c} />
          <FamilyDues guardianId={c.guardianId} />
          {c.status === 'pending' && c.hasImage && (
            <Decide
              claim={c}
              onDone={() => {
                void queryClient.invalidateQueries({ queryKey: feesKeys.all });
                onDecided();
              }}
            />
          )}
        </div>
      )}
    </QueryStates>
  );
}

/** The slip: a thumbnail loaded on tap (never in a list), the image in a new tab (served inline), a PDF downloaded. */
function Slip({ claim }: { claim: ClaimDto }) {
  const [shown, setShown] = useState(false);
  if (!claim.hasImage) {
    return (
      <Alert>
        <AlertDescription>The parent has not sent the slip yet. A claim without one cannot be verified and expires after a day.</AlertDescription>
      </Alert>
    );
  }
  const isImage = claim.imageMime !== 'application/pdf';
  return (
    <Card>
      <CardHeader>
        <CardTitle>Slip</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap gap-2">
          {isImage && (
            <Button variant="outline" size="sm" onClick={() => setShown((v) => !v)} aria-expanded={shown}>
              {shown ? 'Hide slip' : 'Show slip'}
            </Button>
          )}
          <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={claimImageUrl(claim.id)} target="_blank" rel="noopener noreferrer">
            <ExternalLinkIcon />
            {isImage ? 'Open full size' : 'Download PDF'}
          </a>
        </div>
        {shown && (
          // eslint-disable-next-line @next/next/no-img-element -- a private, cookie-authenticated thumbnail
          <img src={claimImageUrl(claim.id, true)} alt={`Deposit slip for ${claim.studentName}`} className="max-h-96 w-auto max-w-full rounded-lg border object-contain" />
        )}
      </CardContent>
    </Card>
  );
}

/** The family's dues at the counter's view (payment.record or fee.statement.view). */
function FamilyDues({ guardianId }: { guardianId: string }) {
  const { can } = useCapabilities();
  const allowed = can(Capability.PAYMENT_RECORD) || can(Capability.FEE_STATEMENT_VIEW);
  const dues = useQuery({
    queryKey: [...feesKeys.all, 'family-dues', guardianId],
    queryFn: () => unwrap(paymentsApi.GET('/api/v1/guardians/{id}/dues', { params: { path: { id: guardianId } } })),
    enabled: allowed,
  });
  if (!allowed) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Family dues</CardTitle>
      </CardHeader>
      <CardContent>
        {dues.isPending ? (
          <LoadingState rows={3} />
        ) : dues.error || !dues.data ? (
          <p className="text-sm text-muted-foreground">The family&apos;s dues could not be loaded.</p>
        ) : dues.data.children.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing owed.</p>
        ) : (
          <ul className="grid gap-3 text-sm">
            {dues.data.children.map((child) => (
              <li key={`${child.studentId}-${child.academicYearId}`} className="grid gap-1">
                <span className="font-medium">
                  {child.fullName} · {child.className} · {child.academicYearName}
                </span>
                <span className="tabular-nums">
                  Owes {formatRupees(child.outstanding)}
                  {child.advance > 0 && `, advance ${formatRupees(child.advance)}`}
                </span>
                {child.openCharges.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {child.openCharges
                      .map((c) => `${c.feeHeadName}${c.period ? ` ${formatMonth(c.period)}` : ''} ${formatRupees(c.outstanding)}`)
                      .join(' · ')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Decide({ claim, onDone }: { claim: ClaimDto; onDone: () => void }) {
  const [amount, setAmount] = useState(String(claim.claimedAmount));
  const [paidOn, setPaidOn] = useState(claim.paidOn);
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const verifiedAmount = Number(amount);
  const lower = verifiedAmount < claim.claimedAmount;
  const corrected = paidOn !== claim.paidOn;
  const needsReason = lower || corrected;
  const amountProblem =
    !(verifiedAmount >= 1) ? 'Enter the amount the slip shows.' : verifiedAmount > claim.claimedAmount ? 'At most the amount claimed. For more, the parent sends a new claim.' : null;

  const verify = useMutation({
    mutationFn: () => {
      const body: VerifyClaimBody = {
        ...(lower && { verifiedAmount }),
        ...(corrected && { paidOn }),
        ...(reason.trim() && { reason: reason.trim() }),
      };
      return unwrap(claimsApi.POST('/api/v1/payment-claims/{id}/verify', { params: { path: { id: claim.id } }, body }));
    },
    onSuccess: (v) => {
      toast.success(`Verified: receipt ${v.payment.receipt?.receiptLabel ?? ''} for ${formatRupees(v.payment.amount)}.`);
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.PAYMENT_NOTHING_DUE) {
        toast.error('Nothing is owed by this child this year. Reject the slip, or record the money at the counter as an advance.');
        return;
      }
      toastApiError(error);
      if (error instanceof ApiError && error.status === 409) onDone();
    },
  });
  const reject = useMutation({
    mutationFn: (why: string) =>
      unwrap(claimsApi.POST('/api/v1/payment-claims/{id}/reject', { params: { path: { id: claim.id } }, body: { reason: why } })),
    onSuccess: () => {
      toast.success('Slip not accepted. The parent is told why.');
      setRejecting(false);
      onDone();
    },
    onError: toastApiError,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Decide</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="verify-amount">Amount on the slip (Rs)</Label>
            <Input id="verify-amount" inputMode="numeric" value={amount} onChange={(e) => setAmount(digitsOnly(e.target.value))} aria-invalid={amountProblem !== null} />
            {amountProblem && <p className="text-sm text-destructive">{amountProblem}</p>}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="verify-date">Paid on (as the slip shows)</Label>
            <Input id="verify-date" type="date" value={paidOn} max={claim.createdAt.slice(0, 10)} onChange={(e) => setPaidOn(e.target.value)} />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="verify-reason">Reason {needsReason ? '(the parent sees it)' : '(optional)'}</Label>
          <Textarea id="verify-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder={needsReason ? 'Why the amount or the date differs' : ''} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={verify.isPending || amountProblem !== null || (needsReason && reason.trim().length < 3) || !paidOn}
            onClick={() => verify.mutate()}
            data-testid="claims.verify"
          >
            Verify and issue receipt
          </Button>
          <Button variant="outline" onClick={() => setRejecting(true)} data-testid="claims.reject">
            Not accepted…
          </Button>
        </div>
      </CardContent>
      <ConfirmWithReasonDialog
        open={rejecting}
        onOpenChange={setRejecting}
        title="Do not accept this slip"
        description="The parent receives the reason by WhatsApp or SMS. Do not include a phone number."
        confirmLabel="Not accepted"
        minLength={3}
        destructive
        pending={reject.isPending}
        onConfirm={(why) => reject.mutate(why)}
      />
    </Card>
  );
}
