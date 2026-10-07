import { formatDay, formatRupees, PAYMENT_METHOD_LABELS, shortMonthLabel, type ClaimStatus } from '@asms/shared';
import { api, unwrap, unwrapWithDate } from '../api/client';
import type { MyClaimDto, MyDuesDto, MyReceiptDto } from '../api/contracts';
import { queryKeys } from '../api/query-keys';

// A child's Fees (phase-3-financial.md slice 21, §3.9, R198): dues, the deposit slips sent and the
// family's receipts, read through /me/children/:id/* and /me/receipts with the cache, so the last
// copy shows offline "as of" its time. Receipts are rendered natively and shared as text (§3.5):
// no WebView, no PDF. Only the parent who sent a slip sees its picture (R198).

type Page<T> = { data: T[]; page: number; limit: number; total: number };

export const FEES_CLAIMS_LIMIT = 10;
export const FEES_RECEIPTS_LIMIT = 10;

export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  pending: 'Waiting for the office',
  verified: 'Verified',
  rejected: 'Not accepted',
  withdrawn: 'Withdrawn',
  expired: 'Expired: the slip never arrived',
};

/** One cached read per resource: its key, cache path and params, and its fetch. */
export function duesRead(studentId: string) {
  return {
    key: queryKeys.feesDues(studentId),
    path: `/api/v1/me/children/${studentId}/dues`,
    params: {},
    fetch: () =>
      unwrapWithDate<MyDuesDto>(api.GET('/api/v1/me/children/{id}/dues', { params: { path: { id: studentId } } })),
  };
}

export function claimsRead(studentId: string) {
  const query = { page: 1, limit: FEES_CLAIMS_LIMIT };
  return {
    key: queryKeys.feesClaims(studentId),
    path: `/api/v1/me/children/${studentId}/payment-claims`,
    params: query,
    fetch: () =>
      unwrapWithDate<Page<MyClaimDto>>(
        api.GET('/api/v1/me/children/{id}/payment-claims', { params: { path: { id: studentId }, query } }),
      ),
  };
}

export function receiptsRead(studentId: string) {
  const query = { page: 1, limit: FEES_RECEIPTS_LIMIT, studentId };
  return {
    key: queryKeys.feesReceipts(studentId),
    path: '/api/v1/me/receipts',
    params: query,
    fetch: () => unwrapWithDate<Page<MyReceiptDto>>(api.GET('/api/v1/me/receipts', { params: { query } })),
  };
}

/** Where the school takes deposits (slice 18): online only, no cache. */
export const fetchAccounts = () =>
  unwrap(api.GET('/api/v1/me/payment-accounts', { params: { query: { page: 1, limit: 50 } } }));

/** What a charge or a receipt line is for: "Tuition Sep 2026", or the advance line. */
export function forWhat(line: { feeHeadName: string | null; period: string | null }): string {
  if (line.feeHeadName === null) return 'Advance (kept for later fees)';
  return line.period === null ? line.feeHeadName : `${line.feeHeadName} ${shortMonthLabel(line.period)}`;
}

/** A claim's line on the Fees screen: what it says and what became of it. */
export function claimLine(claim: MyClaimDto): string {
  const amount = formatRupees(claim.verifiedAmount ?? claim.claimedAmount);
  return `${amount} · ${PAYMENT_METHOD_LABELS[claim.method]} · paid ${formatDay(claim.verifiedPaidOn ?? claim.paidOn)}`;
}

/** The receipt as plain text for the share sheet: the caller's own children's lines only. */
export function receiptText(receipt: MyReceiptDto, schoolName: string): string {
  return [
    schoolName,
    `Receipt ${receipt.receiptLabel}`,
    `${formatRupees(receipt.amount)} paid ${formatDay(receipt.paidOn)}`,
    '',
    ...receipt.lines.map((l) => `${l.studentName}: ${forWhat(l)}: ${formatRupees(l.amount)}`),
    ...(receipt.otherChildrenAmount > 0 ? [`Other children: ${formatRupees(receipt.otherChildrenAmount)}`] : []),
    ...(receipt.voidedAt !== null ? ['', 'This receipt was voided.'] : []),
  ].join('\n');
}
