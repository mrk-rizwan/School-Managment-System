import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { AttendanceMode, ClassStatus, Prisma } from './generated/prisma/client';
import { escapeLike, type PrismaTxAdapter } from './prisma';

export interface ClassRecord {
  id: bigint;
  academicYearId: bigint;
  academicYearName: string;
  name: string;
  sortOrder: number;
  attendanceMode: AttendanceMode;
  status: ClassStatus;
  /** Phase 4 (rule 30): the class a passed student is promoted into, and its name. */
  nextClassId: bigint | null;
  nextClassName: string | null;
  /** The school's last class: a passed student completes. Never with a next class. */
  isFinal: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type ClassSortField = 'sortOrder' | 'name';
export type ClassSort = ClassSortField | `-${ClassSortField}`;

export interface ClassListQuery {
  academicYearId?: bigint;
  status?: ClassStatus;
  /** Already trimmed and at least 2 characters (the DTO's job). */
  q?: string;
  sort: ClassSort;
  skip: number;
  take: number;
}

export interface ClassChanges {
  academicYearId?: bigint;
  name?: string;
  sortOrder?: number;
  attendanceMode?: AttendanceMode;
  nextClassId?: bigint | null;
  isFinal?: boolean;
}

const SELECT = {
  id: true,
  academicYearId: true,
  name: true,
  sortOrder: true,
  attendanceMode: true,
  status: true,
  nextClassId: true,
  isFinal: true,
  createdAt: true,
  updatedAt: true,
  // Same school by the composite foreign keys (school_id, academic_year_id), (school_id, next_class_id).
  academicYear: { select: { name: true } },
  nextClass: { select: { name: true } },
} satisfies Prisma.ClassSelect;

type ClassRow = Prisma.ClassGetPayload<{ select: typeof SELECT }>;

const toRecord = ({ academicYear, nextClass, ...row }: ClassRow): ClassRecord => ({
  ...row,
  academicYearName: academicYear.name,
  nextClassName: nextClass?.name ?? null,
});

/** Classes (tenant table classes). One row per class per academic year. */
@Injectable()
export class ClassRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async list(
    schoolId: SchoolId,
    query: ClassListQuery,
  ): Promise<{ rows: ClassRecord[]; total: number }> {
    const where: Prisma.ClassWhereInput = {
      schoolId,
      ...(query.academicYearId === undefined ? {} : { academicYearId: query.academicYearId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.q === undefined
        ? {}
        : { name: { contains: escapeLike(query.q), mode: 'insensitive' } }),
    };
    // ClassSort admits only the field names, so the key is one of them.
    const primary: Partial<Record<ClassSortField, Prisma.SortOrder>> = {
      [query.sort.replace(/^-/, '')]: query.sort.startsWith('-') ? 'desc' : 'asc',
    };
    // Sequential, not Promise.all: one connection inside a transaction (plan §3.3).
    const rows = await this.txHost.tx.class.findMany({
      where,
      select: SELECT,
      orderBy: [primary, { id: 'asc' }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.class.count({ where });
    return { rows: rows.map(toRecord), total };
  }

  async findById(schoolId: SchoolId, id: bigint): Promise<ClassRecord | null> {
    const row = await this.txHost.tx.class.findFirst({ where: { schoolId, id }, select: SELECT });
    return row && toRecord(row);
  }

  /** Created `active`. A taken name fails on classes_school_id_academic_year_id_name_key. */
  async create(
    schoolId: SchoolId,
    data: {
      academicYearId: bigint;
      name: string;
      sortOrder: number;
      attendanceMode: AttendanceMode;
    },
  ): Promise<ClassRecord> {
    return toRecord(
      await this.txHost.tx.class.create({
        data: { schoolId, ...data, status: 'active' },
        select: SELECT,
      }),
    );
  }

  /**
   * Locks the row for the rest of the transaction, but only if it is unchanged since `row` was
   * read (same updated_at and status). Writes nothing visible. False: read again.
   */
  async lockIfUnchanged(schoolId: SchoolId, row: ClassRecord): Promise<boolean> {
    const { count } = await this.txHost.tx.class.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt, status: row.status },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  /**
   * The caller holds the row lock and has made every check. A changed academicYearId on a class
   * with sections fails on trigger classes_academic_year_immutable.
   */
  async update(schoolId: SchoolId, id: bigint, data: ClassChanges): Promise<ClassRecord> {
    return toRecord(
      await this.txHost.tx.class.update({
        where: { schoolId_id: { schoolId, id } },
        data,
        select: SELECT,
      }),
    );
  }

  /** The caller holds the row lock. */
  async archive(schoolId: SchoolId, id: bigint): Promise<ClassRecord> {
    return toRecord(
      await this.txHost.tx.class.update({
        where: { schoolId_id: { schoolId, id } },
        data: { status: 'archived' },
        select: SELECT,
      }),
    );
  }
}
