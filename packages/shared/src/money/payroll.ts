// Payroll, leave and billing pure functions (phase-3-financial.md §3.3). Each is the one
// definition of its rule; the services call it, the tests table it.
import type { StaffAttendanceStatus } from '../attendance';

/** `floor(x × employed ÷ working)`; the full amount when the month has no working day (§1.1). */
export function proRate(x: number, employedWorkingDays: number, workingDays: number): number {
  if (workingDays === 0) return x;
  return Math.floor((x * employedWorkingDays) / workingDays);
}

/** `floor(basic ÷ working days) × unpaid days`; 0 when the month has no working day (R245). */
export function absenceDeduction(basic: number, workingDays: number, unpaidDays: number): number {
  if (workingDays === 0) return 0;
  return Math.floor(basic / workingDays) * unpaidDays;
}

// ------------------------------------------------------------------------------ unpaid days

export interface ApprovedLeave {
  /** `YYYY-MM-DD`, inclusive. A request spanning months counts only the days passed in. */
  readonly startsOn: string;
  readonly endsOn: string;
  readonly paid: boolean;
}

export interface UnpaidDays {
  readonly unpaidDays: number;
  /** Working days with no attendance mark: paid, counted for the draft. */
  readonly unmarkedDays: number;
  /** `on_leave` marks with no approved leave: unpaid, listed so leave can be approved retroactively. */
  readonly unapprovedLeaveDays: string[];
}

/**
 * The unpaid-day matrix of §3.3 (R245), over the run month's working days. Attendance wins over
 * leave when the person was present: present or late is always paid. Absent is paid only under
 * approved paid leave; `on_leave` likewise; an unmarked day is paid unless approved unpaid leave
 * covers it.
 */
export function unpaidDays(
  marks: ReadonlyMap<string, StaffAttendanceStatus>,
  approvedLeave: readonly ApprovedLeave[],
  workingDays: readonly string[],
): UnpaidDays {
  let unpaid = 0;
  let unmarked = 0;
  const unapproved: string[] = [];
  for (const day of workingDays) {
    const leave = approvedLeave.find((l) => l.startsOn <= day && day <= l.endsOn);
    const mark = marks.get(day);
    if (mark === 'present' || mark === 'late') continue;
    if (mark === undefined) {
      if (!leave) unmarked += 1;
      else if (!leave.paid) unpaid += 1;
      continue;
    }
    // absent or on_leave
    if (leave?.paid) continue;
    unpaid += 1;
    if (mark === 'on_leave' && !leave) unapproved.push(day);
  }
  return { unpaidDays: unpaid, unmarkedDays: unmarked, unapprovedLeaveDays: unapproved };
}

// ------------------------------------------------------------------------------ payslip net

export interface NamedAmount {
  readonly name: string;
  readonly amount: number;
}

export interface AdvanceInstalment {
  readonly advanceId: bigint;
  /** The instalment due this month. */
  readonly instalment: number;
  /** What the advance still has to recover. */
  readonly remaining: number;
}

export interface PayslipNetInput {
  /** Pro-rated basic. */
  readonly basic: number;
  /** Pro-rated allowances. */
  readonly allowances: number;
  /** Signed adjustments, applied with the gross. */
  readonly adjustment: number;
  /** absenceDeduction() of the month. */
  readonly absence: number;
  /** Named deductions in their listed order (`position`). */
  readonly deductions: readonly NamedAmount[];
  /** Open advances in grant order. */
  readonly advances: readonly AdvanceInstalment[];
}

export interface PayslipNet {
  readonly ok: true;
  readonly net: number;
  readonly absence: number;
  /** What each named deduction took, and what it could not take (listed, never carried). */
  readonly deductions: readonly { name: string; amount: number; shortBy: number }[];
  readonly deductionsTotal: number;
  readonly recoveries: readonly { advanceId: bigint; amount: number }[];
  readonly recoveryTotal: number;
}

/**
 * A negative adjustment larger than basic + allowances: the slip cannot satisfy `net >= 0` with
 * the adjustment stored as entered, so the service refuses that adjustment instead of clamping it.
 */
export interface PayslipNetRefused {
  readonly ok: false;
  readonly reason: 'adjustment_exceeds_pay';
  /** basic + allowances + adjustment (negative). */
  readonly gross: number;
}

/**
 * Net pay (§3.3, R247): from the gross (basic + allowances + adjustment) take the absence
 * deduction, then each named deduction in order, then each advance's instalment in grant order;
 * each stops before net goes negative. A gross below zero is refused, never clamped, so the stored
 * lines always satisfy `net = basic + allowances − deductions − absence − recovery + adjustment`.
 */
export function payslipNet(input: PayslipNetInput): PayslipNet | PayslipNetRefused {
  const gross = input.basic + input.allowances + input.adjustment;
  if (gross < 0) return { ok: false, reason: 'adjustment_exceeds_pay', gross };
  let left = gross;
  const take = (wanted: number): number => {
    const taken = Math.min(Math.max(0, wanted), left);
    left -= taken;
    return taken;
  };
  const absence = take(input.absence);
  const deductions = input.deductions.map((d) => {
    const amount = take(d.amount);
    return { name: d.name, amount, shortBy: d.amount - amount };
  });
  const recoveries = input.advances
    .map((a) => ({ advanceId: a.advanceId, amount: take(Math.min(a.instalment, a.remaining)) }))
    .filter((r) => r.amount > 0);
  return {
    ok: true,
    net: left,
    absence,
    deductions,
    deductionsTotal: deductions.reduce((sum, d) => sum + d.amount, 0),
    recoveries,
    recoveryTotal: recoveries.reduce((sum, r) => sum + r.amount, 0),
  };
}

// -------------------------------------------------------------------------------- leave

export interface LeaveBalance {
  /** Null for a type without a limit (unpaid). */
  readonly entitled: number | null;
  readonly taken: number;
  readonly remaining: number | null;
}

/**
 * A staff member's balance of one leave type for a calendar `year` (rule 22, R209): the yearly
 * entitlement pro-rated by the whole months employed from `joinedOn` (a month counts when the
 * person was employed from its 1st), full when `joinedOn` is null or before the year, nothing when
 * after it.
 */
export function leaveBalance(
  entitlement: number | null,
  joinedOn: string | null,
  year: number,
  approvedDays: number,
): LeaveBalance {
  if (entitlement === null) return { entitled: null, taken: approvedDays, remaining: null };
  let months = 12;
  if (joinedOn !== null) {
    const joinedYear = Number(joinedOn.slice(0, 4));
    const joinedMonth = Number(joinedOn.slice(5, 7));
    const fromFirst = joinedOn.slice(8, 10) === '01';
    if (joinedYear > year) months = 0;
    else if (joinedYear === year) months = 12 - joinedMonth + (fromFirst ? 1 : 0);
  }
  const entitled = Math.floor((entitlement * months) / 12);
  return { entitled, taken: approvedDays, remaining: entitled - approvedDays };
}

// ------------------------------------------------------------------------------ billing tier

export interface PlanBand {
  readonly id: bigint;
  readonly minStudents: number;
  /** Null: no upper bound. */
  readonly maxStudents: number | null;
  readonly status: 'active' | 'archived';
}

/** The active plan whose band (inclusive) contains `studentCount` (rule 23, A12); null when none. */
export function tierFor<T extends PlanBand>(studentCount: number, tiers: readonly T[]): T | null {
  return (
    tiers.find(
      (t) =>
        t.status === 'active' &&
        studentCount >= t.minStudents &&
        (t.maxStudents === null || studentCount <= t.maxStudents),
    ) ?? null
  );
}
