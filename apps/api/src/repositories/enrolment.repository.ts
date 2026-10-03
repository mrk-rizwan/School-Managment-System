import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { Scope } from '../tenancy/scope';
import type { EnrolmentStatus, Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';
import { studentInScope } from './student.repository';

// contracts/slice-6.md §5 (rule 6: enrolment is the hub). One `active` row per student
// (enrolments_student_active_key); roll numbers unique per section among active rows
// (enrolments_section_roll_no_key, R37). student_id, academic_year_id and class_id never change
// (trigger enrolments_columns_immutable): a class move closes the row and opens another (R39).
//
// Shared interface (slice 6B's admission and readmission call these inside their transaction;
// keep the signatures stable):
//   create(schoolId, data: EnrolmentCreate): Promise<EnrolmentRecord>       (status active)
//   findActiveForStudent(schoolId, scope, studentId): Promise<EnrolmentRecord | null>
//   findActiveByRollNo(schoolId, sectionId, rollNo): Promise<EnrolmentRecord | null>
//   withNames(schoolId, rows): Promise<EnrolmentView[]>

export interface EnrolmentRecord {
  id: bigint;
  studentId: bigint;
  academicYearId: bigint;
  classId: bigint;
  sectionId: bigint;
  rollNo: number | null;
  status: EnrolmentStatus;
  /** UTC midnight of the calendar date (a `date` column). */
  startedOn: Date;
  endedOn: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** An enrolment with the names of its year, class and section, for the DTO. */
export interface EnrolmentView extends EnrolmentRecord {
  academicYearName: string;
  className: string;
  sectionName: string;
}

export interface EnrolmentCreate {
  studentId: bigint;
  academicYearId: bigint;
  classId: bigint;
  sectionId: bigint;
  rollNo: number | null;
  startedOn: Date;
}

const SELECT = {
  id: true,
  studentId: true,
  academicYearId: true,
  classId: true,
  sectionId: true,
  rollNo: true,
  status: true,
  startedOn: true,
  endedOn: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.EnrolmentSelect;

@Injectable()
export class EnrolmentRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** A new `active` enrolment. A second active row fails enrolments_student_active_key. */
  create(schoolId: SchoolId, data: EnrolmentCreate): Promise<EnrolmentRecord> {
    return this.txHost.tx.enrolment.create({
      data: { schoolId, ...data, status: 'active' },
      select: SELECT,
    });
  }

  /** Scoped through the enrolment's student (contract §1): out of scope reads as absent. */
  findById(schoolId: SchoolId, scope: Scope, id: bigint): Promise<EnrolmentRecord | null> {
    return this.txHost.tx.enrolment.findFirst({
      where: { schoolId, id, student: { is: studentInScope(scope) } },
      select: SELECT,
    });
  }

  /** Scoped through the student (tenancy control 7): out of scope reads as absent. */
  findActiveForStudent(
    schoolId: SchoolId,
    scope: Scope,
    studentId: bigint,
  ): Promise<EnrolmentRecord | null> {
    return this.txHost.tx.enrolment.findFirst({
      where: { schoolId, studentId, status: 'active', student: { is: studentInScope(scope) } },
      select: SELECT,
    });
  }

  /** The active enrolment holding `rollNo` in the section (R37), if any. */
  findActiveByRollNo(
    schoolId: SchoolId,
    sectionId: bigint,
    rollNo: number,
  ): Promise<EnrolmentRecord | null> {
    return this.txHost.tx.enrolment.findFirst({
      where: { schoolId, sectionId, rollNo, status: 'active' },
      select: SELECT,
    });
  }

  /** A student's enrolments, newest first; none when the student is out of scope. */
  async listForStudent(
    schoolId: SchoolId,
    scope: Scope,
    studentId: bigint,
    page: { skip: number; take: number },
  ): Promise<{ rows: EnrolmentRecord[]; total: number }> {
    const where = { schoolId, studentId, student: { is: studentInScope(scope) } };
    const rows = await this.txHost.tx.enrolment.findMany({
      where,
      select: SELECT,
      orderBy: [{ startedOn: 'desc' }, { id: 'desc' }],
      skip: page.skip,
      take: page.take,
    });
    const total = await this.txHost.tx.enrolment.count({ where });
    return { rows, total };
  }

  /** The active enrolments of several students (at most one each), with names; in scope only. */
  async activeForStudents(
    schoolId: SchoolId,
    scope: Scope,
    studentIds: readonly bigint[],
  ): Promise<EnrolmentView[]> {
    if (studentIds.length === 0) return [];
    const rows = await this.txHost.tx.enrolment.findMany({
      where: {
        schoolId,
        studentId: { in: [...studentIds] },
        status: 'active',
        student: { is: studentInScope(scope) },
      },
      select: SELECT,
    });
    return this.withNames(schoolId, rows);
  }

  /**
   * Year, class and section names for a page of enrolments: three sequential statements whatever
   * the page size (§3.3: no concurrent relation loads inside a transaction).
   */
  async withNames(schoolId: SchoolId, rows: EnrolmentRecord[]): Promise<EnrolmentView[]> {
    if (rows.length === 0) return [];
    const unique = (pick: (row: EnrolmentRecord) => bigint) => [...new Set(rows.map(pick))];
    const years = await this.txHost.tx.academicYear.findMany({
      where: { schoolId, id: { in: unique((r) => r.academicYearId) } },
      select: { id: true, name: true },
    });
    const classes = await this.txHost.tx.class.findMany({
      where: { schoolId, id: { in: unique((r) => r.classId) } },
      select: { id: true, name: true },
    });
    const sections = await this.txHost.tx.section.findMany({
      where: { schoolId, id: { in: unique((r) => r.sectionId) } },
      select: { id: true, name: true },
    });
    const name = (list: { id: bigint; name: string }[]) => {
      const byId = new Map(list.map((r) => [r.id, r.name]));
      return (id: bigint) => byId.get(id) ?? '';
    };
    const year = name(years);
    const klass = name(classes);
    const section = name(sections);
    return rows.map((row) => ({
      ...row,
      academicYearName: year(row.academicYearId),
      className: klass(row.classId),
      sectionName: section(row.sectionId),
    }));
  }

  /**
   * Locks the row for the rest of the transaction if it is still exactly as `row` was read.
   * False when it changed since; the caller reads again.
   */
  async lockIfUnchanged(
    schoolId: SchoolId,
    row: Pick<EnrolmentRecord, 'id' | 'updatedAt'>,
  ): Promise<boolean> {
    const { count } = await this.txHost.tx.enrolment.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  /**
   * Roll number and, for an in-place section change, the section (R37: the caller clears the roll
   * number with it). A taken roll number fails enrolments_section_roll_no_key.
   */
  update(
    schoolId: SchoolId,
    id: bigint,
    data: { rollNo?: number | null; sectionId?: bigint },
  ): Promise<EnrolmentRecord> {
    return this.txHost.tx.enrolment.update({
      where: { schoolId_id: { schoolId, id } },
      data,
      select: SELECT,
    });
  }

  /**
   * Ends an active enrolment: `left` for exits and class moves (`completed` is reserved for year
   * end). Returns rows changed (0 when it was no longer active).
   */
  async close(schoolId: SchoolId, id: bigint, endedOn: Date): Promise<number> {
    const { count } = await this.txHost.tx.enrolment.updateMany({
      where: { schoolId, id, status: 'active' },
      data: { status: 'left', endedOn },
    });
    return count;
  }

  // ------------------------------------------------- academic-structure seams (slice 3, R44)

  async hasActiveInYear(schoolId: SchoolId, academicYearId: bigint): Promise<boolean> {
    return this.exists({ schoolId, academicYearId, status: 'active' });
  }

  async hasActiveInClass(schoolId: SchoolId, classId: bigint): Promise<boolean> {
    return this.exists({ schoolId, classId, status: 'active' });
  }

  async hasActiveInSection(schoolId: SchoolId, sectionId: bigint): Promise<boolean> {
    return this.exists({ schoolId, sectionId, status: 'active' });
  }

  private async exists(
    where: Prisma.EnrolmentWhereInput & { schoolId: SchoolId },
  ): Promise<boolean> {
    const row = await this.txHost.tx.enrolment.findFirst({ where, select: { id: true } });
    return row !== null;
  }
}
