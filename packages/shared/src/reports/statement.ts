/**
 * The financial statement (Phase 5 rule 38, phase-5-extended.md §1.1, §3.3; R332): income against
 * expenditure for a period, on the basis the school chooses (rule 25: every money row stores the
 * day it happened and the day it was verified or decided). The repository reads the rows; this
 * sums them, so the arithmetic is one table-tested function.
 *
 * Lines, by kind (the caller sends only rows that count: payments not voided and not
 * `carried_forward`; expenses `recorded` or `approved`; payslips `paid`):
 * - `receipt`: a payment, on `received_on` / its verification day.
 * - `refund_reversal`: a refund reversed, which brings the money back.
 * - `refund`: money paid back to a family.
 * - `expense`: a recorded or approved expense, on `spent_on` / its decision day.
 * - `shortfall_write_off`: a cash-handover shortfall written off, its own line.
 * - `salary`: a paid payslip's net, on `paid_on`.
 * - `advance_paid`: a salary advance paid out.
 * - `advance_recovery`: an instalment recovered from a payslip. Shown, never subtracted: the
 *   payslip's net already excludes it.
 */
export type StatementLineKind =
  | 'receipt'
  | 'refund_reversal'
  | 'refund'
  | 'expense'
  | 'shortfall_write_off'
  | 'salary'
  | 'advance_paid'
  | 'advance_recovery';

export interface StatementLine {
  readonly kind: StatementLineKind;
  /** Whole rupees, at least 0. */
  readonly amount: number;
  /** `YYYY-MM-DD`: the day it was received, spent or paid. */
  readonly occurredOn: string;
  /** `YYYY-MM-DD`: the day it was verified or decided; null while it is not (left out on `verified`). */
  readonly verifiedOn: string | null;
}

/** An inclusive date range, `YYYY-MM-DD`. */
export interface StatementPeriod {
  readonly from: string;
  readonly to: string;
}

export interface FinancialStatement {
  readonly receipts: number;
  readonly refundReversals: number;
  readonly refunds: number;
  /** receipts + refundReversals − refunds. */
  readonly netReceipts: number;
  readonly expenses: number;
  readonly shortfallWriteOffs: number;
  readonly salaries: number;
  readonly advancesPaid: number;
  /** Informational (already inside the salaries' net). */
  readonly advanceRecoveries: number;
  /** salaries + advancesPaid. */
  readonly staff: number;
  /** expenses + shortfallWriteOffs + staff. */
  readonly expenditure: number;
  /** netReceipts − expenditure; negative when the period spent more than it took. */
  readonly net: number;
}

const DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/**
 * Sums the lines that fall in `period` on `basis` (`received`: the day it happened; `verified`:
 * the day it was verified or decided, lines with none left out). Throws on a malformed period or
 * a negative or fractional amount: the rows come from the database, so either is a bug.
 */
export function financialStatement(
  lines: readonly StatementLine[],
  basis: 'received' | 'verified',
  period: StatementPeriod,
): FinancialStatement {
  if (!DAY.test(period.from) || !DAY.test(period.to) || period.from > period.to) {
    throw new RangeError('a statement period is two dates, from <= to');
  }
  const sums: Record<StatementLineKind, number> = {
    receipt: 0,
    refund_reversal: 0,
    refund: 0,
    expense: 0,
    shortfall_write_off: 0,
    salary: 0,
    advance_paid: 0,
    advance_recovery: 0,
  };
  for (const line of lines) {
    if (!Number.isSafeInteger(line.amount) || line.amount < 0) {
      throw new RangeError('a statement amount is a whole number of rupees, at least 0');
    }
    const day = basis === 'received' ? line.occurredOn : line.verifiedOn;
    if (day === null || day < period.from || day > period.to) continue;
    sums[line.kind] += line.amount;
  }
  const netReceipts = sums.receipt + sums.refund_reversal - sums.refund;
  const staff = sums.salary + sums.advance_paid;
  const expenditure = sums.expense + sums.shortfall_write_off + staff;
  return {
    receipts: sums.receipt,
    refundReversals: sums.refund_reversal,
    refunds: sums.refund,
    netReceipts,
    expenses: sums.expense,
    shortfallWriteOffs: sums.shortfall_write_off,
    salaries: sums.salary,
    advancesPaid: sums.advance_paid,
    advanceRecoveries: sums.advance_recovery,
    staff,
    expenditure,
    net: netReceipts - expenditure,
  };
}
