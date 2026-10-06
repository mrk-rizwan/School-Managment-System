import { formatDay, formatRupees } from '@asms/shared';
import { api, unwrap } from '../api/client';
import type { MySalaryStructureDto, PayslipDto } from '../api/contracts';

// My payslips (phase-3-financial.md slice 25, §3.5, R217): a staff member's own salary and the
// payslips of finalised runs. Read online only — never the SQLite cache or the outbox — rendered
// natively from PayslipDto and shared as text (no WebView, no PDF).

type Page<T> = { data: T[]; page: number; limit: number; total: number };

export const PAYSLIP_LIMIT = 12;

export const payslipKeys = {
  all: ['me', 'staff', 'payslips'] as const,
  salary: ['me', 'staff', 'payslips', 'salary'] as const,
  list: (page: number) => ['me', 'staff', 'payslips', 'list', page] as const,
};

export const fetchSalary = (): Promise<MySalaryStructureDto> => unwrap(api.GET('/api/v1/me/staff/salary-structure'));

export const fetchPayslips = (page: number): Promise<Page<PayslipDto>> =>
  unwrap(api.GET('/api/v1/me/staff/payslips', { params: { query: { page, limit: PAYSLIP_LIMIT } } }));

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `2026-09` → "September 2026". */
export const monthLabel = (yearMonth: string): string =>
  `${MONTHS[Number(yearMonth.slice(5, 7)) - 1] ?? ''} ${yearMonth.slice(0, 4)}`;

export interface PayslipRow {
  label: string;
  amount: string;
}

/** The payslip's lines in print order: basic, allowances, deductions, adjustments, net. */
export function payslipRows(slip: PayslipDto): PayslipRow[] {
  const rows: PayslipRow[] = [
    { label: `Basic (${slip.employedWorkingDays} of ${slip.workingDays} working days)`, amount: formatRupees(slip.basic) },
  ];
  for (const line of slip.lines) {
    if (line.kind === 'allowance') rows.push({ label: line.name, amount: formatRupees(line.amount) });
  }
  for (const line of slip.lines) {
    if (line.kind === 'deduction' || line.kind === 'absence' || line.kind === 'advance_recovery') {
      rows.push({ label: line.name, amount: `-${formatRupees(line.amount)}` });
    }
  }
  for (const line of slip.lines) {
    if (line.kind === 'adjustment') {
      rows.push({ label: line.name, amount: line.amount > 0 ? `+${formatRupees(line.amount)}` : formatRupees(line.amount) });
    }
  }
  rows.push({ label: 'Net pay', amount: formatRupees(slip.net) });
  return rows;
}

/** "Paid on Thu 1 Oct, cash" or "Not yet paid". */
export function paidLine(slip: PayslipDto): string {
  if (slip.status !== 'paid' || slip.paidOn === null) return 'Not yet paid';
  const method = slip.paidMethod === null ? '' : `, ${slip.paidMethod.replace('_', ' ')}`;
  return `Paid on ${formatDay(slip.paidOn)}${method}`;
}

/** The payslip as plain text for the share sheet. */
export function payslipText(slip: PayslipDto, schoolName: string): string {
  return [
    schoolName,
    `Payslip, ${monthLabel(slip.yearMonth)}`,
    slip.staffName,
    '',
    ...payslipRows(slip).map((r) => `${r.label}: ${r.amount}`),
    ...slip.deductionsNotTaken.map((d) => `${d.name}: ${formatRupees(d.amount)} not deducted this month`),
    '',
    `Unpaid days: ${slip.unpaidDays}. ${paidLine(slip)}.`,
  ].join('\n');
}
