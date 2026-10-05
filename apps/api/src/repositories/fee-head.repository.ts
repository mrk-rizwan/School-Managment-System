import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { FeeFrequency, FeeHeadCategory, FeeHeadStatus } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

export interface FeeHeadRecord {
  id: bigint;
  name: string;
  category: FeeHeadCategory;
  frequency: FeeFrequency;
  concessionEligible: boolean;
  refundable: boolean;
  status: FeeHeadStatus;
  archivedAt: Date | null;
  archiveReason: string | null;
  createdBy: bigint | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FeeHeadListQuery {
  status?: FeeHeadStatus;
  sort: 'name' | '-name';
  skip: number;
  take: number;
}

const SELECT = {
  id: true,
  name: true,
  category: true,
  frequency: true,
  concessionEligible: true,
  refundable: true,
  status: true,
  archivedAt: true,
  archiveReason: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.FeeHeadSelect;

/**
 * Fee heads (tenant table fee_heads, rule 8, R176). Never deleted; archive is final. Live names
 * (case-insensitive), the live tuition head and the live fine head are each unique by partial
 * indexes (fee_heads_live_name_key, fee_heads_one_tuition_key, fee_heads_one_fine_key).
 */
@Injectable()
export class FeeHeadRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /**
   * The school's finance seeds (§3.5): the five fee heads and the expense_no counter, from the one
   * definition in the database (function asms_seed_school_finance, migration
   * 20261005182000_slice18_fee_setup). Called in the school-creation transaction; idempotent.
   */
  async seedForSchool(schoolId: SchoolId): Promise<void> {
    await this.txHost.tx.$executeRaw`SELECT asms_seed_school_finance(${schoolId}::bigint)`;
  }

  async list(schoolId: SchoolId, query: FeeHeadListQuery): Promise<{ rows: FeeHeadRecord[]; total: number }> {
    const where: Prisma.FeeHeadWhereInput = {
      schoolId,
      ...(query.status === undefined ? {} : { status: query.status }),
    };
    const direction = query.sort === '-name' ? 'desc' : 'asc';
    const rows = await this.txHost.tx.feeHead.findMany({
      where,
      select: SELECT,
      orderBy: [{ name: direction }, { id: 'asc' }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.feeHead.count({ where });
    return { rows, total };
  }

  findById(schoolId: SchoolId, id: bigint): Promise<FeeHeadRecord | null> {
    return this.txHost.tx.feeHead.findFirst({ where: { schoolId, id }, select: SELECT });
  }

  /** A live head of that name, case-insensitively, other than `exceptId`. */
  findLiveByName(schoolId: SchoolId, name: string, exceptId?: bigint): Promise<FeeHeadRecord | null> {
    return this.txHost.tx.feeHead.findFirst({
      where: {
        schoolId,
        status: 'active',
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
      },
      select: SELECT,
    });
  }

  /** The live head of a one-per-school category (tuition, fine). */
  findLiveByCategory(schoolId: SchoolId, category: FeeHeadCategory): Promise<FeeHeadRecord | null> {
    return this.txHost.tx.feeHead.findFirst({
      where: { schoolId, status: 'active', category },
      select: SELECT,
    });
  }

  create(
    schoolId: SchoolId,
    data: {
      name: string;
      category: FeeHeadCategory;
      frequency: FeeFrequency;
      concessionEligible: boolean;
      refundable: boolean;
      createdBy: bigint;
    },
  ): Promise<FeeHeadRecord> {
    return this.txHost.tx.feeHead.create({ data: { schoolId, ...data }, select: SELECT });
  }

  /** Locks the row if unchanged since `row` was read; false: read again. */
  async lockIfUnchanged(schoolId: SchoolId, row: FeeHeadRecord): Promise<boolean> {
    const { count } = await this.txHost.tx.feeHead.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  /** The caller holds the row lock. */
  update(
    schoolId: SchoolId,
    id: bigint,
    data: { name?: string; concessionEligible?: boolean; refundable?: boolean },
  ): Promise<FeeHeadRecord> {
    return this.txHost.tx.feeHead.update({
      where: { schoolId_id: { schoolId, id } },
      data,
      select: SELECT,
    });
  }

  /** The caller holds the row lock. */
  archive(schoolId: SchoolId, id: bigint, by: bigint, reason: string): Promise<FeeHeadRecord> {
    return this.txHost.tx.feeHead.update({
      where: { schoolId_id: { schoolId, id } },
      data: { status: 'archived', archivedAt: new Date(), archivedBy: by, archiveReason: reason },
      select: SELECT,
    });
  }
}
