import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { PaymentMethod, ReversalKind } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

// Payment reversals (tenant table payment_reversals, phase-3-financial.md §3.2, R191, R192, R251).
// Append-only: a void, a refund, a refund reversal or a carry-forward is a new row naming the
// payment. The triggers refuse what the service also refuses (payment_reversals_not_self, under
// the payment's row lock, the first lock of R236) and do what the row means
// (payment_reversals_apply): a void voids the payment and its receipt and reverses its live
// allocations; the others move unallocated_amount. Only carried_to_payment_id is set later, once.

export interface ReversalRecord {
  id: bigint;
  paymentId: bigint;
  academicYearId: bigint;
  kind: ReversalKind;
  reversesId: bigint | null;
  carriedToPaymentId: bigint | null;
  amount: number;
  reason: string;
  requestedBy: bigint;
  approvedBy: bigint | null;
  refundMethod: PaymentMethod | null;
  refundReference: string | null;
  createdAt: Date;
}

const SELECT = {
  id: true,
  paymentId: true,
  academicYearId: true,
  kind: true,
  reversesId: true,
  carriedToPaymentId: true,
  amount: true,
  reason: true,
  requestedBy: true,
  approvedBy: true,
  refundMethod: true,
  refundReference: true,
  createdAt: true,
} as const;

export interface NewReversal {
  paymentId: bigint;
  academicYearId: bigint;
  kind: ReversalKind;
  reversesId: bigint | null;
  amount: number;
  reason: string;
  requestedBy: bigint;
  approvedBy: bigint | null;
  refundMethod: PaymentMethod | null;
  refundReference: string | null;
}

@Injectable()
export class PaymentReversalRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  create(schoolId: SchoolId, data: NewReversal, now: Date): Promise<ReversalRecord> {
    return this.txHost.tx.paymentReversal.create({
      data: { schoolId, ...data, createdAt: now },
      select: SELECT,
    });
  }

  findById(schoolId: SchoolId, id: bigint): Promise<ReversalRecord | null> {
    return this.txHost.tx.paymentReversal.findFirst({ where: { schoolId, id }, select: SELECT });
  }

  /** Every reversal of these payments, oldest first (bounded: a few per payment). */
  async ofPayments(schoolId: SchoolId, paymentIds: readonly bigint[]): Promise<ReversalRecord[]> {
    if (paymentIds.length === 0) return [];
    return this.txHost.tx.paymentReversal.findMany({
      where: { schoolId, paymentId: { in: [...new Set(paymentIds)] } },
      select: SELECT,
      orderBy: { id: 'asc' },
    });
  }

  /** R251: links a carry-forward to the payment it created (once; checked again at commit). */
  async linkCarriedTo(schoolId: SchoolId, id: bigint, paymentId: bigint): Promise<number> {
    const { count } = await this.txHost.tx.paymentReversal.updateMany({
      where: { schoolId, id, kind: 'carried_forward', carriedToPaymentId: null },
      data: { carriedToPaymentId: paymentId },
    });
    return count;
  }
}
