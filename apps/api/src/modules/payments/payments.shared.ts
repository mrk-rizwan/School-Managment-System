// Slice 20's shared pieces (phase-3-financial.md §3.2, §3.4, §5.1): the refusals with their
// details, the one-retry of a counter race, and the DTO mappers.
import { Logger } from '@nestjs/common';
import { ErrorCode } from '@asms/shared';
import { ApiException } from '../../common/errors/api-exception';
import { mapDatabaseError, summariseDatabaseError } from '../../common/errors/prisma-errors';
import type { HandoverRecord } from '../../repositories/cash-handover.repository';
import type { ReversalRecord } from '../../repositories/payment-reversal.repository';
import type { ReceiptRecord } from '../../repositories/receipt.repository';
import type { HandoverDto, ReceiptDto, ReversalDto } from './payments.dto';

// ------------------------------------------------------------------------------- refusals

const refusal =
  (code: ErrorCode, message: string) =>
  (details: Record<string, unknown> = {}): ApiException =>
    new ApiException(409, code, message, details);

export const paymentSpansYears = refusal(
  ErrorCode.PAYMENT_SPANS_YEARS,
  'A payment belongs to one academic year. Record another payment for the other year.',
);
export const paymentNothingDue = refusal(
  ErrorCode.PAYMENT_NOTHING_DUE,
  'Nothing is owed by these children this year. Name the child to record an advance.',
);
export const paymentVoided = refusal(ErrorCode.PAYMENT_VOIDED, 'This payment has been voided.');
export const paymentInCustody = refusal(
  ErrorCode.PAYMENT_IN_CUSTODY,
  'This cash is in a handover still being counted. Confirm the handover first.',
);
export const paymentHasRefund = refusal(
  ErrorCode.PAYMENT_HAS_REFUND,
  'Part of this payment was refunded or carried forward. Reverse that first.',
);
export const refundExceedsUnallocated = refusal(
  ErrorCode.REFUND_EXCEEDS_UNALLOCATED,
  'Only the unallocated part of a payment (its advance) can be refunded.',
);
export const nothingToCarryForward = refusal(
  ErrorCode.NOTHING_TO_CARRY_FORWARD,
  'This payment has no advance left to carry forward.',
);
export const handoverOpen = refusal(ErrorCode.HANDOVER_OPEN, 'A handover of this cash is already waiting to be counted.');
export const handoverNothing = refusal(ErrorCode.HANDOVER_NOTHING_TO_HAND_OVER, 'There is no cash in hand to hand over.');
export const handoverNotOpen = refusal(ErrorCode.HANDOVER_NOT_OPEN, 'This handover has already been confirmed.');
export const handoverNotConfirmed = refusal(ErrorCode.HANDOVER_NOT_CONFIRMED, 'This handover has not been confirmed yet.');
export const handoverNoShortfall = refusal(
  ErrorCode.HANDOVER_NO_SHORTFALL,
  'This handover has no shortfall to resolve, or it is already resolved.',
);

/** R191, R194: separation of duties on cash; no capability and no exception switches it off. */
export const notSelf = (message: string, details: Record<string, unknown> | null = null): ApiException =>
  new ApiException(409, ErrorCode.SELF_ACTION_FORBIDDEN, message, details);

export const illegalTransition = (message: string): ApiException =>
  new ApiException(409, ErrorCode.ILLEGAL_STATUS_TRANSITION, message);

// ------------------------------------------------------------------------- one more try

const isConcurrent = (error: unknown): boolean =>
  (error instanceof ApiException ? error : mapDatabaseError(error))?.code === ErrorCode.CONCURRENT_UPDATE;

/**
 * §3.2: a counter race the increment CHECKs refused (23514 → CONCURRENT_UPDATE) is retried once,
 * in a fresh transaction that recomputes under its locks; a second failure reaches the caller.
 */
export async function onceMore<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isConcurrent(error)) throw error;
    onceMoreRetries.count += 1;
    // 'stale_read': a service's own re-check under its locks saw a row move between its unlocked
    // read and its lock (by design, retried); anything else came from the database: an increment
    // CHECK under a race, or a deadlock, which R236's lock order must make impossible.
    const cause = error instanceof ApiException ? 'stale_read' : (summariseDatabaseError(error)?.constraint ?? 'deadlock');
    onceMoreRetries.causes.push(cause);
    retryLog.warn({ retries: onceMoreRetries.count, cause }, 'money write retried after a concurrent update');
    return run();
  }
}

/**
 * How many times onceMore() retried in this process: R236's lock order should keep it at 0, and the
 * concurrency suite asserts that (a retry means a race reached an increment CHECK or a deadlock).
 */
export const onceMoreRetries: { count: number; causes: string[] } = { count: 0, causes: [] };
const retryLog = new Logger('PaymentRetry');

// --------------------------------------------------------------------------------- mappers

export const receiptLabel = (receiptNo: number, yearName: string): string => `${receiptNo}/${yearName}`;

export function toReceiptDto(
  row: ReceiptRecord,
  names: { year: string; issuedBy: string; student: (id: bigint) => string },
): ReceiptDto {
  return {
    id: row.id.toString(),
    receiptNo: row.receiptNo,
    receiptLabel: receiptLabel(row.receiptNo, names.year),
    academicYearId: row.academicYearId.toString(),
    paymentId: row.paymentId.toString(),
    amount: row.amount,
    lines: row.lines.map((line) => ({
      studentId: line.studentId.toString(),
      studentName: names.student(line.studentId),
      chargeId: line.chargeId?.toString() ?? null,
      feeHeadName: line.feeHeadName,
      period: line.period,
      amount: line.amount,
    })),
    issuedAt: row.issuedAt,
    issuedByName: names.issuedBy,
    voidedAt: row.voidedAt,
  };
}

export function toReversalDto(row: ReversalRecord, requestedByName: string, reversed: boolean): ReversalDto {
  return {
    id: row.id.toString(),
    paymentId: row.paymentId.toString(),
    academicYearId: row.academicYearId.toString(),
    kind: row.kind,
    reversesId: row.reversesId?.toString() ?? null,
    carriedToPaymentId: row.carriedToPaymentId?.toString() ?? null,
    amount: row.amount,
    reason: row.reason,
    requestedByUserId: row.requestedBy.toString(),
    requestedByName,
    approvedByUserId: row.approvedBy?.toString() ?? null,
    refundMethod: row.refundMethod,
    refundReference: row.refundReference,
    reversed,
    createdAt: row.createdAt,
  };
}

export function toHandoverDto(row: HandoverRecord, name: (userId: bigint) => string): HandoverDto {
  return {
    id: row.id.toString(),
    collector: {
      userId: row.collectorUserId.toString(),
      staffId: row.collectorStaffId.toString(),
      name: name(row.collectorUserId),
    },
    openedByUserId: row.openedBy.toString(),
    openedByName: name(row.openedBy),
    onBehalf: row.onBehalf,
    expectedAmount: row.expectedAmount,
    paymentCount: row.paymentCount,
    openedAt: row.openedAt,
    note: row.note,
    status: row.status,
    confirmedByUserId: row.confirmedBy?.toString() ?? null,
    confirmedByName: row.confirmedBy === null ? null : name(row.confirmedBy),
    confirmedAt: row.confirmedAt,
    countedAmount: row.countedAmount,
    shortfallAmount: row.shortfallAmount,
    surplusAmount: row.surplusAmount,
    confirmNote: row.confirmNote,
    shortfallResolution: row.shortfallResolution,
    shortfallResolvedAt: row.shortfallResolvedAt,
    shortfallResolutionReason: row.shortfallResolutionReason,
    shortfallExpenseId: row.shortfallExpenseId?.toString() ?? null,
    shortfallReversalId: row.shortfallReversalId?.toString() ?? null,
  };
}
