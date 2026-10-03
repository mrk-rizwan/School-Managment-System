import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import { escapeLike, type PrismaTxAdapter } from './prisma';

export interface SubjectRecord {
  id: bigint;
  name: string;
  code: string | null;
  /** The archive mark (deleted_at); null while live. */
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type SubjectSortField = 'name' | 'code';
export type SubjectSort = SubjectSortField | `-${SubjectSortField}`;

export interface SubjectListQuery {
  includeArchived: boolean;
  /** Already trimmed and at least 2 characters (the DTO's job). */
  q?: string;
  sort: SubjectSort;
  skip: number;
  take: number;
}

const SELECT = {
  id: true,
  name: true,
  code: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SubjectSelect;

/**
 * Subjects (tenant config table subjects, soft-deleted by deleted_at). Live name and live code are
 * each unique per school (partial indexes subjects_school_id_name_key, subjects_school_id_code_key).
 */
@Injectable()
export class SubjectRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async list(
    schoolId: SchoolId,
    query: SubjectListQuery,
  ): Promise<{ rows: SubjectRecord[]; total: number }> {
    const where: Prisma.SubjectWhereInput = {
      schoolId,
      ...(query.includeArchived ? {} : { deletedAt: null }),
      ...(query.q === undefined
        ? {}
        : {
            OR: [
              { name: { contains: escapeLike(query.q), mode: 'insensitive' } },
              { code: { startsWith: escapeLike(query.q.toUpperCase()) } },
            ],
          }),
    };
    // SubjectSort admits only the field names, so the key is one of them.
    const primary: Partial<Record<SubjectSortField, Prisma.SortOrder>> = {
      [query.sort.replace(/^-/, '')]: query.sort.startsWith('-') ? 'desc' : 'asc',
    };
    // Sequential, not Promise.all: one connection inside a transaction (plan §3.3).
    const rows = await this.txHost.tx.subject.findMany({
      where,
      select: SELECT,
      orderBy: [primary, { id: 'asc' }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.subject.count({ where });
    return { rows, total };
  }

  /** Archived subjects included. */
  findById(schoolId: SchoolId, id: bigint): Promise<SubjectRecord | null> {
    return this.txHost.tx.subject.findFirst({ where: { schoolId, id }, select: SELECT });
  }

  /** A taken live name or code fails on its partial unique index. */
  create(schoolId: SchoolId, data: { name: string; code: string | null }): Promise<SubjectRecord> {
    return this.txHost.tx.subject.create({ data: { schoolId, ...data }, select: SELECT });
  }

  /**
   * Locks the row for the rest of the transaction, but only if it is unchanged since `row` was
   * read (same updated_at and archive mark). Writes nothing visible. False: read again.
   */
  async lockIfUnchanged(schoolId: SchoolId, row: SubjectRecord): Promise<boolean> {
    const { count } = await this.txHost.tx.subject.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt, deletedAt: row.deletedAt },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  /** The caller holds the row lock and has made every check. */
  update(
    schoolId: SchoolId,
    id: bigint,
    data: { name?: string; code?: string | null },
  ): Promise<SubjectRecord> {
    return this.txHost.tx.subject.update({
      where: { schoolId_id: { schoolId, id } },
      data,
      select: SELECT,
    });
  }

  /** The caller holds the row lock. */
  archive(schoolId: SchoolId, id: bigint): Promise<SubjectRecord> {
    return this.txHost.tx.subject.update({
      where: { schoolId_id: { schoolId, id } },
      data: { deletedAt: new Date() },
      select: SELECT,
    });
  }
}
