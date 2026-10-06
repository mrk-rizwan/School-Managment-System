import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { ExpenseCategory, ExpenseStatus, PaymentMethod } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

// The tenant table expenses (phase-3-financial.md §4 "Expenses", slice 23, R206-R208, R244).
// Never deleted; a void is a status. The database refuses what the service also refuses: amounts
// and dates frozen once decided (expenses_content_frozen), the receipt set once
// (expenses_receipt_frozen), the forward-only status (expenses_status_transition) and nobody
// deciding or voiding-after-approval their own row (expenses_not_self).

export interface ExpenseRecord {
  id: bigint;
  expenseNo: number;
  category: ExpenseCategory;
  amount: number;
  spentOn: Date;
  description: string;
  payee: string | null;
  method: PaymentMethod;
  reference: string | null;
  receiptObjectKey: string | null;
  receiptMime: string | null;
  receiptSizeBytes: number | null;
  status: ExpenseStatus;
  recordedBy: bigint;
  recordedAt: Date;
  decidedBy: bigint | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  selfApproved: boolean;
  voidedAt: Date | null;
  voidedBy: bigint | null;
  voidReason: string | null;
  updatedAt: Date;
  /** The recorder's staff record and name (users.staff_id); null for a user with no staff row. */
  recordedByStaffId: bigint | null;
  recordedByName: string;
}

/** The editable content (PATCH /expenses/:id); absent = unchanged. */
export interface ExpenseContent {
  category: ExpenseCategory;
  amount: number;
  spentOn: Date;
  description: string;
  payee: string | null;
  method: PaymentMethod;
  reference: string | null;
}

export interface ExpenseReceipt {
  objectKey: string;
  mime: string;
  sizeBytes: number;
}

export interface NewExpense extends ExpenseContent {
  expenseNo: number;
  status: 'recorded' | 'pending_approval' | 'approved';
  recordedBy: bigint;
  receipt: ExpenseReceipt | null;
  /** A principal's own expense above the threshold, approved as recorded (R206). */
  selfApproved: boolean;
}

export interface ExpenseListQuery {
  spentFrom?: Date;
  spentTo?: Date;
  category?: ExpenseCategory;
  status?: ExpenseStatus;
  recordedBy?: bigint;
  sort: 'spentOn' | '-spentOn';
  skip: number;
  take: number;
}

const SELECT = {
  id: true,
  expenseNo: true,
  category: true,
  amount: true,
  spentOn: true,
  description: true,
  payee: true,
  method: true,
  reference: true,
  receiptObjectKey: true,
  receiptMime: true,
  receiptSizeBytes: true,
  status: true,
  recordedBy: true,
  recordedAt: true,
  decidedBy: true,
  decidedAt: true,
  decisionReason: true,
  selfApproved: true,
  voidedAt: true,
  voidedBy: true,
  voidReason: true,
  updatedAt: true,
  recordedByUser: { select: { staffId: true, staff: { select: { fullName: true } } } },
} as const satisfies Prisma.ExpenseSelect;

type Row = Prisma.ExpenseGetPayload<{ select: typeof SELECT }>;

const toRecord = ({ recordedByUser, ...row }: Row): ExpenseRecord => ({
  ...row,
  recordedByStaffId: recordedByUser.staffId,
  recordedByName: recordedByUser.staff?.fullName ?? '',
});

const OPEN: ExpenseStatus[] = ['recorded', 'pending_approval'];

@Injectable()
export class ExpenseRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async list(schoolId: SchoolId, query: ExpenseListQuery): Promise<{ rows: ExpenseRecord[]; total: number }> {
    const spentOn: Prisma.DateTimeFilter = {
      ...(query.spentFrom === undefined ? {} : { gte: query.spentFrom }),
      ...(query.spentTo === undefined ? {} : { lte: query.spentTo }),
    };
    const where: Prisma.ExpenseWhereInput = {
      schoolId,
      ...(Object.keys(spentOn).length === 0 ? {} : { spentOn }),
      ...(query.category === undefined ? {} : { category: query.category }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.recordedBy === undefined ? {} : { recordedBy: query.recordedBy }),
    };
    const direction = query.sort === 'spentOn' ? 'asc' : 'desc';
    const rows = await this.txHost.tx.expense.findMany({
      where,
      select: SELECT,
      orderBy: [{ spentOn: direction }, { id: direction }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.expense.count({ where });
    return { rows: rows.map(toRecord), total };
  }

  async findById(schoolId: SchoolId, id: bigint): Promise<ExpenseRecord | null> {
    const row = await this.txHost.tx.expense.findFirst({ where: { schoolId, id }, select: SELECT });
    return row === null ? null : toRecord(row);
  }

  /**
   * The next expense number: `UPDATE school_counters SET value = value + 1 ... RETURNING` on the
   * school's `expense_no` counter (created with the school, slice 18). The counter row stays
   * locked to the end of the transaction, so numbers are consecutive in commit order and a
   * rollback leaves no gap. Taken last, just before the insert (§3.2's lock order).
   */
  async nextExpenseNo(schoolId: SchoolId): Promise<number> {
    const row = await this.txHost.tx.schoolCounter.update({
      where: { schoolId_name: { schoolId, name: 'expense_no' } },
      data: { value: { increment: 1 } },
      select: { value: true },
    });
    return Number(row.value);
  }

  async create(schoolId: SchoolId, data: NewExpense, now: Date): Promise<ExpenseRecord> {
    const { receipt, ...rest } = data;
    const row = await this.txHost.tx.expense.create({
      data: {
        schoolId,
        ...rest,
        recordedAt: now,
        ...(receipt === null
          ? {}
          : { receiptObjectKey: receipt.objectKey, receiptMime: receipt.mime, receiptSizeBytes: receipt.sizeBytes }),
        ...(data.selfApproved ? { decidedBy: data.recordedBy, decidedAt: now } : {}),
      },
      select: SELECT,
    });
    return toRecord(row);
  }

  /**
   * Locks the row for the rest of the transaction if it is unchanged since `row` was read (a
   * compare-and-set on updated_at that writes nothing visible); false when it moved meanwhile.
   */
  async lockIfUnchanged(schoolId: SchoolId, row: Pick<ExpenseRecord, 'id' | 'updatedAt'>): Promise<boolean> {
    const { count } = await this.txHost.tx.expense.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  /** The recorder's edit of an open expense; 0 when it is no longer open. */
  async updateContent(schoolId: SchoolId, id: bigint, changes: Partial<ExpenseContent>): Promise<number> {
    const { count } = await this.txHost.tx.expense.updateMany({
      where: { schoolId, id, status: { in: OPEN } },
      data: changes,
    });
    return count;
  }

  /** Sets the receipt while the row has none (set once); 0 when it already has one. */
  async setReceipt(schoolId: SchoolId, id: bigint, receipt: ExpenseReceipt): Promise<number> {
    const { count } = await this.txHost.tx.expense.updateMany({
      where: { schoolId, id, receiptObjectKey: null },
      data: { receiptObjectKey: receipt.objectKey, receiptMime: receipt.mime, receiptSizeBytes: receipt.sizeBytes },
    });
    return count;
  }

  /**
   * Approves or rejects a pending expense, compare-and-set on the version the approver saw
   * (`updated_at`): 0 when it is no longer pending or was edited since.
   */
  async decide(
    schoolId: SchoolId,
    id: bigint,
    expectedUpdatedAt: Date,
    decision: { status: 'approved' | 'rejected'; by: bigint; at: Date; reason: string | null },
  ): Promise<number> {
    const { count } = await this.txHost.tx.expense.updateMany({
      where: { schoolId, id, status: 'pending_approval', updatedAt: expectedUpdatedAt },
      data: { status: decision.status, decidedBy: decision.by, decidedAt: decision.at, decisionReason: decision.reason },
    });
    return count;
  }

  /** Voids the expense while it is still in `from`; 0 when it moved meanwhile. */
  async void(
    schoolId: SchoolId,
    id: bigint,
    from: ExpenseStatus,
    by: bigint,
    at: Date,
    reason: string,
  ): Promise<number> {
    const { count } = await this.txHost.tx.expense.updateMany({
      where: { schoolId, id, status: from },
      data: { status: 'voided', voidedBy: by, voidedAt: at, voidReason: reason },
    });
    return count;
  }
}
