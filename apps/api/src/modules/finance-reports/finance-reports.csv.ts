import type { CsvColumn } from '@asms/shared';
import type {
  ConcessionRowDto,
  DailyCashReportDto,
  DefaulterDto,
  FinancialStatementDto,
  PayrollMonthDto,
  PayrollReportDto,
  ReportRowDto,
  StatementFiguresDto,
} from './finance-reports.dto';

// Phase 5 slice 42 (contracts/slice-42.md §3, R336): the CSV columns of each finance report —
// exactly the rows and columns the web tab shows. Amounts are whole rupees, written as numbers.

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

export const DEFAULTER_COLUMNS: readonly CsvColumn<DefaulterDto>[] = [
  { header: 'Student', value: (r) => r.studentName },
  { header: 'Admission no', value: (r) => r.admissionNo },
  { header: 'Class', value: (r) => r.className },
  { header: 'Section', value: (r) => r.sectionName },
  { header: 'Outstanding', value: (r) => r.outstanding },
  { header: 'Overdue', value: (r) => r.overdue },
  { header: 'Oldest due', value: (r) => r.oldestDueOn },
  { header: 'Open charges', value: (r) => r.openCharges },
  { header: 'Fee payer', value: (r) => r.feePayer?.name ?? null },
  { header: 'Contact', value: (r) => r.feePayer?.contactCapability ?? null },
  { header: 'Last payment', value: (r) => r.lastPaymentOn },
  { header: 'Last reminder', value: (r) => iso(r.lastReminderAt) },
  { header: 'Claim pending', value: (r) => r.pendingClaim },
];

/** The grouped reports (collections, outstanding, expenses): one row per group. */
export const GROUP_COLUMNS: readonly CsvColumn<ReportRowDto>[] = [
  { header: 'Group', value: (r) => r.label },
  { header: 'Amount', value: (r) => r.amount },
  { header: 'Count', value: (r) => r.count },
];

export const CONCESSION_COLUMNS: readonly CsvColumn<ConcessionRowDto>[] = [
  { header: 'Group', value: (r) => r.label },
  { header: 'Students', value: (r) => r.students },
  { header: 'Reduction', value: (r) => r.reduction },
];

export const PAYROLL_COLUMNS: readonly CsvColumn<PayrollMonthDto & { label: string }>[] = [
  { header: 'Month', value: (r) => r.label },
  { header: 'Staff', value: (r) => r.staffCount },
  { header: 'Gross', value: (r) => r.gross },
  { header: 'Deductions', value: (r) => r.deductions },
  { header: 'Adjustments', value: (r) => r.adjustments },
  { header: 'Net', value: (r) => r.net },
  { header: 'Paid', value: (r) => r.paid },
  { header: 'Unpaid', value: (r) => r.unpaid },
];

/** The months, then the total row (labelled Total), as the tab shows them. */
export const payrollRows = (body: PayrollReportDto): (PayrollMonthDto & { label: string })[] => [
  ...body.rows.map((r) => ({ ...r, label: r.yearMonth })),
  { ...body.total, label: 'Total' },
];

/** Daily cash as its summary lines (the tab's two line lists and the handover totals). */
export const dailyCashRows = (body: DailyCashReportDto): { line: string; amount: number }[] => [
  { line: 'Cash received', amount: body.cashReceived },
  { line: 'Voided before handover', amount: body.voidedBeforeHandover },
  { line: 'Still with collectors', amount: body.withCollectors.reduce((sum, c) => sum + c.amount, 0) },
  { line: 'Handed over', amount: body.handedOver.reduce((sum, h) => sum + h.fromDay, 0) },
  { line: 'Voided after handover', amount: body.voidedAfterHandover },
  { line: 'Refunds paid in cash', amount: body.refundsPaidCash },
  { line: 'Cash expenses', amount: body.cashExpenses },
  { line: 'Shortfalls written off (in cash expenses)', amount: body.shortfallWrittenOff },
  { line: 'Salaries paid in cash', amount: body.salariesPaidCash },
];

export const LINE_COLUMNS: readonly CsvColumn<{ line: string; amount: number }>[] = [
  { header: 'Line', value: (r) => r.line },
  { header: 'Amount', value: (r) => r.amount },
];

export const statementRows = (body: FinancialStatementDto): StatementFiguresDto[] => [
  ...body.months,
  { ...body.total, period: 'Total' },
];

export const STATEMENT_COLUMNS: readonly CsvColumn<StatementFiguresDto>[] = [
  { header: 'Period', value: (r) => r.period },
  { header: 'From', value: (r) => r.from },
  { header: 'To', value: (r) => r.to },
  { header: 'Receipts', value: (r) => r.receipts },
  { header: 'Refund reversals', value: (r) => r.refundReversals },
  { header: 'Refunds', value: (r) => r.refunds },
  { header: 'Net receipts', value: (r) => r.netReceipts },
  { header: 'Expenses', value: (r) => r.expenses },
  { header: 'Shortfall write-offs', value: (r) => r.shortfallWriteOffs },
  { header: 'Salaries', value: (r) => r.salaries },
  { header: 'Advances paid', value: (r) => r.advancesPaid },
  { header: 'Advance recoveries', value: (r) => r.advanceRecoveries },
  { header: 'Staff', value: (r) => r.staff },
  { header: 'Expenditure', value: (r) => r.expenditure },
  { header: 'Net', value: (r) => r.net },
];
