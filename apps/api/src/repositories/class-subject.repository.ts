import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

export interface ClassSubjectRecord {
  id: bigint;
  classId: bigint;
  subjectId: bigint;
  subjectName: string;
  subjectCode: string | null;
  sortOrder: number;
  examMaxMarks: number;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  classId: true,
  subjectId: true,
  sortOrder: true,
  examMaxMarks: true,
  createdAt: true,
  updatedAt: true,
  // Same school by the composite foreign key (school_id, subject_id).
  subject: { select: { name: true, code: true } },
} satisfies Prisma.ClassSubjectSelect;

type Row = Prisma.ClassSubjectGetPayload<{ select: typeof SELECT }>;

const toRecord = ({ subject, ...row }: Row): ClassSubjectRecord => ({
  ...row,
  subjectName: subject.name,
  subjectCode: subject.code,
});

/**
 * The subjects a class takes in its year (tenant table class_subjects, phase-4-academic.md §3.2,
 * slice 29), live rows only; an archived row is history. Writes run under the class's row lock,
 * taken by the caller.
 */
@Injectable()
export class ClassSubjectRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** A page of the class's live subjects in print order. */
  async listForClass(
    schoolId: SchoolId,
    classId: bigint,
    page: { skip: number; take: number; descending: boolean },
  ): Promise<{ rows: ClassSubjectRecord[]; total: number }> {
    const where = { schoolId, classId, archivedAt: null };
    const direction = page.descending ? 'desc' : 'asc';
    const rows = await this.txHost.tx.classSubject.findMany({
      where,
      select: SELECT,
      orderBy: [{ sortOrder: direction }, { id: direction }],
      skip: page.skip,
      take: page.take,
    });
    const total = await this.txHost.tx.classSubject.count({ where });
    return { rows: rows.map(toRecord), total };
  }

  /** Every live subject of the class, in print order. */
  async liveForClass(schoolId: SchoolId, classId: bigint): Promise<ClassSubjectRecord[]> {
    const rows = await this.txHost.tx.classSubject.findMany({
      where: { schoolId, classId, archivedAt: null },
      select: SELECT,
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toRecord);
  }

  /** The caller holds the class lock; a live duplicate fails on class_subjects_live_key. */
  async create(
    schoolId: SchoolId,
    data: { academicYearId: bigint; classId: bigint; subjectId: bigint; sortOrder: number; examMaxMarks: number },
  ): Promise<void> {
    await this.txHost.tx.classSubject.create({ data: { schoolId, ...data }, select: { id: true } });
  }

  /** The caller holds the class lock. Archived rows are frozen (class_subjects_archived_frozen). Rows changed. */
  async update(
    schoolId: SchoolId,
    id: bigint,
    data: { sortOrder?: number; examMaxMarks?: number },
  ): Promise<number> {
    const { count } = await this.txHost.tx.classSubject.updateMany({
      where: { schoolId, id, archivedAt: null },
      data,
    });
    return count;
  }

  /** The caller holds the class lock. */
  async archive(schoolId: SchoolId, ids: readonly bigint[], archivedBy: bigint): Promise<void> {
    if (ids.length === 0) return;
    await this.txHost.tx.classSubject.updateMany({
      where: { schoolId, id: { in: [...ids] }, archivedAt: null },
      data: { archivedAt: new Date(), archivedBy },
    });
  }
}
