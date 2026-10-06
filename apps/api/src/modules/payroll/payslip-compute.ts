// One staff member's payslip for a run month (phase-3-financial.md §3.3, R214, R245-R247), from
// the month's inputs, through the shared pure functions only: proRate, unpaidDays (the R245
// matrix), absenceDeduction and payslipNet. Pure: the service reads the inputs once per run and
// writes what this returns.
import {
  absenceDeduction,
  payslipNet,
  proRate,
  unpaidDays,
  type ApprovedLeave,
  type SalaryComponentKind,
  type StaffAttendanceStatus,
} from '@asms/shared';
import type { ComputedLine, PayslipFigures } from '../../repositories/payslip.repository';

export interface StructureInput {
  id: bigint;
  basic: number;
  /** In `position` order. */
  components: readonly { kind: SalaryComponentKind; name: string; amount: number }[];
}

export interface AdvanceInput {
  advanceId: bigint;
  /** `YYYY-MM-DD`, for the line's name. */
  grantedOn: string;
  instalment: number;
  remaining: number;
}

export interface PayslipInput {
  /** The run month's staff working days, `YYYY-MM-DD`, ascending. */
  monthWorkingDays: readonly string[];
  /** The employed window inside the month, inclusive. */
  window: { from: string; to: string };
  structure: StructureInput;
  marks: ReadonlyMap<string, StaffAttendanceStatus>;
  leave: readonly ApprovedLeave[];
  /** Open advances in grant order, recovering this month. */
  advances: readonly AdvanceInput[];
  /** Σ of the payslip's adjustment lines (signed). */
  adjustment: number;
}

/** The working days behind the counts, for the run's review screen (not stored). */
export interface PayslipDays {
  unpaid: string[];
  unmarked: string[];
  /** `on_leave` marks with no approved leave: unpaid, so leave can be approved retroactively. */
  unapprovedLeave: string[];
}

export interface ComputedPayslip {
  figures: PayslipFigures;
  lines: ComputedLine[];
  recoveries: { advanceId: bigint; amount: number }[];
  days: PayslipDays;
}

/** payslipNet's refusal: the adjustments take more than basic + allowances (never clamped). */
export interface PayslipRefused {
  refused: true;
  /** basic + allowances + adjustment, negative. */
  gross: number;
  /** basic + allowances. */
  pay: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `12 Sep 2026`. */
export const shortDay = (day: string): string =>
  `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1] ?? ''} ${day.slice(0, 4)}`;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function computePayslip(input: PayslipInput): ComputedPayslip | PayslipRefused {
  const { monthWorkingDays, window, structure } = input;
  const workingDays = monthWorkingDays.length;
  const employedDays = monthWorkingDays.filter((d) => window.from <= d && d <= window.to);
  const employed = employedDays.length;

  // R246: basic, allowances and deductions pro-rated over the employed working days.
  const basic = proRate(structure.basic, employed, workingDays);
  const allowances = structure.components
    .filter((c) => c.kind === 'allowance')
    .map((c) => ({ name: c.name, amount: proRate(c.amount, employed, workingDays) }));
  const deductions = structure.components
    .filter((c) => c.kind === 'deduction')
    .map((c) => ({ name: c.name, amount: proRate(c.amount, employed, workingDays) }));
  const allowancesTotal = allowances.reduce((sum, a) => sum + a.amount, 0);

  // R245 over the employed window; the daily rate is the full basic over the month (§3.3).
  const unpaid = unpaidDays(input.marks, input.leave, employedDays);
  const absence = absenceDeduction(structure.basic, workingDays, unpaid.unpaidDays);

  const net = payslipNet({
    basic,
    allowances: allowancesTotal,
    adjustment: input.adjustment,
    absence,
    deductions,
    advances: input.advances.map((a) => ({ advanceId: a.advanceId, instalment: a.instalment, remaining: a.remaining })),
  });
  if (!net.ok) return { refused: true, gross: net.gross, pay: basic + allowancesTotal };

  const grantedOf = new Map(input.advances.map((a) => [a.advanceId, a.grantedOn]));
  const lines: ComputedLine[] = [
    ...allowances.filter((a) => a.amount > 0).map((a) => ({ kind: 'allowance' as const, ...a })),
    ...net.deductions.filter((d) => d.amount > 0).map((d) => ({ kind: 'deduction' as const, name: d.name, amount: d.amount })),
    ...(net.absence > 0
      ? [{ kind: 'absence' as const, name: `Unpaid absence, ${plural(unpaid.unpaidDays, 'day')}`, amount: net.absence }]
      : []),
    ...net.recoveries.map((r) => ({
      kind: 'advance_recovery' as const,
      name: `Advance of ${shortDay(grantedOf.get(r.advanceId) ?? '')}`,
      amount: r.amount,
    })),
  ];

  // The days behind the counts: the same matrix, one day at a time.
  const days: PayslipDays = { unpaid: [], unmarked: [], unapprovedLeave: unpaid.unapprovedLeaveDays };
  for (const day of employedDays) {
    const one = unpaidDays(input.marks, input.leave, [day]);
    if (one.unpaidDays > 0) days.unpaid.push(day);
    if (one.unmarkedDays > 0) days.unmarked.push(day);
  }

  return {
    figures: {
      structureId: structure.id,
      employedWorkingDays: employed,
      basic,
      allowancesTotal,
      deductionsTotal: net.deductionsTotal,
      unpaidDays: unpaid.unpaidDays,
      unmarkedDays: unpaid.unmarkedDays,
      absenceDeduction: net.absence,
      advanceRecovery: net.recoveryTotal,
      adjustmentTotal: input.adjustment,
      net: net.net,
    },
    lines,
    recoveries: [...net.recoveries],
    days,
  };
}

/**
 * The figures of a payslip kept in a run for someone the run now skips (a recompute cannot delete
 * a payslip): nothing computed, only its adjustments. Null when they are negative (net < 0).
 */
export function emptyPayslip(structureId: bigint, adjustment: number): PayslipFigures | null {
  if (adjustment < 0) return null;
  return {
    structureId,
    employedWorkingDays: 0,
    basic: 0,
    allowancesTotal: 0,
    deductionsTotal: 0,
    unpaidDays: 0,
    unmarkedDays: 0,
    absenceDeduction: 0,
    advanceRecovery: 0,
    adjustmentTotal: adjustment,
    net: adjustment,
  };
}
