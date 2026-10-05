import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { FeeFrequency, FeeStructureStatus } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

export interface FeeStructureRecord {
  id: bigint;
  academicYearId: bigint;
  classId: bigint;
  feeHeadId: bigint;
  amount: number;
  effectiveFrom: string;
  status: FeeStructureStatus;
  supersededBy: bigint | null;
  supersededAt: Date | null;
  reason: string | null;
  createdBy: bigint;
  createdAt: Date;
  feeHead: { name: string; frequency: FeeFrequency };
}

export interface FeeStructureClassRow {
  id: bigint;
  name: string;
}

const SELECT = {
  id: true,
  academicYearId: true,
  classId: true,
  feeHeadId: true,
  amount: true,
  effectiveFrom: true,
  status: true,
  supersededBy: true,
  supersededAt: true,
  reason: true,
  createdBy: true,
  createdAt: true,
  feeHead: { select: { name: true, frequency: true } },
} satisfies Prisma.FeeStructureSelect;

/**
 * Fee structures (tenant table fee_structures, R177). Never deleted; amount, class, head and month
 * are frozen. One active row per (class, head, effective month) (fee_structures_active_key).
 * Writes for a head run under that head's row lock (FeeHeadRepository.lockIfUnchanged), so the
 * "later than the latest active" rule is decided on a stable set.
 */
@Injectable()
export class FeeStructureRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** The year's classes, by display order then name: the grid's pages. */
  async classesOfYear(
    schoolId: SchoolId,
    academicYearId: bigint,
    query: { classId?: bigint; skip: number; take: number },
  ): Promise<{ rows: FeeStructureClassRow[]; total: number }> {
    const where: Prisma.ClassWhereInput = {
      schoolId,
      academicYearId,
      ...(query.classId === undefined ? {} : { id: query.classId }),
    };
    const rows = await this.txHost.tx.class.findMany({
      where,
      select: { id: true, name: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.class.count({ where });
    return { rows, total };
  }

  /** Every live class of a year, for copying a year's structure by class name. */
  liveClassesOfYear(schoolId: SchoolId, academicYearId: bigint): Promise<FeeStructureClassRow[]> {
    return this.txHost.tx.class.findMany({
      where: { schoolId, academicYearId, status: 'active' },
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
    });
  }

  /** Every row of these classes in the year, newest effective month first. */
  forClasses(schoolId: SchoolId, academicYearId: bigint, classIds: bigint[]): Promise<FeeStructureRecord[]> {
    return this.txHost.tx.feeStructure.findMany({
      where: { schoolId, academicYearId, classId: { in: classIds } },
      select: SELECT,
      orderBy: [{ classId: 'asc' }, { feeHeadId: 'asc' }, { effectiveFrom: 'desc' }, { id: 'desc' }],
    });
  }

  /** The active rows of one class and head, newest effective month first. */
  activeFor(schoolId: SchoolId, classId: bigint, feeHeadId: bigint): Promise<FeeStructureRecord[]> {
    return this.txHost.tx.feeStructure.findMany({
      where: { schoolId, classId, feeHeadId, status: 'active' },
      select: SELECT,
      orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
    });
  }

  findById(schoolId: SchoolId, id: bigint): Promise<FeeStructureRecord | null> {
    return this.txHost.tx.feeStructure.findFirst({ where: { schoolId, id }, select: SELECT });
  }

  create(
    schoolId: SchoolId,
    data: {
      academicYearId: bigint;
      classId: bigint;
      feeHeadId: bigint;
      amount: number;
      effectiveFrom: string;
      reason: string | null;
      createdBy: bigint;
    },
  ): Promise<FeeStructureRecord> {
    return this.txHost.tx.feeStructure.create({ data: { schoolId, ...data }, select: SELECT });
  }

  /**
   * Step 1 of a same-month replacement: the active row stops being active, so the replacement can
   * be inserted under fee_structures_active_key. Matches only while still active (0: it changed).
   */
  async markSuperseded(schoolId: SchoolId, id: bigint): Promise<number> {
    const { count } = await this.txHost.tx.feeStructure.updateMany({
      where: { schoolId, id, status: 'active' },
      data: { status: 'superseded', supersededAt: new Date() },
    });
    return count;
  }

  /** Step 2: the superseded row names its replacement (set once). */
  async linkSuccessor(schoolId: SchoolId, id: bigint, successorId: bigint): Promise<void> {
    await this.txHost.tx.feeStructure.updateMany({
      where: { schoolId, id, status: 'superseded', supersededBy: null },
      data: { supersededBy: successorId },
    });
  }
}
