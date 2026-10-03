import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma, TeacherAssignmentRole } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

// contracts/slice-4.md §4. The tenant table teacher_assignments. A row counts on
// starts_on..ends_on inclusive unless voided; dates are DATE values (UTC midnight). Rows are
// ended or voided, never deleted (rule 4); every column but the end markers is frozen by trigger.

export interface TeacherAssignmentRecord {
  id: bigint;
  staffId: bigint;
  staffFullName: string;
  academicYearId: bigint;
  academicYearName: string;
  classId: bigint;
  className: string;
  sectionId: bigint | null;
  sectionName: string | null;
  subjectId: bigint | null;
  subjectName: string | null;
  role: TeacherAssignmentRole;
  startsOn: Date;
  endsOn: Date | null;
  voidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewTeacherAssignment {
  staffId: bigint;
  academicYearId: bigint;
  classId: bigint;
  sectionId: bigint | null;
  subjectId: bigint | null;
  role: TeacherAssignmentRole;
  startsOn: Date;
  endsOn: Date | null;
}

export type TeacherAssignmentSort = '-startsOn' | 'startsOn' | 'className';

export interface TeacherAssignmentListQuery {
  /** False hides rows voided or ended before `today`. */
  includeEnded: boolean;
  today: Date;
  academicYearId?: bigint;
  sort: TeacherAssignmentSort;
  skip: number;
  take: number;
}

// Scalars only; names are read by separate sequential statements (withNames), since Prisma loads
// sibling relations of one select concurrently and a transaction must not overlap statements (§3.3).
const SELECT = {
  id: true,
  staffId: true,
  academicYearId: true,
  classId: true,
  sectionId: true,
  subjectId: true,
  role: true,
  startsOn: true,
  endsOn: true,
  voidedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.TeacherAssignmentSelect;

type Row = Prisma.TeacherAssignmentGetPayload<{ select: typeof SELECT }>;

/** Not voided and not ended before `today`: it counts today or will count later. */
const notEnded = (today: Date): Prisma.TeacherAssignmentWhereInput => ({
  voidedAt: null,
  OR: [{ endsOn: null }, { endsOn: { gte: today } }],
});

/** Not voided and its dates overlap `from..to` (inclusive; a null `to` is open-ended). */
const liveOverlapping = (from: Date, to: Date | null): Prisma.TeacherAssignmentWhereInput => ({
  voidedAt: null,
  OR: [{ endsOn: null }, { endsOn: { gte: from } }],
  ...(to === null ? {} : { startsOn: { lte: to } }),
});

/** Counts on `today`: not voided, begun, not yet ended (liveOverlapping(today, today), in memory). */
export const isActiveOn = (
  row: Pick<TeacherAssignmentRecord, 'voidedAt' | 'startsOn' | 'endsOn'>,
  today: Date,
): boolean =>
  row.voidedAt === null && row.startsOn <= today && (row.endsOn === null || row.endsOn >= today);

function orderBy(sort: TeacherAssignmentSort): Prisma.TeacherAssignmentOrderByWithRelationInput[] {
  switch (sort) {
    case '-startsOn':
      return [{ startsOn: 'desc' }, { id: 'desc' }];
    case 'startsOn':
      return [{ startsOn: 'asc' }, { id: 'asc' }];
    case 'className':
      return [{ class: { name: 'asc' } }, { startsOn: 'desc' }, { id: 'desc' }];
  }
}

@Injectable()
export class TeacherAssignmentRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async listForStaff(
    schoolId: SchoolId,
    staffId: bigint,
    query: TeacherAssignmentListQuery,
  ): Promise<{ rows: TeacherAssignmentRecord[]; total: number }> {
    const and: Prisma.TeacherAssignmentWhereInput[] = [];
    if (!query.includeEnded) and.push(notEnded(query.today));
    if (query.academicYearId !== undefined) and.push({ academicYearId: query.academicYearId });
    const where: Prisma.TeacherAssignmentWhereInput = { schoolId, staffId, AND: and };
    const rows = await this.txHost.tx.teacherAssignment.findMany({
      where,
      select: SELECT,
      orderBy: orderBy(query.sort),
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.teacherAssignment.count({ where });
    return { rows: await this.withNames(schoolId, rows), total };
  }

  async findById(schoolId: SchoolId, id: bigint): Promise<TeacherAssignmentRecord | null> {
    const row = await this.txHost.tx.teacherAssignment.findFirst({
      where: { schoolId, id },
      select: SELECT,
    });
    return row ? ((await this.withNames(schoolId, [row]))[0] ?? null) : null;
  }

  /**
   * Locks the row to the end of the transaction if it is still as read (same updated_at),
   * writing nothing visible. False when it changed; the caller reads again.
   */
  async lockIfUnchanged(
    schoolId: SchoolId,
    row: Pick<TeacherAssignmentRecord, 'id' | 'updatedAt'>,
  ): Promise<boolean> {
    const { count } = await this.txHost.tx.teacherAssignment.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  /** A live row of the same person, role, class, section and subject overlapping the dates. */
  async findSameOverlapping(
    schoolId: SchoolId,
    a: NewTeacherAssignment,
  ): Promise<bigint | null> {
    const row = await this.txHost.tx.teacherAssignment.findFirst({
      where: {
        schoolId,
        staffId: a.staffId,
        role: a.role,
        classId: a.classId,
        sectionId: a.sectionId,
        subjectId: a.subjectId,
        ...liveOverlapping(a.startsOn, a.endsOn),
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return row?.id ?? null;
  }

  /** Live class-teacher rows of the section overlapping the dates (R23), oldest first. */
  async findClassTeacherConflicts(
    schoolId: SchoolId,
    sectionId: bigint,
    from: Date,
    to: Date | null,
  ): Promise<TeacherAssignmentRecord[]> {
    const rows = await this.txHost.tx.teacherAssignment.findMany({
      where: { schoolId, sectionId, role: 'class_teacher', ...liveOverlapping(from, to) },
      select: SELECT,
      orderBy: { id: 'asc' },
    });
    return this.withNames(schoolId, rows);
  }

  /** Rows of the staff member not voided and not ended before `today`, oldest first. */
  async findNotEndedForStaff(
    schoolId: SchoolId,
    staffId: bigint,
    today: Date,
  ): Promise<TeacherAssignmentRecord[]> {
    const rows = await this.txHost.tx.teacherAssignment.findMany({
      where: { schoolId, staffId, ...notEnded(today) },
      select: SELECT,
      orderBy: { id: 'asc' },
    });
    return this.withNames(schoolId, rows);
  }

  /** SECTION_IN_USE (contract §4.5): a live row on the section not ended before `today`. */
  async existsNotEndedOnSection(schoolId: SchoolId, sectionId: bigint, today: Date): Promise<boolean> {
    const row = await this.txHost.tx.teacherAssignment.findFirst({
      where: { schoolId, sectionId, ...notEnded(today) },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * Teacher scope (R53, R54): the sections of every row of the staff member active on `today`.
   * A row with a section gives that section; a subject-teacher row without one gives every
   * section of its class, archived included. Two sequential statements.
   */
  async activeSectionIds(schoolId: SchoolId, staffId: bigint, today: Date): Promise<bigint[]> {
    const rows = await this.txHost.tx.teacherAssignment.findMany({
      where: { schoolId, staffId, ...liveOverlapping(today, today) },
      select: { classId: true, sectionId: true },
    });
    const ids = new Set<bigint>();
    const wholeClasses: bigint[] = [];
    for (const row of rows) {
      if (row.sectionId === null) wholeClasses.push(row.classId);
      else ids.add(row.sectionId);
    }
    if (wholeClasses.length > 0) {
      const sections = await this.txHost.tx.section.findMany({
        where: { schoolId, classId: { in: wholeClasses } },
        select: { id: true },
      });
      for (const section of sections) ids.add(section.id);
    }
    return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  async create(schoolId: SchoolId, data: NewTeacherAssignment): Promise<TeacherAssignmentRecord> {
    const row = await this.txHost.tx.teacherAssignment.create({
      data: { schoolId, ...data },
      select: SELECT,
    });
    const [record] = await this.withNames(schoolId, [row]);
    if (!record) throw new Error('teacher assignment vanished after insert');
    return record;
  }

  /** Sets the last day it counts. The caller holds the row lock. */
  async setEndsOn(schoolId: SchoolId, id: bigint, endsOn: Date): Promise<void> {
    await this.txHost.tx.teacherAssignment.update({
      where: { schoolId_id: { schoolId, id } },
      data: { endsOn },
      select: { id: true },
    });
  }

  /** Marks the row as never having counted. The caller holds the row lock. */
  async void(schoolId: SchoolId, id: bigint, voidedBy: bigint, now: Date): Promise<void> {
    await this.txHost.tx.teacherAssignment.update({
      where: { schoolId_id: { schoolId, id } },
      data: { voidedAt: now, voidedBy },
      select: { id: true },
    });
  }

  /** Staff, class (with year), section and subject names for a page: four sequential reads. */
  private async withNames(schoolId: SchoolId, rows: Row[]): Promise<TeacherAssignmentRecord[]> {
    if (rows.length === 0) return [];
    const unique = (ids: (bigint | null)[]) => [
      ...new Set(ids.filter((id): id is bigint => id !== null)),
    ];
    const staff = await this.txHost.tx.staff.findMany({
      where: { schoolId, id: { in: unique(rows.map((r) => r.staffId)) } },
      select: { id: true, fullName: true },
    });
    const classes = await this.txHost.tx.class.findMany({
      where: { schoolId, id: { in: unique(rows.map((r) => r.classId)) } },
      select: { id: true, name: true, academicYear: { select: { name: true } } },
    });
    const sectionIds = unique(rows.map((r) => r.sectionId));
    const sections =
      sectionIds.length === 0
        ? []
        : await this.txHost.tx.section.findMany({
            where: { schoolId, id: { in: sectionIds } },
            select: { id: true, name: true },
          });
    const subjectIds = unique(rows.map((r) => r.subjectId));
    const subjects =
      subjectIds.length === 0
        ? []
        : await this.txHost.tx.subject.findMany({
            where: { schoolId, id: { in: subjectIds } },
            select: { id: true, name: true },
          });
    const staffNames = new Map(staff.map((s) => [s.id, s.fullName]));
    const classById = new Map(classes.map((c) => [c.id, c]));
    const sectionNames = new Map(sections.map((s) => [s.id, s.name]));
    const subjectNames = new Map(subjects.map((s) => [s.id, s.name]));
    return rows.map((row) => {
      const klass = classById.get(row.classId);
      return {
        ...row,
        staffFullName: staffNames.get(row.staffId) ?? '',
        academicYearName: klass?.academicYear.name ?? '',
        className: klass?.name ?? '',
        sectionName: row.sectionId === null ? null : (sectionNames.get(row.sectionId) ?? null),
        subjectName: row.subjectId === null ? null : (subjectNames.get(row.subjectId) ?? null),
      };
    });
  }
}
