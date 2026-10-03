import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { AcademicYearStatus, Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

export interface AcademicYearRecord {
  id: bigint;
  name: string;
  /** UTC midnight of the calendar date (a `date` column). */
  startsOn: Date;
  endsOn: Date;
  status: AcademicYearStatus;
  createdAt: Date;
  updatedAt: Date;
}

export type AcademicYearSortField = 'startsOn' | 'name';
export type AcademicYearSort = AcademicYearSortField | `-${AcademicYearSortField}`;

export interface AcademicYearListQuery {
  status?: AcademicYearStatus;
  sort: AcademicYearSort;
  skip: number;
  take: number;
}

const SELECT = {
  id: true,
  name: true,
  startsOn: true,
  endsOn: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AcademicYearSelect;

/** Academic years (tenant table academic_years). */
@Injectable()
export class AcademicYearRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async list(
    schoolId: SchoolId,
    query: AcademicYearListQuery,
  ): Promise<{ rows: AcademicYearRecord[]; total: number }> {
    const where: Prisma.AcademicYearWhereInput = {
      schoolId,
      ...(query.status === undefined ? {} : { status: query.status }),
    };
    // AcademicYearSort admits only the field names, so the key is one of them.
    const primary: Partial<Record<AcademicYearSortField, Prisma.SortOrder>> = {
      [query.sort.replace(/^-/, '')]: query.sort.startsWith('-') ? 'desc' : 'asc',
    };
    // Sequential, not Promise.all: one connection inside a transaction (plan §3.3).
    const rows = await this.txHost.tx.academicYear.findMany({
      where,
      select: SELECT,
      // id ascending breaks ties so paging is stable.
      orderBy: [primary, { id: 'asc' }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.academicYear.count({ where });
    return { rows, total };
  }

  findById(schoolId: SchoolId, id: bigint): Promise<AcademicYearRecord | null> {
    return this.txHost.tx.academicYear.findFirst({ where: { schoolId, id }, select: SELECT });
  }

  /** Created `planned`. A taken name fails on academic_years_school_id_name_key. */
  create(
    schoolId: SchoolId,
    data: { name: string; startsOn: Date; endsOn: Date },
  ): Promise<AcademicYearRecord> {
    return this.txHost.tx.academicYear.create({
      data: { schoolId, ...data, status: 'planned' },
      select: SELECT,
    });
  }

  /**
   * Locks the row for the rest of the transaction, but only if it is unchanged since `year` was
   * read (same updated_at and status). Writes nothing visible. False: read again.
   */
  async lockIfUnchanged(schoolId: SchoolId, year: AcademicYearRecord): Promise<boolean> {
    const { count } = await this.txHost.tx.academicYear.updateMany({
      where: { schoolId, id: year.id, updatedAt: year.updatedAt, status: year.status },
      data: { updatedAt: year.updatedAt },
    });
    return count === 1;
  }

  /** The caller holds the row lock and has made every check. */
  async update(
    schoolId: SchoolId,
    id: bigint,
    data: { name?: string; startsOn?: Date; endsOn?: Date; status?: AcademicYearStatus },
  ): Promise<AcademicYearRecord> {
    return this.txHost.tx.academicYear.update({
      where: { schoolId_id: { schoolId, id } },
      data,
      select: SELECT,
    });
  }
}
