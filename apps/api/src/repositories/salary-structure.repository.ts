import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SalaryComponentKind, SalaryStructureStatus } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

// The tenant tables salary_structures and salary_structure_components (phase-3-financial.md §4
// "Payroll", slice 25, R213, R235, R253). Never deleted. A later structure closes the one before it
// (ended_on, set once); a same-day replacement supersedes it. Active rows of one staff member never
// overlap (salary_structures_live_excl); nobody writes their own except the sole principal
// (salary_structures_not_self). Components are append-only, ordered by `position`.

export interface SalaryComponentRecord {
  kind: SalaryComponentKind;
  name: string;
  amount: number;
  position: number;
}

export interface SalaryStructureRecord {
  id: bigint;
  staffId: bigint;
  basic: number;
  effectiveFrom: Date;
  endedOn: Date | null;
  status: SalaryStructureStatus;
  supersededAt: Date | null;
  supersededBy: bigint | null;
  reason: string;
  createdBy: bigint;
  selfApproved: boolean;
  createdAt: Date;
  /** In `position` order. */
  components: SalaryComponentRecord[];
}

export interface NewSalaryStructure {
  staffId: bigint;
  basic: number;
  effectiveFrom: Date;
  /** Set at birth only when it replaces a row that already had an end (a same-day supersede). */
  endedOn: Date | null;
  reason: string;
  createdBy: bigint;
  selfApproved: boolean;
  /** In order; `position` is the index. */
  components: readonly { kind: SalaryComponentKind; name: string; amount: number }[];
}

const SELECT = {
  id: true,
  staffId: true,
  basic: true,
  effectiveFrom: true,
  endedOn: true,
  status: true,
  supersededAt: true,
  supersededBy: true,
  reason: true,
  createdBy: true,
  selfApproved: true,
  createdAt: true,
  components: {
    select: { kind: true, name: true, amount: true, position: true },
    orderBy: { position: 'asc' },
  },
} as const satisfies Prisma.SalaryStructureSelect;

@Injectable()
export class SalaryStructureRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** A staff member's structures, newest effective date first (current and history). */
  async listForStaff(
    schoolId: SchoolId,
    staffId: bigint,
    page: { skip: number; take: number },
  ): Promise<{ rows: SalaryStructureRecord[]; total: number }> {
    const where = { schoolId, staffId };
    const rows = await this.txHost.tx.salaryStructure.findMany({
      where,
      select: SELECT,
      orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
      skip: page.skip,
      take: page.take,
    });
    const total = await this.txHost.tx.salaryStructure.count({ where });
    return { rows, total };
  }

  async findById(schoolId: SchoolId, id: bigint): Promise<SalaryStructureRecord | null> {
    return this.txHost.tx.salaryStructure.findFirst({ where: { schoolId, id }, select: SELECT });
  }

  /** The active structure with the latest effective date (the only one with an open end). */
  async latestActive(schoolId: SchoolId, staffId: bigint): Promise<SalaryStructureRecord | null> {
    return this.txHost.tx.salaryStructure.findFirst({
      where: { schoolId, staffId, status: 'active' },
      select: SELECT,
      orderBy: { effectiveFrom: 'desc' },
    });
  }

  /** The active structure in force on `day`. */
  async activeOn(schoolId: SchoolId, staffId: bigint, day: Date): Promise<SalaryStructureRecord | null> {
    return this.txHost.tx.salaryStructure.findFirst({
      where: {
        schoolId,
        staffId,
        status: 'active',
        effectiveFrom: { lte: day },
        OR: [{ endedOn: null }, { endedOn: { gte: day } }],
      },
      select: SELECT,
    });
  }

  /** The earliest active structure that starts after `day` (a raise already recorded). */
  async nextAfter(schoolId: SchoolId, staffId: bigint, day: Date): Promise<SalaryStructureRecord | null> {
    return this.txHost.tx.salaryStructure.findFirst({
      where: { schoolId, staffId, status: 'active', effectiveFrom: { gt: day } },
      select: SELECT,
      orderBy: { effectiveFrom: 'asc' },
    });
  }

  /**
   * R213: whether a payslip of a finalised run references the structure for a month ending on or
   * after `day` (`yearMonth` is the month of `day`): a replacement from `day` would reach into a
   * month that has been paid on this row. A payslip kept with nothing computed (a correction slip,
   * no basic and no computed line) is not a use of the structure.
   */
  async usedByFinalisedFrom(schoolId: SchoolId, structureId: bigint, yearMonth: string): Promise<boolean> {
    const row = await this.txHost.tx.payslip.findFirst({
      where: {
        schoolId,
        structureId,
        run: { status: 'finalised', yearMonth: { gte: yearMonth } },
        OR: [{ basic: { gt: 0 } }, { allowancesTotal: { gt: 0 } }, { lines: { some: { kind: { not: 'adjustment' } } } }],
      },
      select: { id: true },
    });
    return row !== null;
  }

  /** The person's latest structure of any status (a correction slip's, R216). */
  async latestAnyStatus(schoolId: SchoolId, staffId: bigint): Promise<SalaryStructureRecord | null> {
    return this.txHost.tx.salaryStructure.findFirst({
      where: { schoolId, staffId },
      select: SELECT,
      orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
    });
  }

  async create(schoolId: SchoolId, data: NewSalaryStructure): Promise<bigint> {
    const { components, ...structure } = data;
    const row = await this.txHost.tx.salaryStructure.create({
      data: { schoolId, ...structure },
      select: { id: true },
    });
    if (components.length > 0) {
      await this.txHost.tx.salaryStructureComponent.createMany({
        data: components.map((c, position) => ({ schoolId, structureId: row.id, ...c, position })),
      });
    }
    return row.id;
  }

  /** Marks an active row superseded (same-day replacement); 0 when it is no longer active. */
  async supersede(schoolId: SchoolId, id: bigint, at: Date): Promise<number> {
    const { count } = await this.txHost.tx.salaryStructure.updateMany({
      where: { schoolId, id, status: 'active' },
      data: { status: 'superseded', supersededAt: at },
    });
    return count;
  }

  /** Names the replacement of a superseded row (set once). */
  async setSupersededBy(schoolId: SchoolId, id: bigint, successorId: bigint): Promise<void> {
    await this.txHost.tx.salaryStructure.updateMany({
      where: { schoolId, id, status: 'superseded', supersededBy: null },
      data: { supersededBy: successorId },
    });
  }

  /** Ends the open-ended active row on `endedOn`; 0 when it is no longer open. */
  async close(schoolId: SchoolId, id: bigint, endedOn: Date): Promise<number> {
    const { count } = await this.txHost.tx.salaryStructure.updateMany({
      where: { schoolId, id, status: 'active', endedOn: null },
      data: { endedOn },
    });
    return count;
  }
}
