import { proRate, type CounterPaymentMethod, type PaymentMethod } from '@asms/shared';
import type { PayrollRunRecord, SkippedStaff } from '../../repositories/payroll-run.repository';
import type { PayslipRecord } from '../../repositories/payslip.repository';
import type { SalaryAdvanceRecord } from '../../repositories/salary-advance.repository';
import type { SalaryStructureRecord } from '../../repositories/salary-structure.repository';
import { toDateString } from '../academics/academics.shared';
import type { PayslipDays } from './payslip-compute';
import type {
  AdvanceDto,
  DeductionNotTakenDto,
  PayrollRunDto,
  PayslipDto,
  SalaryStructureDto,
} from './payroll.dto';

// Row → DTO for slice 25. Ids travel as strings, dates as YYYY-MM-DD.

/** carried_forward is a payment-only method, refused on these tables by CHECK. */
const counterMethod = (method: PaymentMethod): CounterPaymentMethod =>
  method === 'carried_forward' ? 'cash' : method;

export function toSalaryStructureDto(row: SalaryStructureRecord): SalaryStructureDto {
  return {
    id: row.id.toString(),
    staffId: row.staffId.toString(),
    basic: row.basic,
    components: row.components.map((c) => ({ kind: c.kind, name: c.name, amount: c.amount })),
    effectiveFrom: toDateString(row.effectiveFrom),
    endedOn: row.endedOn === null ? null : toDateString(row.endedOn),
    status: row.status,
    supersededBy: row.supersededBy?.toString() ?? null,
    createdByUserId: row.createdBy.toString(),
    reason: row.reason,
    selfApproved: row.selfApproved,
    createdAt: row.createdAt,
  };
}

export function toAdvanceDto(row: SalaryAdvanceRecord): AdvanceDto {
  return {
    id: row.id.toString(),
    staffId: row.staffId.toString(),
    staffName: row.staffName,
    amount: row.amount,
    grantedOn: toDateString(row.grantedOn),
    recoverFrom: row.recoverFrom,
    instalmentAmount: row.instalmentAmount,
    recoveredAmount: row.recoveredAmount,
    outstanding: row.amount - row.recoveredAmount,
    approvedByUserId: row.approvedBy.toString(),
    paidMethod: counterMethod(row.paidMethod),
    paidReference: row.paidReference,
    expenseId: row.expenseId?.toString() ?? null,
    status: row.status,
    writtenOffAt: row.writtenOffAt,
    writeOffReason: row.writeOffReason,
  };
}

const isSkipped = (value: unknown): value is SkippedStaff =>
  typeof value === 'object' &&
  value !== null &&
  'staffId' in value &&
  typeof value.staffId === 'string' &&
  'reason' in value &&
  typeof value.reason === 'string';

/** The stored skipped staff (allowlisted jsonb). */
export function skippedOf(row: PayrollRunRecord): SkippedStaff[] {
  if (!Array.isArray(row.skipped)) return [];
  return row.skipped.flatMap((item: unknown) => (isSkipped(item) ? [item] : []));
}

export function toPayrollRunDto(
  row: PayrollRunRecord,
  names: ReadonlyMap<string, string>,
  unmarkedDaysTotal: number,
): PayrollRunDto {
  return {
    id: row.id.toString(),
    yearMonth: row.yearMonth,
    workingDays: row.workingDays,
    status: row.status,
    preparedAt: row.preparedAt,
    preparedByUserId: row.preparedBy?.toString() ?? null,
    finalisedByUserId: row.finalisedBy?.toString() ?? null,
    finalisedAt: row.finalisedAt,
    finaliseReason: row.finaliseReason,
    staffCount: row.staffCount,
    skipped: skippedOf(row).map((s) => ({ staffId: s.staffId, name: names.get(s.staffId) ?? '', reason: s.reason })),
    totalNet: row.totalNet,
    unmarkedDaysTotal,
  };
}

/**
 * What each named deduction of the structure wanted this month (pro-rated, R246) and could not
 * take (§3.3: listed on the slip, never carried). A deduction appears at most once per structure.
 */
function deductionsNotTaken(row: PayslipRecord): DeductionNotTakenDto[] {
  const taken = new Map(row.lines.filter((l) => l.kind === 'deduction').map((l) => [l.name, l.amount]));
  return row.structureDeductions.flatMap((d) => {
    const wanted = proRate(d.amount, row.employedWorkingDays, row.run.workingDays);
    const short = wanted - (taken.get(d.name) ?? 0);
    return short > 0 && row.employedWorkingDays > 0 ? [{ name: d.name, amount: short }] : [];
  });
}

export function toPayslipDto(row: PayslipRecord, days: PayslipDays | null = null): PayslipDto {
  return {
    id: row.id.toString(),
    runId: row.runId.toString(),
    yearMonth: row.run.yearMonth,
    runStatus: row.run.status,
    staffId: row.staffId.toString(),
    staffName: row.staffName,
    designation: row.designation,
    workingDays: row.run.workingDays,
    employedWorkingDays: row.employedWorkingDays,
    basic: row.basic,
    lines: row.lines.map((l) => ({
      id: l.id.toString(),
      kind: l.kind,
      name: l.name,
      amount: l.amount,
      adjustsPayslipId: l.adjustsPayslipId?.toString() ?? null,
      reason: l.reason,
    })),
    allowancesTotal: row.allowancesTotal,
    deductionsTotal: row.deductionsTotal,
    deductionsNotTaken: deductionsNotTaken(row),
    unpaidDays: row.unpaidDays,
    unmarkedDays: row.unmarkedDays,
    absenceDeduction: row.absenceDeduction,
    advanceRecovery: row.advanceRecovery,
    adjustmentTotal: row.adjustmentTotal,
    net: row.net,
    status: row.status,
    paidOn: row.paidOn === null ? null : toDateString(row.paidOn),
    paidMethod: row.paidMethod === null ? null : counterMethod(row.paidMethod),
    paidReference: row.paidReference,
    days,
  };
}
