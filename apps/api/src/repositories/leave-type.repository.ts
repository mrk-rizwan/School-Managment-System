import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { LeaveCode, LeaveTypeStatus } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

export interface LeaveTypeRecord {
  id: bigint;
  name: string;
  code: LeaveCode;
  /** Null: unlimited. */
  daysPerYear: number | null;
  paid: boolean;
  status: LeaveTypeStatus;
  archivedAt: Date | null;
  createdBy: bigint | null;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  name: true,
  code: true,
  daysPerYear: true,
  paid: true,
  status: true,
  archivedAt: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.LeaveTypeSelect;

/**
 * Leave types (tenant table leave_types, phase-3-financial.md §4 "Leave", R209). Name, code,
 * entitlement and paid are frozen after insert (a different entitlement is a new type); archive is
 * final. Live names are unique case-insensitively (leave_types_live_name_key). Three are seeded by
 * asms_seed_school_finance (FeeHeadRepository.seedForSchool).
 */
@Injectable()
export class LeaveTypeRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async list(
    schoolId: SchoolId,
    query: { status?: LeaveTypeStatus; skip: number; take: number },
  ): Promise<{ rows: LeaveTypeRecord[]; total: number }> {
    const where: Prisma.LeaveTypeWhereInput = {
      schoolId,
      ...(query.status === undefined ? {} : { status: query.status }),
    };
    const rows = await this.txHost.tx.leaveType.findMany({
      where,
      select: SELECT,
      orderBy: [{ status: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.leaveType.count({ where });
    return { rows, total };
  }

  /** Every live type: the balance rows (a school has a handful). */
  listActive(schoolId: SchoolId): Promise<LeaveTypeRecord[]> {
    return this.txHost.tx.leaveType.findMany({
      where: { schoolId, status: 'active' },
      select: SELECT,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  findById(schoolId: SchoolId, id: bigint): Promise<LeaveTypeRecord | null> {
    return this.txHost.tx.leaveType.findFirst({ where: { schoolId, id }, select: SELECT });
  }

  findByIds(schoolId: SchoolId, ids: readonly bigint[]): Promise<LeaveTypeRecord[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.txHost.tx.leaveType.findMany({
      where: { schoolId, id: { in: [...new Set(ids)] } },
      select: SELECT,
    });
  }

  /** A live type of that name, case-insensitively. */
  findLiveByName(schoolId: SchoolId, name: string): Promise<LeaveTypeRecord | null> {
    return this.txHost.tx.leaveType.findFirst({
      where: { schoolId, status: 'active', name: { equals: name, mode: 'insensitive' } },
      select: SELECT,
    });
  }

  create(
    schoolId: SchoolId,
    data: { name: string; code: LeaveCode; daysPerYear: number | null; paid: boolean; createdBy: bigint },
  ): Promise<LeaveTypeRecord> {
    return this.txHost.tx.leaveType.create({ data: { schoolId, ...data }, select: SELECT });
  }

  /** Locks the row if unchanged since `row` was read; false: read again. */
  async lockIfUnchanged(schoolId: SchoolId, row: LeaveTypeRecord): Promise<boolean> {
    const { count } = await this.txHost.tx.leaveType.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  /** The caller holds the row lock. */
  archive(schoolId: SchoolId, id: bigint, by: bigint): Promise<LeaveTypeRecord> {
    return this.txHost.tx.leaveType.update({
      where: { schoolId_id: { schoolId, id } },
      data: { status: 'archived', archivedAt: new Date(), archivedBy: by },
      select: SELECT,
    });
  }
}
