import { Injectable } from '@nestjs/common';
import { ErrorCode, isStaffWorkingDay, type ApprovedLeave, type StaffAttendanceStatus } from '@asms/shared';
import { ApiException } from '../../common/errors/api-exception';
import { addDays } from '../../common/school-clock';
import {
  PayrollRunRepository,
  type PayrollCandidate,
  type PayrollRunRecord,
  type PayrollStructure,
  type SkippedStaff,
} from '../../repositories/payroll-run.repository';
import {
  PayslipRepository,
  type ComputedLine,
  type NewPayslip,
  type PayslipFigures,
  type PayslipKey,
} from '../../repositories/payslip.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { fromDateString, toDateString } from '../academics/academics.shared';
import { CalendarService } from '../calendar/calendar.service';
import { computePayslip, emptyPayslip, type AdvanceInput, type PayslipDays } from './payslip-compute';

// The monthly run (phase-3-financial.md §3.3, slice 25, R214, R245-R247, §7.2): the month's inputs
// read once (staff, structures, staff attendance, approved leave, open advances: one query each),
// every payslip computed by computePayslip, then written. Used by the HTTP service and the pay-day
// job; every method takes the school explicitly and runs inside its caller's transaction.

/** Why a staff member employed in the month has no computed payslip. */
export type SkipReason = 'suspended' | 'no_salary_structure' | 'not_employed';

export interface MonthBounds {
  yearMonth: string;
  /** `YYYY-MM-01`. */
  first: string;
  /** The month's last calendar day. */
  last: string;
}

export function monthBounds(yearMonth: string): MonthBounds {
  const year = Number(yearMonth.slice(0, 4));
  const month = Number(yearMonth.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { yearMonth, first: `${yearMonth}-01`, last };
}

interface MonthInputs extends MonthBounds {
  workingDays: string[];
  candidates: PayrollCandidate[];
  structures: Map<bigint, PayrollStructure[]>;
  marks: Map<bigint, Map<string, StaffAttendanceStatus>>;
  leave: Map<bigint, ApprovedLeave[]>;
  advances: Map<bigint, AdvanceInput[]>;
}

/** One staff member's computed payslip. */
export interface PlannedSlip {
  staffId: bigint;
  figures: PayslipFigures;
  lines: ComputedLine[];
  recoveries: { advanceId: bigint; amount: number }[];
  days: PayslipDays | null;
}

export interface RunPlan {
  workingDays: number;
  slips: PlannedSlip[];
  skipped: SkippedStaff[];
}

/** A slip already in the run: its id, its structure and the Σ of its adjustment lines. */
export interface ExistingSlip extends PayslipKey {
  structureId: bigint | null;
  adjustment: number;
}

/** 422: the adjustments take more than the month's pay; payslipNet refuses rather than clamps. */
export const adjustmentExceedsPay = (path: string, staffName: string, pay: number, gross: number): ApiException =>
  new ApiException(
    422,
    ErrorCode.VALIDATION_FAILED,
    `The adjustments on ${staffName}'s payslip would take more than the month's pay of ${pay}: the slip would be ${gross}.`,
    { fields: [{ path, code: ErrorCode.INVALID_VALUE, message: `adjustments exceed basic and allowances (${pay}) by ${-gross}` }] },
  );

const group = <T>(rows: readonly T[], key: (row: T) => bigint): Map<bigint, T[]> => {
  const out = new Map<bigint, T[]>();
  for (const row of rows) {
    const list = out.get(key(row));
    if (list) list.push(row);
    else out.set(key(row), [row]);
  }
  return out;
};

const maxDay = (a: string, b: string): string => (a > b ? a : b);
const minDay = (a: string, b: string): string => (a < b ? a : b);

@Injectable()
export class PayrollEngine {
  constructor(
    private readonly runs: PayrollRunRepository,
    private readonly payslips: PayslipRepository,
    private readonly calendar: CalendarService,
  ) {}

  /** The month's staff working days (weekly offs and staff holidays out, A9). */
  async workingDays(schoolId: SchoolId, bounds: MonthBounds): Promise<string[]> {
    const from = fromDateString(bounds.first);
    const to = fromDateString(bounds.last);
    const { value } = await this.calendar.calendar(schoolId, from, to);
    const days: string[] = [];
    for (let day = from; day <= to; day = addDays(day, 1)) {
      const iso = toDateString(day);
      if (isStaffWorkingDay(iso, value)) days.push(iso);
    }
    return days;
  }

  /**
   * Reads the month once. `staffIds` narrows it to some staff (a single adjustment, a review page).
   * `lockAdvances` locks the open advances in id order before reading them (finalise: the recovery
   * trigger raises their counters, so the amounts read are the ones written).
   */
  private async inputs(
    schoolId: SchoolId,
    yearMonth: string,
    options: { staffIds?: readonly bigint[]; lockAdvances?: boolean } = {},
  ): Promise<MonthInputs> {
    const bounds = monthBounds(yearMonth);
    const from = fromDateString(bounds.first);
    const to = fromDateString(bounds.last);
    const workingDays = await this.workingDays(schoolId, bounds);
    const all = await this.runs.candidates(schoolId, from, to);
    const only = options.staffIds === undefined ? null : new Set(options.staffIds);
    const candidates = only === null ? all : all.filter((c) => only.has(c.id));
    const ids = candidates.map((c) => c.id);
    let advances = await this.runs.openAdvances(schoolId, ids, yearMonth);
    if (options.lockAdvances && advances.length > 0) {
      await this.runs.lockAdvances(schoolId, advances.map((a) => a.id));
      advances = await this.runs.openAdvances(schoolId, ids, yearMonth);
    }
    const marks = new Map<bigint, Map<string, StaffAttendanceStatus>>();
    for (const mark of await this.runs.marks(schoolId, ids, from, to)) {
      const byDay = marks.get(mark.staffId) ?? new Map<string, StaffAttendanceStatus>();
      byDay.set(toDateString(mark.date), mark.status);
      marks.set(mark.staffId, byDay);
    }
    const leave = new Map<bigint, ApprovedLeave[]>();
    for (const row of await this.runs.approvedLeave(schoolId, ids, from, to)) {
      const list = leave.get(row.staffId) ?? [];
      list.push({ startsOn: toDateString(row.startsOn), endsOn: toDateString(row.lastDay), paid: row.paid });
      leave.set(row.staffId, list);
    }
    return {
      ...bounds,
      workingDays,
      candidates,
      structures: group(await this.runs.structures(schoolId, ids, from, to), (s) => s.staffId),
      marks,
      leave,
      advances: new Map(
        [...group(advances, (a) => a.staffId)].map(([staffId, list]) => [
          staffId,
          list.map((a) => ({
            advanceId: a.id,
            grantedOn: toDateString(a.grantedOn),
            instalment: a.instalmentAmount,
            remaining: a.remaining,
          })),
        ]),
      ),
    };
  }

  /**
   * R214: every staff member employed on some day of the month — suspended ones skipped and
   * listed, those without a structure on the last day of their employed window skipped and listed —
   * computed by computePayslip. A slip already in the run for someone now skipped is kept with
   * nothing computed (a payslip is never deleted): only its adjustments. `errorPath` names the
   * field a payslipNet refusal is reported on.
   */
  async plan(
    schoolId: SchoolId,
    yearMonth: string,
    existing: readonly ExistingSlip[],
    options: { staffIds?: readonly bigint[]; lockAdvances?: boolean; errorPath?: string } = {},
  ): Promise<RunPlan> {
    const month = await this.inputs(schoolId, yearMonth, options);
    const existingOf = new Map(existing.map((e) => [e.staffId, e]));
    const slips: PlannedSlip[] = [];
    const skipped: SkippedStaff[] = [];
    const names = new Map<bigint, string>();
    const planned = new Set<bigint>();
    for (const member of month.candidates) {
      names.set(member.id, member.fullName);
      const reason = this.skipReason(member, month);
      if (reason !== null) {
        skipped.push({ staffId: member.id.toString(), reason });
        continue;
      }
      const window = this.window(member, month);
      const structure = (month.structures.get(member.id) ?? []).find(
        (s) => toDateString(s.effectiveFrom) <= window.to && (s.endedOn === null || toDateString(s.endedOn) >= window.to),
      );
      if (structure === undefined) {
        skipped.push({ staffId: member.id.toString(), reason: 'no_salary_structure' satisfies SkipReason });
        continue;
      }
      const computed = computePayslip({
        monthWorkingDays: month.workingDays,
        window,
        structure: { id: structure.id, basic: structure.basic, components: structure.components },
        marks: month.marks.get(member.id) ?? new Map(),
        leave: month.leave.get(member.id) ?? [],
        advances: month.advances.get(member.id) ?? [],
        adjustment: existingOf.get(member.id)?.adjustment ?? 0,
      });
      if ('refused' in computed) {
        throw adjustmentExceedsPay(options.errorPath ?? 'adjustments', member.fullName, computed.pay, computed.gross);
      }
      planned.add(member.id);
      slips.push({ staffId: member.id, ...computed });
    }
    // Slips kept for people the run no longer computes.
    for (const slip of existing) {
      if (planned.has(slip.staffId) || slip.structureId === null) continue;
      if (options.staffIds !== undefined && !options.staffIds.includes(slip.staffId)) continue;
      const figures = emptyPayslip(slip.structureId, slip.adjustment);
      if (figures === null) {
        throw adjustmentExceedsPay(options.errorPath ?? 'adjustments', names.get(slip.staffId) ?? 'a staff member', 0, slip.adjustment);
      }
      if (!skipped.some((s) => s.staffId === slip.staffId.toString())) {
        skipped.push({ staffId: slip.staffId.toString(), reason: 'not_employed' satisfies SkipReason });
      }
      slips.push({ staffId: slip.staffId, figures, lines: [], recoveries: [], days: null });
    }
    return { workingDays: month.workingDays.length, slips, skipped };
  }

  /** Prepares a new draft and its payslips (R214). The caller made sure none exists. */
  async prepare(schoolId: SchoolId, yearMonth: string, preparedBy: bigint | null, at: Date): Promise<PayrollRunRecord> {
    const plan = await this.plan(schoolId, yearMonth, []);
    const run = await this.runs.create(schoolId, { yearMonth, preparedBy, preparedAt: at, ...totalsOf(plan) });
    await this.payslips.createMany(schoolId, run.id, plan.slips.map(newPayslip));
    return run;
  }

  /**
   * Rewrites a draft's payslips from the month's data now (recompute, and finalise before it
   * freezes them): existing slips rewritten in place with their adjustments kept, new staff added.
   * Returns the plan and each staff member's payslip id. The caller holds the run's lock.
   */
  async recompute(
    schoolId: SchoolId,
    run: Pick<PayrollRunRecord, 'id' | 'yearMonth'>,
    preparedBy: bigint | null,
    at: Date,
    options: { lockAdvances?: boolean } = {},
  ): Promise<{ plan: RunPlan; slipIds: Map<bigint, bigint> }> {
    const existing = await this.existing(schoolId, run.id);
    const plan = await this.plan(schoolId, run.yearMonth, existing, options);
    const slipIds = new Map(existing.map((e) => [e.staffId, e.id]));
    const fresh: NewPayslip[] = [];
    const rewrites: { slip: PayslipKey; figures: PayslipFigures; lines: ComputedLine[] }[] = [];
    for (const slip of plan.slips) {
      const id = slipIds.get(slip.staffId);
      if (id === undefined) fresh.push(newPayslip(slip));
      else rewrites.push({ slip: { id, staffId: slip.staffId }, figures: slip.figures, lines: slip.lines });
    }
    await this.payslips.rewriteMany(schoolId, rewrites);
    for (const created of await this.payslips.createMany(schoolId, run.id, fresh)) slipIds.set(created.staffId, created.id);
    await this.runs.setTotals(schoolId, run.id, totalsOf(plan), preparedBy, at);
    return { plan, slipIds };
  }

  /** One slip recomputed after an adjustment; returns the change in its net. */
  async recomputeOne(schoolId: SchoolId, run: Pick<PayrollRunRecord, 'id' | 'yearMonth'>, staffId: bigint): Promise<number> {
    const existing = (await this.existing(schoolId, run.id)).filter((e) => e.staffId === staffId);
    const slip = existing[0];
    if (slip === undefined) return 0;
    const before = await this.payslips.findById(schoolId, slip.id);
    const plan = await this.plan(schoolId, run.yearMonth, existing, { staffIds: [staffId], errorPath: 'amount' });
    const planned = plan.slips.find((s) => s.staffId === staffId);
    if (planned === undefined || before === null) return 0;
    await this.payslips.rewrite(schoolId, slip, planned.figures, planned.lines);
    return planned.figures.net - before.net;
  }

  /** The days behind the counts for some staff of a draft run (the review screen). */
  async days(schoolId: SchoolId, run: Pick<PayrollRunRecord, 'id' | 'yearMonth'>, staffIds: readonly bigint[]): Promise<Map<bigint, PayslipDays>> {
    if (staffIds.length === 0) return new Map();
    const existing = (await this.existing(schoolId, run.id)).filter((e) => staffIds.includes(e.staffId));
    // A payslipNet refusal (422) leaves the review without its days; anything else is an error.
    const plan = await this.plan(schoolId, run.yearMonth, existing, { staffIds }).catch((error: unknown) => {
      if (error instanceof ApiException && error.status === 422) return null;
      throw error;
    });
    const out = new Map<bigint, PayslipDays>();
    for (const slip of plan?.slips ?? []) if (slip.days !== null) out.set(slip.staffId, slip.days);
    return out;
  }

  private async existing(schoolId: SchoolId, runId: bigint): Promise<ExistingSlip[]> {
    const slips = await this.payslips.ofRun(schoolId, runId);
    return slips.map((s) => ({ id: s.id, staffId: s.staffId, structureId: s.structureId, adjustment: s.adjustment }));
  }

  private skipReason(member: PayrollCandidate, month: MonthBounds): SkipReason | null {
    if (member.status === 'suspended') return 'suspended';
    const window = this.window(member, month);
    return window.from > window.to ? 'not_employed' : null;
  }

  /** The employed days inside the month: from the later of the 1st and joining, to the earlier of the end and leaving. */
  private window(member: PayrollCandidate, month: MonthBounds): { from: string; to: string } {
    const from = member.joinedOn === null ? month.first : maxDay(month.first, toDateString(member.joinedOn));
    const left = member.status === 'left' && member.leftOn !== null ? toDateString(member.leftOn) : month.last;
    return { from, to: minDay(month.last, left) };
  }
}

/**
 * A payslip with nothing computed: kept for someone the run skips, or added for a correction
 * (R216). It is not a use of its structure and earns no payslip_ready.
 */
export const isEmptySlip = (slip: Pick<PlannedSlip, 'figures' | 'lines'>): boolean =>
  slip.lines.length === 0 && slip.figures.basic === 0 && slip.figures.allowancesTotal === 0;

function newPayslip(slip: PlannedSlip): NewPayslip {
  return { staffId: slip.staffId, ...slip.figures, lines: slip.lines };
}

function totalsOf(plan: RunPlan) {
  return {
    workingDays: plan.workingDays,
    staffCount: plan.slips.length,
    skipped: plan.skipped,
    totalNet: plan.slips.reduce((sum, s) => sum + s.figures.net, 0),
  };
}
