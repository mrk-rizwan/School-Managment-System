'use client';

import { ErrorCode, formatRupees } from '@asms/shared';
import { Badge } from '@/components/ui/badge';
import type { RefusalMessages } from '@/lib/api/errors';
import type {
  AdvanceStatus,
  CounterPaymentMethod,
  PayrollRunStatus,
  PayslipDto,
  PayslipStatus,
} from '@/lib/api/school-payroll-contract';

// Pieces shared by the salary screens (phase-3-financial.md slice 25): the payroll page, a run's
// review, the staff page's Salary tab and My payslips.

export const payrollKeys = {
  all: ['school', 'payroll'] as const,
  runs: ['school', 'payroll', 'runs'] as const,
  run: (id: string) => ['school', 'payroll', 'runs', id] as const,
  advances: ['school', 'payroll', 'advances'] as const,
  structures: (staffId: string) => ['school', 'payroll', 'structures', staffId] as const,
  mine: ['school', 'payroll', 'mine'] as const,
};

export const METHOD_LABELS: Record<CounterPaymentMethod, string> = {
  cash: 'Cash',
  bank_transfer: 'Bank transfer',
  jazzcash: 'JazzCash',
  easypaisa: 'Easypaisa',
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `2026-09` → "September 2026". */
export const monthLabel = (yearMonth: string): string =>
  `${MONTHS[Number(yearMonth.slice(5, 7)) - 1] ?? ''} ${yearMonth.slice(0, 4)}`;

export const SKIP_LABELS: Record<string, string> = {
  suspended: 'Suspended',
  no_salary_structure: 'No salary recorded',
  not_employed: 'Not employed this month',
};

export function RunStatusBadge({ status }: { status: PayrollRunStatus }) {
  return <Badge variant={status === 'draft' ? 'outline' : 'secondary'}>{status === 'draft' ? 'Draft' : 'Finalised'}</Badge>;
}

export function PayslipStatusBadge({ status }: { status: PayslipStatus }) {
  return <Badge variant={status === 'paid' ? 'secondary' : 'outline'}>{status === 'paid' ? 'Paid' : 'Not paid'}</Badge>;
}

export function AdvanceStatusBadge({ status }: { status: AdvanceStatus }) {
  const label = status === 'open' ? 'Recovering' : status === 'recovered' ? 'Recovered' : 'Written off';
  return <Badge variant={status === 'open' ? 'outline' : 'secondary'}>{label}</Badge>;
}

/** A signed adjustment: "+Rs 1,500" or "-Rs 500". */
export const signedRupees = (amount: number) => (amount > 0 ? `+${formatRupees(amount)}` : formatRupees(amount));

/** The print view, opened in a new tab with the session cookie (R237). */
export function PrintLink({ href }: { href: string }) {
  return (
    <a className="text-sm font-medium text-primary underline-offset-4 hover:underline" href={href} target="_blank" rel="noopener noreferrer">
      Print
    </a>
  );
}

/** A payslip's figures, as the print view lays them out. */
export function PayslipBreakdown({ slip }: { slip: PayslipDto }) {
  const row = (label: string, amount: string, muted = false) => (
    <div key={label} className={`flex justify-between gap-4 text-sm ${muted ? 'text-muted-foreground' : ''}`}>
      <span>{label}</span>
      <span className="tabular-nums">{amount}</span>
    </div>
  );
  return (
    <div className="grid gap-1">
      {row(`Basic (${slip.employedWorkingDays} of ${slip.workingDays} working days)`, formatRupees(slip.basic))}
      {slip.lines.map((l) =>
        row(
          l.kind === 'adjustment' ? `${l.name} (adjustment)` : l.name,
          l.kind === 'allowance' ? formatRupees(l.amount) : l.kind === 'adjustment' ? signedRupees(l.amount) : `-${formatRupees(l.amount)}`,
        ),
      )}
      {slip.deductionsNotTaken.map((d) => row(`${d.name}: not deducted this month`, formatRupees(d.amount), true))}
      <div className="mt-1 flex justify-between gap-4 border-t pt-1 font-medium">
        <span>Net pay</span>
        <span className="tabular-nums">{formatRupees(slip.net)}</span>
      </div>
    </div>
  );
}

/** The salary refusals in words the user can act on. */
export const PAYROLL_REFUSALS: RefusalMessages = {
  [`${ErrorCode.SELF_ACTION_FORBIDDEN}:own_salary`]: 'Nobody sets their own salary. Ask a colleague.',
  [`${ErrorCode.SELF_ACTION_FORBIDDEN}:own_advance`]: 'Nobody grants or writes off their own advance. Ask a colleague.',
  [`${ErrorCode.SELF_ACTION_FORBIDDEN}:own_payslip`]: 'Nobody adjusts their own payslip. Ask a colleague.',
  [`${ErrorCode.PERMISSION_DENIED}:principal_required`]: 'Only a principal can do this.',
  [ErrorCode.SALARY_STRUCTURE_IN_USE]: 'The current salary was paid for that month. Start the change in a later month.',
  [ErrorCode.ADVANCE_NOT_OPEN]: 'This advance is already recovered or written off.',
  [ErrorCode.PAYROLL_RUN_EXISTS]: 'That month already has a payroll run.',
  [ErrorCode.PAYROLL_RUN_FINALISED]: 'This run is finalised and can no longer change.',
  [ErrorCode.PAYROLL_RUN_NOT_DRAFT]: 'This run is already finalised.',
  [ErrorCode.PAYSLIP_PAID]: 'This payslip is already marked paid.',
  [ErrorCode.ILLEGAL_STATUS_TRANSITION]: 'Finalise the run before marking payslips paid.',
  [ErrorCode.STAFF_NOT_ACTIVE]: 'This staff member is not active.',
};
