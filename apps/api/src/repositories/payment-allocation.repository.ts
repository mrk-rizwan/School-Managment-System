import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

// Payment allocations (tenant table payment_allocations, phase-3-financial.md §3.2, R188, R189,
// R191, A6). Never deleted, columns frozen; an insert raises the charges' allocated_amount and
// lowers the payments' unallocated_amount (statement trigger payment_allocations_apply), and
// setting reversed_at, once, does the opposite and reopens a settled charge
// (payment_allocations_reverse). Each insert and each reversal is one statement, so its trigger
// takes the payment locks and then the charge locks once, in id order (R236).

export interface AllocationRecord {
  id: bigint;
  paymentId: bigint;
  chargeId: bigint;
  studentId: bigint;
  academicYearId: bigint;
  amount: number;
  createdAt: Date;
  reversedAt: Date | null;
}

const SELECT = {
  id: true,
  paymentId: true,
  chargeId: true,
  studentId: true,
  academicYearId: true,
  amount: true,
  createdAt: true,
  reversedAt: true,
} as const;

export interface NewAllocation {
  paymentId: bigint;
  chargeId: bigint;
  studentId: bigint;
  academicYearId: bigint;
  amount: number;
}

@Injectable()
export class PaymentAllocationRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** One INSERT statement: the trigger applies every row under one set of locks. */
  async insert(schoolId: SchoolId, rows: readonly NewAllocation[]): Promise<void> {
    if (rows.length === 0) return;
    await this.txHost.tx.paymentAllocation.createMany({
      data: rows.map((row) => ({ schoolId, ...row })),
    });
  }

  /** One UPDATE statement setting reversed_at on these live rows; returns how many moved. */
  async reverse(schoolId: SchoolId, ids: readonly bigint[], now: Date): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await this.txHost.tx.paymentAllocation.updateMany({
      where: { schoolId, id: { in: [...ids] }, reversedAt: null },
      data: { reversedAt: now },
    });
    return count;
  }

  /** The live allocations of these charges, newest first (A6 de-allocates from the newest). */
  async liveOfCharges(schoolId: SchoolId, chargeIds: readonly bigint[]): Promise<AllocationRecord[]> {
    if (chargeIds.length === 0) return [];
    return this.txHost.tx.paymentAllocation.findMany({
      where: { schoolId, chargeId: { in: [...new Set(chargeIds)] }, reversedAt: null },
      select: SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  /** Every allocation of these payments, live and reversed, oldest first. */
  async ofPayments(schoolId: SchoolId, paymentIds: readonly bigint[]): Promise<AllocationRecord[]> {
    if (paymentIds.length === 0) return [];
    return this.txHost.tx.paymentAllocation.findMany({
      where: { schoolId, paymentId: { in: [...new Set(paymentIds)] } },
      select: SELECT,
      orderBy: { id: 'asc' },
    });
  }

  /** The live allocations of one child's year, with their payments (the statement). */
  async liveOfStudentYear(schoolId: SchoolId, studentId: bigint, academicYearId: bigint): Promise<AllocationRecord[]> {
    return this.txHost.tx.paymentAllocation.findMany({
      where: { schoolId, studentId, academicYearId, reversedAt: null },
      select: SELECT,
      orderBy: { id: 'asc' },
    });
  }
}
