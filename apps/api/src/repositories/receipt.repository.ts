import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { receiptCounterName } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

// Receipts and their lines (tenant tables receipts, receipt_lines; phase-3-financial.md §3.5,
// R190). One receipt per payment, numbered from the school's receipt_<yearId> counter, taken last
// in the payment's transaction (§3.2, R236): numbers are gapless in commit order and never reused;
// a void stamps voided_at and the number stays. Lines are a snapshot. Raw SQL for the counter's
// upsert only (RAW_SQL_FILES; test/payments/isolation.e2e-spec.ts).

export interface ReceiptLineRecord {
  id: bigint;
  studentId: bigint;
  chargeId: bigint | null;
  feeHeadName: string | null;
  period: string | null;
  amount: number;
}

export interface ReceiptRecord {
  id: bigint;
  paymentId: bigint;
  academicYearId: bigint;
  receiptNo: number;
  amount: number;
  issuedAt: Date;
  issuedBy: bigint;
  voidedAt: Date | null;
  lines: ReceiptLineRecord[];
}

const SELECT = {
  id: true,
  paymentId: true,
  academicYearId: true,
  receiptNo: true,
  amount: true,
  issuedAt: true,
  issuedBy: true,
  voidedAt: true,
} as const;

const LINE_SELECT = {
  id: true,
  receiptId: true,
  studentId: true,
  chargeId: true,
  feeHeadName: true,
  period: true,
  amount: true,
} as const;

export interface NewReceiptLine {
  studentId: bigint;
  /** Null for the advance line. */
  chargeId: bigint | null;
  feeHeadName: string | null;
  period: string | null;
  amount: number;
}

@Injectable()
export class ReceiptRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /**
   * The year's next receipt number: the receipt_<yearId> counter advanced by one, its row locked
   * to the end of the transaction (so numbers follow commit order and a rollback leaves no gap).
   * Created at 1 when the year predates its counter (academic-year creation writes it; a backfill
   * wrote it for older years). Call it last (R236).
   */
  async nextNumber(schoolId: SchoolId, academicYearId: bigint): Promise<number> {
    const name = receiptCounterName(academicYearId);
    const rows = await this.txHost.tx.$queryRaw<{ value: bigint }[]>`
      INSERT INTO school_counters (school_id, name, value)
      VALUES (${schoolId}, ${name}, 1)
      ON CONFLICT (school_id, name)
      DO UPDATE SET value = school_counters.value + 1, updated_at = now()
      RETURNING value`;
    const value = rows[0]?.value;
    if (value === undefined) throw new Error('receipt counter not advanced');
    return Number(value);
  }

  async create(
    schoolId: SchoolId,
    data: { paymentId: bigint; academicYearId: bigint; receiptNo: number; amount: number; issuedBy: bigint; lines: readonly NewReceiptLine[] },
    now: Date,
  ): Promise<ReceiptRecord> {
    const { lines, ...receipt } = data;
    const row = await this.txHost.tx.receipt.create({
      data: { schoolId, ...receipt, issuedAt: now },
      select: SELECT,
    });
    await this.txHost.tx.receiptLine.createMany({
      data: lines.map((line) => ({ schoolId, receiptId: row.id, academicYearId: row.academicYearId, ...line })),
    });
    const [created] = await this.withLines(schoolId, [row]);
    if (!created) throw new Error('receipt not written');
    return created;
  }

  async findById(schoolId: SchoolId, id: bigint): Promise<ReceiptRecord | null> {
    const row = await this.txHost.tx.receipt.findFirst({ where: { schoolId, id }, select: SELECT });
    return row === null ? null : ((await this.withLines(schoolId, [row]))[0] ?? null);
  }

  /** The receipts of these payments, with their lines. */
  async ofPayments(schoolId: SchoolId, paymentIds: readonly bigint[]): Promise<ReceiptRecord[]> {
    if (paymentIds.length === 0) return [];
    const rows = await this.txHost.tx.receipt.findMany({
      where: { schoolId, paymentId: { in: [...new Set(paymentIds)] } },
      select: SELECT,
      orderBy: { id: 'asc' },
    });
    return this.withLines(schoolId, rows);
  }

  private async withLines(schoolId: SchoolId, rows: readonly Omit<ReceiptRecord, 'lines'>[]): Promise<ReceiptRecord[]> {
    if (rows.length === 0) return [];
    const lines = await this.txHost.tx.receiptLine.findMany({
      where: { schoolId, receiptId: { in: rows.map((r) => r.id) } },
      select: LINE_SELECT,
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => ({
      ...row,
      lines: lines.filter((l) => l.receiptId === row.id).map(({ receiptId: _receiptId, ...line }) => line),
    }));
  }
}
