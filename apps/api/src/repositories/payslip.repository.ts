import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { PaymentMethod, PayrollRunStatus, PayslipLineKind, PayslipStatus, SalaryComponentKind } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

// The tenant tables payslips, payslip_lines and salary_advance_recoveries (phase-3-financial.md §4
// "Payroll", slice 25, R214-R218, R235, R247). Never deleted, except that a recompute removes a
// draft payslip's computed lines (payslip_lines_draft_only admits it only while the run is a draft;
// an adjustment line is never removed, payslip_lines_adjustment_kept). Once the run is finalised a
// payslip's only movement is being paid, once (payslips_run_guard, payslips_paid_frozen).

export interface PayslipLineRecord {
  id: bigint;
  kind: PayslipLineKind;
  name: string;
  amount: number;
  adjustsPayslipId: bigint | null;
  reason: string | null;
  createdBy: bigint | null;
  createdAt: Date;
}

export interface PayslipRecord {
  id: bigint;
  runId: bigint;
  staffId: bigint;
  structureId: bigint;
  employedWorkingDays: number;
  basic: number;
  allowancesTotal: number;
  deductionsTotal: number;
  unpaidDays: number;
  unmarkedDays: number;
  absenceDeduction: number;
  advanceRecovery: number;
  adjustmentTotal: number;
  net: number;
  status: PayslipStatus;
  paidOn: Date | null;
  paidMethod: PaymentMethod | null;
  paidReference: string | null;
  paidBy: bigint | null;
  updatedAt: Date;
  staffName: string;
  designation: string | null;
  run: { yearMonth: string; workingDays: number; status: PayrollRunStatus };
  /** The structure's deductions, to show what a deduction could not take (§3.3). */
  structureDeductions: { name: string; amount: number }[];
  /** In id order. */
  lines: PayslipLineRecord[];
}

/** The computed part of a payslip: everything but the adjustments, which persist. */
export interface PayslipFigures {
  structureId: bigint;
  employedWorkingDays: number;
  basic: number;
  allowancesTotal: number;
  deductionsTotal: number;
  unpaidDays: number;
  unmarkedDays: number;
  absenceDeduction: number;
  advanceRecovery: number;
  adjustmentTotal: number;
  net: number;
}

export interface ComputedLine {
  kind: Exclude<PayslipLineKind, 'adjustment'>;
  name: string;
  amount: number;
}

export interface NewPayslip extends PayslipFigures {
  staffId: bigint;
  lines: readonly ComputedLine[];
}

export interface NewAdjustment {
  payslipId: bigint;
  staffId: bigint;
  name: string;
  amount: number;
  adjustsPayslipId: bigint | null;
  reason: string;
  createdBy: bigint;
}

const SELECT = {
  id: true,
  runId: true,
  staffId: true,
  structureId: true,
  employedWorkingDays: true,
  basic: true,
  allowancesTotal: true,
  deductionsTotal: true,
  unpaidDays: true,
  unmarkedDays: true,
  absenceDeduction: true,
  advanceRecovery: true,
  adjustmentTotal: true,
  net: true,
  status: true,
  paidOn: true,
  paidMethod: true,
  paidReference: true,
  paidBy: true,
  updatedAt: true,
  staff: { select: { fullName: true, designation: true } },
  run: { select: { yearMonth: true, workingDays: true, status: true } },
  structure: {
    select: {
      components: {
        where: { kind: 'deduction' satisfies SalaryComponentKind },
        select: { name: true, amount: true },
        orderBy: { position: 'asc' },
      },
    },
  },
  lines: {
    select: {
      id: true,
      kind: true,
      name: true,
      amount: true,
      adjustsPayslipId: true,
      reason: true,
      createdBy: true,
      createdAt: true,
    },
    orderBy: { id: 'asc' },
  },
} as const satisfies Prisma.PayslipSelect;

type Row = Prisma.PayslipGetPayload<{ select: typeof SELECT }>;

const toRecord = ({ staff, structure, ...row }: Row): PayslipRecord => ({
  ...row,
  staffName: staff.fullName,
  designation: staff.designation,
  structureDeductions: structure.components,
});

/** `(school_id, id)` of a payslip and its staff member, for the line foreign key. */
export interface PayslipKey {
  id: bigint;
  staffId: bigint;
}

@Injectable()
export class PayslipRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  // --------------------------------------------------------------------------------- reads

  async findById(schoolId: SchoolId, id: bigint): Promise<PayslipRecord | null> {
    const row = await this.txHost.tx.payslip.findFirst({ where: { schoolId, id }, select: SELECT });
    return row === null ? null : toRecord(row);
  }

  /** A run's payslips by staff name. */
  async listForRun(
    schoolId: SchoolId,
    runId: bigint,
    page: { skip: number; take: number },
  ): Promise<{ rows: PayslipRecord[]; total: number }> {
    const where = { schoolId, runId };
    const rows = await this.txHost.tx.payslip.findMany({
      where,
      select: SELECT,
      orderBy: [{ staff: { fullName: 'asc' } }, { id: 'asc' }],
      skip: page.skip,
      take: page.take,
    });
    const total = await this.txHost.tx.payslip.count({ where });
    return { rows: rows.map(toRecord), total };
  }

  /** One staff member's payslips of finalised runs, newest month first (R217). */
  async listFinalisedForStaff(
    schoolId: SchoolId,
    staffId: bigint,
    page: { skip: number; take: number },
  ): Promise<{ rows: PayslipRecord[]; total: number }> {
    const where: Prisma.PayslipWhereInput = { schoolId, staffId, run: { status: 'finalised' } };
    const rows = await this.txHost.tx.payslip.findMany({
      where,
      select: SELECT,
      orderBy: [{ run: { yearMonth: 'desc' } }, { id: 'desc' }],
      skip: page.skip,
      take: page.take,
    });
    const total = await this.txHost.tx.payslip.count({ where });
    return { rows: rows.map(toRecord), total };
  }

  /** A run's payslips (id, staff, structure) and the Σ of each one's adjustment lines. */
  async ofRun(schoolId: SchoolId, runId: bigint): Promise<(PayslipKey & { structureId: bigint; adjustment: number })[]> {
    const slips = await this.txHost.tx.payslip.findMany({
      where: { schoolId, runId },
      select: { id: true, staffId: true, structureId: true },
      orderBy: { id: 'asc' },
    });
    if (slips.length === 0) return [];
    const sums = await this.txHost.tx.payslipLine.groupBy({
      by: ['payslipId'],
      where: { schoolId, payslipId: { in: slips.map((s) => s.id) }, kind: 'adjustment' },
      _sum: { amount: true },
    });
    const byId = new Map(sums.map((s) => [s.payslipId, s._sum.amount ?? 0]));
    return slips.map((s) => ({ ...s, adjustment: byId.get(s.id) ?? 0 }));
  }

  /** Whether the staff member's payslip in the run carries an adjustment line (R216). */
  async hasAdjustment(schoolId: SchoolId, runId: bigint, staffId: bigint): Promise<boolean> {
    const row = await this.txHost.tx.payslipLine.findFirst({
      where: { schoolId, staffId, kind: 'adjustment', payslip: { runId } },
      select: { id: true },
    });
    return row !== null;
  }

  // -------------------------------------------------------------------------------- writes

  /** A draft run's new payslips with their computed lines (two statements per batch). */
  async createMany(schoolId: SchoolId, runId: bigint, slips: readonly NewPayslip[]): Promise<PayslipKey[]> {
    if (slips.length === 0) return [];
    const created = await this.txHost.tx.payslip.createManyAndReturn({
      data: slips.map(({ lines: _lines, ...figures }) => ({ schoolId, runId, ...figures })),
      select: { id: true, staffId: true },
    });
    const idOf = new Map(created.map((c) => [c.staffId, c.id]));
    await this.insertLines(
      schoolId,
      slips.flatMap((slip) => {
        const payslipId = idOf.get(slip.staffId);
        return payslipId === undefined ? [] : slip.lines.map((line) => ({ payslipId, staffId: slip.staffId, ...line }));
      }),
    );
    return created;
  }

  /**
   * Rewrites a draft payslip's figures and computed lines (recompute): the computed lines are
   * removed and written again; adjustment lines stay. Once the run is finalised the triggers refuse
   * every statement here (payslips_run_finalised, payslip_lines_draft_only).
   */
  async rewrite(schoolId: SchoolId, slip: PayslipKey, figures: PayslipFigures, lines: readonly ComputedLine[]): Promise<void> {
    await this.txHost.tx.payslip.updateMany({ where: { schoolId, id: slip.id, status: 'pending' }, data: figures });
    await this.txHost.tx.payslipLine.deleteMany({
      where: { schoolId, payslipId: slip.id, kind: { not: 'adjustment' } },
    });
    await this.insertLines(schoolId, lines.map((line) => ({ payslipId: slip.id, staffId: slip.staffId, ...line })));
  }

  /**
   * rewrite() for many payslips of one draft run: one statement removing their computed lines, one
   * figure update per payslip, one statement writing every computed line (§7.2 headroom).
   */
  async rewriteMany(
    schoolId: SchoolId,
    slips: readonly { slip: PayslipKey; figures: PayslipFigures; lines: readonly ComputedLine[] }[],
  ): Promise<void> {
    if (slips.length === 0) return;
    await this.txHost.tx.payslipLine.deleteMany({
      where: { schoolId, payslipId: { in: slips.map((s) => s.slip.id) }, kind: { not: 'adjustment' } },
    });
    for (const { slip, figures } of slips) {
      await this.txHost.tx.payslip.updateMany({ where: { schoolId, id: slip.id, status: 'pending' }, data: figures });
    }
    await this.insertLines(
      schoolId,
      slips.flatMap(({ slip, lines }) => lines.map((line) => ({ payslipId: slip.id, staffId: slip.staffId, ...line }))),
    );
  }

  async addAdjustment(schoolId: SchoolId, line: NewAdjustment): Promise<bigint> {
    const row = await this.txHost.tx.payslipLine.create({
      data: { schoolId, kind: 'adjustment', ...line },
      select: { id: true },
    });
    return row.id;
  }

  /** A finalised payslip's advance recoveries (the trigger raises each advance's counter). */
  async addRecoveries(
    schoolId: SchoolId,
    rows: readonly { advanceId: bigint; payslipId: bigint; staffId: bigint; amount: number }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.txHost.tx.salaryAdvanceRecovery.createMany({ data: rows.map((r) => ({ schoolId, ...r })) });
  }

  /** pending → paid, once; 0 when it is already paid. */
  async markPaid(
    schoolId: SchoolId,
    id: bigint,
    paid: { paidOn: Date; paidMethod: PaymentMethod; paidReference: string | null; paidBy: bigint },
  ): Promise<number> {
    const { count } = await this.txHost.tx.payslip.updateMany({
      where: { schoolId, id, status: 'pending' },
      data: { status: 'paid', ...paid },
    });
    return count;
  }

  private async insertLines(
    schoolId: SchoolId,
    lines: readonly ({ payslipId: bigint; staffId: bigint } & ComputedLine)[],
  ): Promise<void> {
    if (lines.length === 0) return;
    await this.txHost.tx.payslipLine.createMany({ data: lines.map((line) => ({ schoolId, ...line })) });
  }
}
