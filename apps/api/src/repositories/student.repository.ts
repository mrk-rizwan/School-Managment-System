import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { Scope } from '../tenancy/scope';
import type { Gender, Prisma, StudentStatus } from './generated/prisma/client';
import { escapeLike, type PrismaTxAdapter } from './prisma';

// contracts/slice-6.md §1-§3. The tenant table students. `bForm` is the field-encryption envelope
// (AAD `schoolId|students|b_form`, common/identity.ts bFormAad) and `bFormHash` its lookup HMAC;
// this repository stores the envelope and compares the hash, and never decrypts. Decryption is in
// the services only: the masked student view, the student login, and the leaving certificate's
// print view (which reads the envelope through CertificateRepository.studentBForm).
//
// Shared interface (slice 6B's admission and readmission call these inside their transaction;
// keep the signatures stable):
//   create(schoolId, data: StudentCreate): Promise<StudentRecord>
//   findByBFormHash(schoolId, bFormHash): Promise<StudentRecord | null>      (unscoped: lookup)
//   findById(schoolId, scope, id): Promise<StudentRecord | null>             (scoped)
//   lockIfUnchanged(schoolId, row): Promise<boolean>                         (readLocked's lock)
//   update(schoolId, id, data: StudentChanges): Promise<StudentRecord>
//   nextAdmissionNo(schoolId): Promise<string>       (UPDATE school_counters ... RETURNING, R34)
//   findPossibleDuplicates(schoolId, match): Promise<StudentRecord[]>      (admission, R87)
//   latestPhotoDocumentId(schoolId, studentId): Promise<bigint | null>

export interface StudentRecord {
  id: bigint;
  admissionNo: string;
  fullName: string;
  gender: Gender;
  /** UTC midnight of the calendar date (a `date` column). */
  dateOfBirth: Date;
  /** Ciphertext (`v1:...`), AAD `schoolId|students|b_form`. */
  bForm: string | null;
  bFormHash: string | null;
  status: StudentStatus;
  admittedOn: Date;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** The login linked to this student (users.student_id), if any. */
  userId: bigint | null;
}

export interface StudentCreate {
  /** From nextAdmissionNo, in the same transaction. */
  admissionNo: string;
  fullName: string;
  gender: Gender;
  dateOfBirth: Date;
  bForm: string | null;
  bFormHash: string | null;
  admittedOn: Date;
  notes: string | null;
}

export type StudentChanges = Partial<
  Pick<
    StudentRecord,
    'fullName' | 'gender' | 'dateOfBirth' | 'bForm' | 'bFormHash' | 'notes' | 'status'
  >
>;

export type StudentSortField = 'fullName' | 'admissionNo' | 'admittedOn';
export type StudentSort = StudentSortField | `-${StudentSortField}` | 'rollNo';

export interface StudentListQuery {
  status?: StudentStatus;
  /** Applied to the active enrolment. */
  academicYearId?: bigint;
  classId?: bigint;
  sectionId?: bigint;
  gender?: Gender;
  hasBForm?: boolean;
  hasLogin?: boolean;
  admittedOnFrom?: Date;
  admittedOnTo?: Date;
  /** Trimmed, 2-100 characters, no identity number (the DTO's job). */
  q?: string;
  sort: StudentSort;
  skip: number;
  take: number;
}

const SELECT = {
  id: true,
  admissionNo: true,
  fullName: true,
  gender: true,
  dateOfBirth: true,
  bForm: true,
  bFormHash: true,
  status: true,
  admittedOn: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true } },
} satisfies Prisma.StudentSelect;

type Row = Prisma.StudentGetPayload<{ select: typeof SELECT }>;

const toRecord = ({ user, ...row }: Row): StudentRecord => ({ ...row, userId: user?.id ?? null });

/**
 * The row scope over students (plan §3.4, contract §1): in scope when the student has an `active`
 * enrolment in one of the scope's sections. `all` adds no condition; an empty list matches no row.
 * A `students` scope (guardian or student capacity, contracts/slice-13.md §1.2) is exactly its
 * ids with **no enrolment condition**: a guardian keeps a child who is no longer active while the
 * link is live (R164), history included. It is an `id` condition, so callers combine it with AND,
 * never by spreading it next to an `id`. Every repository over student-linked rows applies it
 * through this definition (or studentInScopeOn, its form for a read gated on the row's date; raw
 * SQL uses studentInScopeSql in attendance-sql.ts, the same predicate).
 */
export function studentInScope(scope: Scope): Prisma.StudentWhereInput {
  switch (scope.kind) {
    case 'all':
      return {};
    case 'students':
      return { id: { in: [...scope.ids] } };
    case 'sections':
      return { enrolments: { some: { status: 'active', sectionId: { in: [...scope.ids] } } } };
  }
}

/**
 * studentInScope for a read the caller gated on the row's own date with a dated scope turned into
 * a Scope (`rowScope`, contracts/slice-10.md §7.2): a section scope admits a student with an
 * enrolment in one of its sections **in force on `on`**, whatever that enrolment's status now, so
 * a child who has since moved or left keeps their day on the register they were marked in (R174).
 * `all` and `students` are exactly studentInScope.
 */
export function studentInScopeOn(scope: Scope, on: Date): Prisma.StudentWhereInput {
  if (scope.kind !== 'sections') return studentInScope(scope);
  return {
    enrolments: {
      some: {
        sectionId: { in: [...scope.ids] },
        startedOn: { lte: on },
        OR: [{ endedOn: null }, { endedOn: { gte: on } }],
      },
    },
  };
}

/**
 * ORDER BY for a students page; id breaks ties so paging is stable. `admissionNo` orders by id:
 * admission numbers are digits in a text column (numeric order needs length() first, which
 * Prisma cannot express), and every admission takes the next counter value under the counter's
 * row lock before inserting the student (R34), so id order is admission-number order.
 */
function orderBy(sort: Exclude<StudentSort, 'rollNo'>): Prisma.StudentOrderByWithRelationInput[] {
  const direction: Prisma.SortOrder = sort.startsWith('-') ? 'desc' : 'asc';
  switch (sort.replace(/^-/, '')) {
    case 'admissionNo':
      return [{ id: direction }];
    case 'admittedOn':
      return [{ admittedOn: direction }, { id: 'asc' }];
    default:
      return [{ fullName: direction }, { id: 'asc' }];
  }
}

const presence = (present: boolean) => (present ? { not: null } : null);

@Injectable()
export class StudentRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async list(
    schoolId: SchoolId,
    scope: Scope,
    query: StudentListQuery,
  ): Promise<{ rows: StudentRecord[]; total: number }> {
    const where = this.listWhere(schoolId, scope, query);
    const total = await this.txHost.tx.student.count({ where });
    if (query.sort !== 'rollNo') {
      const rows = await this.txHost.tx.student.findMany({
        where,
        select: SELECT,
        orderBy: orderBy(query.sort),
        skip: query.skip,
        take: query.take,
      });
      return { rows: rows.map(toRecord), total };
    }
    return { rows: await this.pageByRollNo(schoolId, where, query), total };
  }

  /** Scoped: a student outside the scope reads as absent (404, contract §1). */
  async findById(schoolId: SchoolId, scope: Scope, id: bigint): Promise<StudentRecord | null> {
    const row = await this.txHost.tx.student.findFirst({
      // AND, not a spread: a `students` scope is itself an `id` condition.
      where: { schoolId, id, AND: [studentInScope(scope)] },
      select: SELECT,
    });
    return row && toRecord(row);
  }

  /**
   * The student holding this B-Form hash (unique per school). Deliberately whole-school, with no
   * Scope argument (tenancy control 7's named exception): the B-Form is unique across the school,
   * so the uniqueness check behind POST /students/lookup, admission and a B-Form patch must
   * see every student, not only those in the caller's sections. Only office capabilities
   * reach it — `student.create` (lookup, admission) and
   * `student.update` (patch, which first reads its own student through the caller's scope); no
   * role but principal and office staff holds either by default — and every route spends the
   * identity-probe budget for it. Callers answer with no more than their contract's 409 or hit.
   */
  async findByBFormHash(schoolId: SchoolId, bFormHash: string): Promise<StudentRecord | null> {
    const row = await this.txHost.tx.student.findFirst({
      where: { schoolId, bFormHash },
      select: SELECT,
    });
    return row && toRecord(row);
  }

  /**
   * Admission's possible-duplicate check (contract §6.3): same name (case-insensitive, already
   * normalised by the DTO), same date of birth, and a live link to `guardianId`. Deliberately
   * whole-school, with no Scope argument: a duplicate admission is a duplicate wherever in the
   * school the existing child sits. Reached only from POST /admissions (`student.create`, an
   * office capability) and answers with the matches the contract's 409 lists.
   */
  async findPossibleDuplicates(
    schoolId: SchoolId,
    match: { fullName: string; dateOfBirth: Date; guardianId: bigint },
  ): Promise<StudentRecord[]> {
    const rows = await this.txHost.tx.student.findMany({
      where: {
        schoolId,
        dateOfBirth: match.dateOfBirth,
        fullName: { equals: match.fullName, mode: 'insensitive' },
        guardianLinks: { some: { guardianId: match.guardianId, endedAt: null } },
      },
      select: SELECT,
      orderBy: { id: 'asc' },
      take: 20,
    });
    return rows.map(toRecord);
  }

  /** New rows are `active`. A taken B-Form fails students_school_id_b_form_hash_key. */
  async create(schoolId: SchoolId, data: StudentCreate): Promise<StudentRecord> {
    const row = await this.txHost.tx.student.create({
      data: { schoolId, ...data, status: 'active' },
      select: SELECT,
    });
    return toRecord(row);
  }

  /**
   * Locks the row for the rest of the transaction if it is still exactly as `row` was read (same
   * updated_at), writing nothing visible. False when it changed since; the caller reads again.
   */
  async lockIfUnchanged(
    schoolId: SchoolId,
    row: Pick<StudentRecord, 'id' | 'updatedAt'>,
  ): Promise<boolean> {
    const { count } = await this.txHost.tx.student.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  /** Plain attributes. The caller holds the row lock. */
  async update(schoolId: SchoolId, id: bigint, data: StudentChanges): Promise<StudentRecord> {
    const row = await this.txHost.tx.student.update({
      where: { schoolId_id: { schoolId, id } },
      data,
      select: SELECT,
    });
    return toRecord(row);
  }

  /**
   * The next admission number: `UPDATE school_counters SET value = value + 1 ... RETURNING`. The
   * counter row stays locked to the end of the transaction, so numbers are consecutive under
   * concurrency and a rollback leaves no gap (R34). Every school has the row from creation.
   */
  async nextAdmissionNo(schoolId: SchoolId): Promise<string> {
    const row = await this.txHost.tx.schoolCounter.update({
      where: { schoolId_name: { schoolId, name: 'admission_no' } },
      data: { value: { increment: 1 } },
      select: { value: true },
    });
    return row.value.toString();
  }

  /**
   * The school's students on the roll, active or suspended (a suspended student is still charged,
   * rule 20): the one figure the platform's billing sees (school-metrics-rollup, slice 26). A
   * count with no row scope: it is a system job's read, never a person's.
   */
  countOnRoll(schoolId: SchoolId): Promise<number> {
    return this.txHost.tx.student.count({ where: { schoolId, status: { in: ['active', 'suspended'] } } });
  }

  /** The latest `photo` document of the student, if any. */
  async latestPhotoDocumentId(schoolId: SchoolId, studentId: bigint): Promise<bigint | null> {
    const row = await this.txHost.tx.studentDocument.findFirst({
      where: { schoolId, studentId, type: 'photo' },
      select: { id: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return row?.id ?? null;
  }

  private listWhere(
    schoolId: SchoolId,
    scope: Scope,
    query: StudentListQuery,
  ): Prisma.StudentWhereInput {
    const and: Prisma.StudentWhereInput[] = [studentInScope(scope)];
    if (query.status !== undefined) and.push({ status: query.status });
    if (
      query.academicYearId !== undefined ||
      query.classId !== undefined ||
      query.sectionId !== undefined
    ) {
      // A student has at most one active enrolment (enrolments_student_active_key).
      and.push({
        enrolments: {
          some: {
            status: 'active',
            ...(query.academicYearId === undefined ? {} : { academicYearId: query.academicYearId }),
            ...(query.classId === undefined ? {} : { classId: query.classId }),
            ...(query.sectionId === undefined ? {} : { sectionId: query.sectionId }),
          },
        },
      });
    }
    if (query.gender !== undefined) and.push({ gender: query.gender });
    if (query.hasBForm !== undefined) and.push({ bFormHash: presence(query.hasBForm) });
    if (query.hasLogin !== undefined) {
      and.push(query.hasLogin ? { user: { isNot: null } } : { user: { is: null } });
    }
    if (query.admittedOnFrom !== undefined) and.push({ admittedOn: { gte: query.admittedOnFrom } });
    if (query.admittedOnTo !== undefined) and.push({ admittedOn: { lte: query.admittedOnTo } });
    if (query.q !== undefined) {
      const term = escapeLike(query.q);
      and.push({
        OR: [
          { fullName: { contains: term, mode: 'insensitive' } },
          { admissionNo: { startsWith: term } },
        ],
      });
    }
    return { schoolId, AND: and };
  }

  /**
   * `sort=rollNo`: students with an active enrolment first, by roll number (nulls last) then
   * student id, read through enrolments; then the rest (no active enrolment, so no roll number)
   * by id. Sequential statements (§3.3).
   */
  private async pageByRollNo(
    schoolId: SchoolId,
    where: Prisma.StudentWhereInput,
    query: StudentListQuery,
  ): Promise<StudentRecord[]> {
    const enrolled: Prisma.EnrolmentWhereInput = {
      schoolId,
      status: 'active',
      student: { is: where },
    };
    const enrolledCount = await this.txHost.tx.enrolment.count({ where: enrolled });
    const ids: bigint[] = [];
    if (query.skip < enrolledCount) {
      const page = await this.txHost.tx.enrolment.findMany({
        where: enrolled,
        select: { studentId: true },
        orderBy: [{ rollNo: { sort: 'asc', nulls: 'last' } }, { studentId: 'asc' }],
        skip: query.skip,
        take: query.take,
      });
      ids.push(...page.map((r) => r.studentId));
    }
    const remaining = query.take - ids.length;
    if (remaining > 0) {
      const rest = await this.txHost.tx.student.findMany({
        where: { AND: [where, { enrolments: { none: { status: 'active' } } }], schoolId },
        select: { id: true },
        orderBy: { id: 'asc' },
        skip: Math.max(0, query.skip - enrolledCount),
        take: remaining,
      });
      ids.push(...rest.map((r) => r.id));
    }
    if (ids.length === 0) return [];
    const rows = await this.txHost.tx.student.findMany({
      where: { schoolId, id: { in: ids } },
      select: SELECT,
    });
    const byId = new Map(rows.map((row) => [row.id, toRecord(row)]));
    return ids.flatMap((id) => byId.get(id) ?? []);
  }
}
