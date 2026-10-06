import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { PayrollRunStatus, SalaryComponentKind, StaffAttendanceStatus, StaffStatus } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import { staffNames } from './name-reads';
import type { PrismaTxAdapter } from './prisma';

// The tenant table payroll_runs (phase-3-financial.md §4 "Payroll", slice 25, R214, R216) and the
// month's inputs the run reads once per run (§7.2: staff, structures, staff attendance, approved
// leave and open advances, each one query for the whole school). A draft is recomputed in place;
// once finalised its content is frozen (payroll_runs_content_frozen).

/** A staff member the run skipped, as stored (allowlisted keys, CHECK payroll_runs_skipped_check). */
export interface SkippedStaff {
  staffId: string;
  reason: string;
}

export interface PayrollRunRecord {
  id: bigint;
  yearMonth: string;
  workingDays: number;
  status: PayrollRunStatus;
  preparedAt: Date;
  preparedBy: bigint | null;
  finalisedBy: bigint | null;
  finalisedAt: Date | null;
  finaliseReason: string | null;
  staffCount: number;
  skipped: Prisma.JsonValue;
  totalNet: number;
  updatedAt: Date;
}

export interface RunTotals {
  workingDays: number;
  staffCount: number;
  skipped: readonly SkippedStaff[];
  totalNet: number;
}

/** A staff member who may be in the month's run (employed on some day of it, any status). */
export interface PayrollCandidate {
  id: bigint;
  fullName: string;
  status: StaffStatus;
  joinedOn: Date | null;
  leftOn: Date | null;
}

export interface PayrollStructure {
  id: bigint;
  staffId: bigint;
  basic: number;
  effectiveFrom: Date;
  endedOn: Date | null;
  components: { kind: SalaryComponentKind; name: string; amount: number; position: number }[];
}

export interface PayrollMark {
  staffId: bigint;
  date: Date;
  status: StaffAttendanceStatus;
}

export interface PayrollLeave {
  staffId: bigint;
  startsOn: Date;
  /** The last day taken: ended early, else the end. */
  lastDay: Date;
  paid: boolean;
}

export interface PayrollAdvance {
  id: bigint;
  staffId: bigint;
  grantedOn: Date;
  instalmentAmount: number;
  remaining: number;
}

const SELECT = {
  id: true,
  yearMonth: true,
  workingDays: true,
  status: true,
  preparedAt: true,
  preparedBy: true,
  finalisedBy: true,
  finalisedAt: true,
  finaliseReason: true,
  staffCount: true,
  skipped: true,
  totalNet: true,
  updatedAt: true,
} as const satisfies Prisma.PayrollRunSelect;

const asJson = (skipped: readonly SkippedStaff[]): Prisma.InputJsonValue =>
  skipped.map((s) => ({ staffId: s.staffId, reason: s.reason }));

@Injectable()
export class PayrollRunRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  // ---------------------------------------------------------------------------------- runs

  /** Newest month first. */
  async list(schoolId: SchoolId, page: { skip: number; take: number }): Promise<{ rows: PayrollRunRecord[]; total: number }> {
    const rows = await this.txHost.tx.payrollRun.findMany({
      where: { schoolId },
      select: SELECT,
      orderBy: { yearMonth: 'desc' },
      skip: page.skip,
      take: page.take,
    });
    const total = await this.txHost.tx.payrollRun.count({ where: { schoolId } });
    return { rows, total };
  }

  async findById(schoolId: SchoolId, id: bigint): Promise<PayrollRunRecord | null> {
    return this.txHost.tx.payrollRun.findFirst({ where: { schoolId, id }, select: SELECT });
  }

  async findByMonth(schoolId: SchoolId, yearMonth: string): Promise<PayrollRunRecord | null> {
    return this.txHost.tx.payrollRun.findFirst({ where: { schoolId, yearMonth }, select: SELECT });
  }

  /** Σ unmarked days of each run's payslips (PayrollRunDto.unmarkedDaysTotal). */
  async unmarkedTotals(schoolId: SchoolId, runIds: readonly bigint[]): Promise<Map<bigint, number>> {
    if (runIds.length === 0) return new Map();
    const rows = await this.txHost.tx.payslip.groupBy({
      by: ['runId'],
      where: { schoolId, runId: { in: [...runIds] } },
      _sum: { unmarkedDays: true },
    });
    return new Map(rows.map((r) => [r.runId, r._sum.unmarkedDays ?? 0]));
  }

  /** Staff names by staff id (a run's skipped list), keyed by the id as a string. */
  async staffNames(schoolId: SchoolId, ids: readonly bigint[]): Promise<Map<string, string>> {
    const nameOf = await staffNames(this.txHost.tx, schoolId, ids);
    return new Map(ids.map((id) => [id.toString(), nameOf(id) ?? '']));
  }

  /** A new draft. Two prepares of one month race on payroll_runs_month_key (PAYROLL_RUN_EXISTS). */
  async create(
    schoolId: SchoolId,
    data: { yearMonth: string; preparedBy: bigint | null; preparedAt: Date } & RunTotals,
  ): Promise<PayrollRunRecord> {
    return this.txHost.tx.payrollRun.create({
      data: {
        schoolId,
        yearMonth: data.yearMonth,
        preparedBy: data.preparedBy,
        preparedAt: data.preparedAt,
        workingDays: data.workingDays,
        staffCount: data.staffCount,
        skipped: asJson(data.skipped),
        totalNet: data.totalNet,
      },
      select: SELECT,
    });
  }

  /**
   * Locks the run to the end of the transaction if it is still as read (same updated_at), writing
   * nothing visible: prepare, recompute, adjust, finalise and mark-paid serialise on it.
   */
  async lockIfUnchanged(schoolId: SchoolId, row: Pick<PayrollRunRecord, 'id' | 'updatedAt'>): Promise<boolean> {
    const { count } = await this.txHost.tx.payrollRun.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  /** A recompute's new totals; only while the run is a draft. */
  async setTotals(schoolId: SchoolId, id: bigint, totals: RunTotals, preparedBy: bigint | null, at: Date): Promise<number> {
    const { count } = await this.txHost.tx.payrollRun.updateMany({
      where: { schoolId, id, status: 'draft' },
      data: {
        workingDays: totals.workingDays,
        staffCount: totals.staffCount,
        skipped: asJson(totals.skipped),
        totalNet: totals.totalNet,
        preparedBy,
        preparedAt: at,
      },
    });
    return count;
  }

  /** Moves a draft's total by one payslip's change (an adjustment); 0 when it is no longer a draft. */
  async addToTotalNet(schoolId: SchoolId, id: bigint, delta: number): Promise<number> {
    const { count } = await this.txHost.tx.payrollRun.updateMany({
      where: { schoolId, id, status: 'draft' },
      data: { totalNet: { increment: delta } },
    });
    return count;
  }

  /** draft → finalised; 0 when it is no longer a draft. */
  async finalise(schoolId: SchoolId, id: bigint, by: bigint, at: Date, reason: string | null): Promise<number> {
    const { count } = await this.txHost.tx.payrollRun.updateMany({
      where: { schoolId, id, status: 'draft' },
      data: { status: 'finalised', finalisedBy: by, finalisedAt: at, finaliseReason: reason },
    });
    return count;
  }

  // ------------------------------------------------------------------------------- inputs

  /**
   * Staff employed on some day of `from..to`: joined by its end (or no join date) and, when left,
   * left on or after its start. Suspended staff are returned so the run can list them as skipped.
   */
  async candidates(schoolId: SchoolId, from: Date, to: Date): Promise<PayrollCandidate[]> {
    return this.txHost.tx.staff.findMany({
      where: {
        schoolId,
        OR: [{ joinedOn: null }, { joinedOn: { lte: to } }],
        AND: [{ OR: [{ status: { in: ['active', 'suspended'] } }, { status: 'left', leftOn: { gte: from } }] }],
      },
      select: { id: true, fullName: true, status: true, joinedOn: true, leftOn: true },
      orderBy: { id: 'asc' },
    });
  }

  /** Active structures of these staff that overlap `from..to`, with their components. */
  async structures(schoolId: SchoolId, staffIds: readonly bigint[], from: Date, to: Date): Promise<PayrollStructure[]> {
    if (staffIds.length === 0) return [];
    return this.txHost.tx.salaryStructure.findMany({
      where: {
        schoolId,
        staffId: { in: [...staffIds] },
        status: 'active',
        effectiveFrom: { lte: to },
        OR: [{ endedOn: null }, { endedOn: { gte: from } }],
      },
      select: {
        id: true,
        staffId: true,
        basic: true,
        effectiveFrom: true,
        endedOn: true,
        components: { select: { kind: true, name: true, amount: true, position: true }, orderBy: { position: 'asc' } },
      },
    });
  }

  /** Staff attendance marks of `from..to` (slice 12). */
  async marks(schoolId: SchoolId, staffIds: readonly bigint[], from: Date, to: Date): Promise<PayrollMark[]> {
    if (staffIds.length === 0) return [];
    return this.txHost.tx.staffAttendance.findMany({
      where: { schoolId, staffId: { in: [...staffIds] }, date: { gte: from, lte: to } },
      select: { staffId: true, date: true, status: true },
    });
  }

  /** Approved (or ended-early, to its last day taken) leave overlapping `from..to` (slice 24). */
  async approvedLeave(schoolId: SchoolId, staffIds: readonly bigint[], from: Date, to: Date): Promise<PayrollLeave[]> {
    if (staffIds.length === 0) return [];
    const rows = await this.txHost.tx.leaveRequest.findMany({
      where: {
        schoolId,
        staffId: { in: [...staffIds] },
        status: { in: ['approved', 'ended_early'] },
        startsOn: { lte: to },
        endsOn: { gte: from },
      },
      select: { staffId: true, startsOn: true, endsOn: true, endedEarlyOn: true, leaveType: { select: { paid: true } } },
    });
    return rows
      .map((r) => ({ staffId: r.staffId, startsOn: r.startsOn, lastDay: r.endedEarlyOn ?? r.endsOn, paid: r.leaveType.paid }))
      .filter((r) => r.lastDay >= from);
  }

  /** Open advances recovering from `yearMonth` or earlier, in grant order (R247). */
  async openAdvances(schoolId: SchoolId, staffIds: readonly bigint[], yearMonth: string): Promise<PayrollAdvance[]> {
    if (staffIds.length === 0) return [];
    const rows = await this.txHost.tx.salaryAdvance.findMany({
      where: { schoolId, staffId: { in: [...staffIds] }, status: 'open', recoverFrom: { lte: yearMonth } },
      select: { id: true, staffId: true, grantedOn: true, instalmentAmount: true, amount: true, recoveredAmount: true },
      orderBy: [{ grantedOn: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      staffId: r.staffId,
      grantedOn: r.grantedOn,
      instalmentAmount: r.instalmentAmount,
      remaining: r.amount - r.recoveredAmount,
    }));
  }

  /** Locks the advances a finalise recovers from, in id order (the recovery trigger updates them). */
  async lockAdvances(schoolId: SchoolId, ids: readonly bigint[]): Promise<void> {
    for (const id of [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      await this.txHost.tx.salaryAdvance.updateMany({ where: { schoolId, id, status: 'open' }, data: { status: 'open' } });
    }
  }
}
