import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

export interface SectionRecord {
  id: bigint;
  classId: bigint;
  name: string;
  capacity: number | null;
  /** The archive mark (deleted_at); null while live. */
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type SectionSort = 'name' | '-name';

export interface SectionListQuery {
  includeArchived: boolean;
  sort: SectionSort;
  skip: number;
  take: number;
}

const SELECT = {
  id: true,
  classId: true,
  name: true,
  capacity: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SectionSelect;

/**
 * Sections (tenant config table sections, soft-deleted by deleted_at). Live names are unique per
 * class by the partial index sections_school_id_class_id_name_key.
 */
@Injectable()
export class SectionRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async listForClass(
    schoolId: SchoolId,
    classId: bigint,
    query: SectionListQuery,
  ): Promise<{ rows: SectionRecord[]; total: number }> {
    const where: Prisma.SectionWhereInput = {
      schoolId,
      classId,
      ...(query.includeArchived ? {} : { deletedAt: null }),
    };
    // Sequential, not Promise.all: one connection inside a transaction (plan §3.3).
    const rows = await this.txHost.tx.section.findMany({
      where,
      select: SELECT,
      orderBy: [{ name: query.sort === '-name' ? 'desc' : 'asc' }, { id: 'asc' }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.section.count({ where });
    return { rows, total };
  }

  /** Every live section of the class, by name. */
  listLive(schoolId: SchoolId, classId: bigint): Promise<SectionRecord[]> {
    return this.txHost.tx.section.findMany({
      where: { schoolId, classId, deletedAt: null },
      select: SELECT,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  /** Archived sections included: the history follows the section. */
  findById(schoolId: SchoolId, id: bigint): Promise<SectionRecord | null> {
    return this.txHost.tx.section.findFirst({ where: { schoolId, id }, select: SELECT });
  }

  /** Whether the class has any section, archived ones included. */
  async existsForClass(schoolId: SchoolId, classId: bigint): Promise<boolean> {
    const row = await this.txHost.tx.section.findFirst({
      where: { schoolId, classId },
      select: { id: true },
    });
    return row !== null;
  }

  /** A taken live name fails on sections_school_id_class_id_name_key. */
  create(
    schoolId: SchoolId,
    data: { classId: bigint; name: string; capacity: number | null },
  ): Promise<SectionRecord> {
    return this.txHost.tx.section.create({ data: { schoolId, ...data }, select: SELECT });
  }

  /**
   * Locks the row for the rest of the transaction, but only if it is unchanged since `row` was
   * read (same updated_at and archive mark). Writes nothing visible. False: read again.
   */
  async lockIfUnchanged(schoolId: SchoolId, row: SectionRecord): Promise<boolean> {
    const { count } = await this.txHost.tx.section.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt, deletedAt: row.deletedAt },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  /** The caller holds the row lock and has made every check. */
  update(
    schoolId: SchoolId,
    id: bigint,
    data: { name?: string; capacity?: number | null },
  ): Promise<SectionRecord> {
    return this.txHost.tx.section.update({
      where: { schoolId_id: { schoolId, id } },
      data,
      select: SELECT,
    });
  }

  /** The caller holds the row lock. */
  archive(schoolId: SchoolId, id: bigint): Promise<SectionRecord> {
    return this.txHost.tx.section.update({
      where: { schoolId_id: { schoolId, id } },
      data: { deletedAt: new Date() },
      select: SELECT,
    });
  }
}
