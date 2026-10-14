import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { Scope } from '../tenancy/scope';
import { sqlDate, studentInScopeSql } from './attendance-sql';
import { Prisma, type DocumentStatus, type StudentDocumentType } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';
import { studentInScope } from './student.repository';

// The tenant table student_documents (contracts/slice-6.md §6.2, R43). Since Phase 5 (rule 36,
// contracts/slice-40.md) a document is decided once, uploaded -> verified | rejected; the document
// itself never changes and a re-upload is a new row (triggers). Every read
// takes the caller's Scope (plan §3.4): a document is visible only while its student is, i.e. the
// student has an active enrolment in a scoped section (`all` = every student of the school), the
// one definition in student.repository.ts.

export interface StudentDocumentRecord {
  id: bigint;
  studentId: bigint;
  type: StudentDocumentType;
  /** `{schoolId}/{ULID}.{ext}`: the staged upload's key, never moved. Never leaves the server. */
  objectKey: string;
  mime: string;
  sizeBytes: number;
  uploadedBy: bigint;
  uploadedByName: string | null;
  createdAt: Date;
  // Phase 5 rule 36 (contracts/slice-40.md §2).
  status: DocumentStatus;
  decidedBy: bigint | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  /** Staff-only: never in a family DTO. */
  rejectReason: string | null;
}

/** A queue row: the document with its student's names and current placement (slice-40 §1). */
export interface QueuedDocumentRecord extends StudentDocumentRecord {
  student: {
    fullName: string;
    admissionNo: string;
    className: string | null;
    sectionName: string | null;
  };
}

/** The newest row of one type of one student (the checklist and the list badge read it, R323). */
export interface NewestOfType {
  studentId: bigint;
  type: StudentDocumentType;
  status: DocumentStatus;
}

/** A student of the incomplete-admissions report (R323): the required types not yet verified. */
export interface IncompleteAdmissionRecord {
  studentId: bigint;
  admissionNo: string;
  fullName: string;
  admittedOn: Date;
  className: string | null;
  sectionName: string | null;
  missing: StudentDocumentType[];
  awaiting: StudentDocumentType[];
  rejected: StudentDocumentType[];
}

export interface StudentDocumentWrite {
  studentId: bigint;
  type: StudentDocumentType;
  objectKey: string;
  mime: string;
  sizeBytes: number;
  uploadedBy: bigint;
}

const SELECT = {
  id: true,
  studentId: true,
  type: true,
  objectKey: true,
  mime: true,
  sizeBytes: true,
  uploadedBy: true,
  createdAt: true,
  status: true,
  decidedBy: true,
  decidedAt: true,
  rejectReason: true,
  uploadedByUser: {
    select: { staff: { select: { fullName: true } }, guardian: { select: { fullName: true } } },
  },
  decidedByUser: { select: { staff: { select: { fullName: true } } } },
} satisfies Prisma.StudentDocumentSelect;

const QUEUE_SELECT = {
  ...SELECT,
  student: { select: { fullName: true, admissionNo: true } },
} satisfies Prisma.StudentDocumentSelect;

type Row = Prisma.StudentDocumentGetPayload<{ select: typeof SELECT }>;

const toRecord = ({ uploadedByUser, decidedByUser, ...row }: Row): StudentDocumentRecord => ({
  ...row,
  uploadedByName: uploadedByUser.staff?.fullName ?? uploadedByUser.guardian?.fullName ?? null,
  decidedByName: decidedByUser?.staff?.fullName ?? null,
});

/** Newest first, id breaking ties. */
const NEWEST: Prisma.StudentDocumentOrderByWithRelationInput[] = [
  { createdAt: 'desc' },
  { id: 'desc' },
];

/** Oldest first (the verification queue's default), id breaking ties. */
const OLDEST: Prisma.StudentDocumentOrderByWithRelationInput[] = [
  { createdAt: 'asc' },
  { id: 'asc' },
];

@Injectable()
export class StudentDocumentRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async create(schoolId: SchoolId, data: StudentDocumentWrite): Promise<StudentDocumentRecord> {
    return toRecord(
      await this.txHost.tx.studentDocument.create({ data: { schoolId, ...data }, select: SELECT }),
    );
  }

  async list(
    schoolId: SchoolId,
    scope: Scope,
    studentId: bigint,
    query: { type?: StudentDocumentType; skip: number; take: number },
  ): Promise<{ rows: StudentDocumentRecord[]; total: number }> {
    const where: Prisma.StudentDocumentWhereInput = {
      schoolId,
      studentId,
      student: { is: studentInScope(scope) },
      ...(query.type === undefined ? {} : { type: query.type }),
    };
    // Sequential, not Promise.all: one connection inside a transaction (§3.3).
    const rows = await this.txHost.tx.studentDocument.findMany({
      where,
      select: SELECT,
      orderBy: NEWEST,
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.studentDocument.count({ where });
    return { rows: rows.map(toRecord), total };
  }

  async findById(
    schoolId: SchoolId,
    scope: Scope,
    id: bigint,
  ): Promise<StudentDocumentRecord | null> {
    const row = await this.txHost.tx.studentDocument.findFirst({
      where: { schoolId, id, student: { is: studentInScope(scope) } },
      select: SELECT,
    });
    return row && toRecord(row);
  }

  /** The student's photo: the latest `photo` document. */
  async findLatestPhoto(
    schoolId: SchoolId,
    scope: Scope,
    studentId: bigint,
  ): Promise<StudentDocumentRecord | null> {
    const row = await this.txHost.tx.studentDocument.findFirst({
      where: { schoolId, studentId, type: 'photo', student: { is: studentInScope(scope) } },
      select: SELECT,
      orderBy: NEWEST,
    });
    return row && toRecord(row);
  }

  /** The document holding this object key, if one was committed (a staged upload's replay). */
  async findByObjectKey(
    schoolId: SchoolId,
    objectKey: string,
  ): Promise<StudentDocumentRecord | null> {
    const row = await this.txHost.tx.studentDocument.findFirst({
      where: { schoolId, objectKey },
      select: SELECT,
    });
    return row && toRecord(row);
  }

  /** Every document of the student, newest first (the admission result: at most ten). */
  async listAllForStudent(
    schoolId: SchoolId,
    scope: Scope,
    studentId: bigint,
  ): Promise<StudentDocumentRecord[]> {
    const rows = await this.txHost.tx.studentDocument.findMany({
      where: { schoolId, studentId, student: { is: studentInScope(scope) } },
      select: SELECT,
      orderBy: NEWEST,
    });
    return rows.map(toRecord);
  }

  // ---- Phase 5 slice 40: verification (contracts/slice-40.md) ------------------------------

  /**
   * The newest document of each of `types` for one student in scope (the checklist, R323), newest
   * first per type; a type with no row is absent.
   */
  async newestForStudent(
    schoolId: SchoolId,
    scope: Scope,
    studentId: bigint,
    types: readonly StudentDocumentType[],
  ): Promise<StudentDocumentRecord[]> {
    if (types.length === 0) return [];
    const rows = await this.txHost.tx.studentDocument.findMany({
      where: { schoolId, studentId, type: { in: [...types] }, student: { is: studentInScope(scope) } },
      select: SELECT,
      orderBy: NEWEST,
      distinct: ['type'],
    });
    return rows.map(toRecord);
  }

  /**
   * The verification queue (slice-40 §1.1): the school's documents of `status` whose student is
   * in the caller's scope and, with `classId`, actively enrolled in that class. Each row carries
   * its student's names and current class and section (one more statement for the page).
   */
  async listQueue(
    schoolId: SchoolId,
    scope: Scope,
    query: {
      status: DocumentStatus;
      type?: StudentDocumentType;
      classId?: bigint;
      sort: 'createdAt' | '-createdAt';
      skip: number;
      take: number;
    },
  ): Promise<{ rows: QueuedDocumentRecord[]; total: number }> {
    const student: Prisma.StudentWhereInput =
      query.classId === undefined
        ? studentInScope(scope)
        : {
            AND: [
              studentInScope(scope),
              { enrolments: { some: { status: 'active', classId: query.classId } } },
            ],
          };
    const where: Prisma.StudentDocumentWhereInput = {
      schoolId,
      status: query.status,
      student: { is: student },
      ...(query.type === undefined ? {} : { type: query.type }),
    };
    const rows = await this.txHost.tx.studentDocument.findMany({
      where,
      select: QUEUE_SELECT,
      orderBy: query.sort === 'createdAt' ? OLDEST : NEWEST,
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.studentDocument.count({ where });
    const placements = await this.placements(schoolId, [...new Set(rows.map((r) => r.studentId))]);
    return {
      rows: rows.map(({ student: s, ...row }) => ({
        ...toRecord(row),
        student: {
          fullName: s.fullName,
          admissionNo: s.admissionNo,
          className: placements.get(row.studentId)?.className ?? null,
          sectionName: placements.get(row.studentId)?.sectionName ?? null,
        },
      })),
      total,
    };
  }

  /**
   * Decides an `uploaded` document (slice-40 §2.2): one conditional update, so of two racing
   * decisions one changes the row and the other counts 0. The triggers refuse a second decision
   * and a decision by the uploader.
   */
  async decide(
    schoolId: SchoolId,
    id: bigint,
    decision: { status: 'verified' | 'rejected'; by: bigint; at: Date; reason: string | null },
  ): Promise<number> {
    const { count } = await this.txHost.tx.studentDocument.updateMany({
      where: { schoolId, id, status: 'uploaded' },
      data: {
        status: decision.status,
        decidedBy: decision.by,
        decidedAt: decision.at,
        rejectReason: decision.reason,
      },
    });
    return count;
  }

  /**
   * R323 for a page of students (the list badge): the newest row of each of `types` per student,
   * DISTINCT ON over the (school_id, student_id, type, created_at) index. A type with no row is
   * absent. Read through the caller's row scope as well (a student outside it has no rows here),
   * so the badge never reads beyond what the caller may see even if a caller passes a wider list.
   */
  async newestOfTypes(
    schoolId: SchoolId,
    scope: Scope,
    studentIds: readonly bigint[],
    types: readonly StudentDocumentType[],
  ): Promise<NewestOfType[]> {
    if (studentIds.length === 0 || types.length === 0) return [];
    const rows = await this.txHost.tx.$queryRaw<
      { student_id: bigint; type: StudentDocumentType; status: DocumentStatus }[]
    >`
      SELECT DISTINCT ON (d.student_id, d.type) d.student_id, d.type::text AS type, d.status::text AS status
        FROM student_documents d
       WHERE d.school_id = ${schoolId}
         AND d.student_id IN (${Prisma.join([...studentIds])})
         AND d.type::text IN (${Prisma.join([...types])})
         AND ${studentInScopeSql(scope, Prisma.sql`d.school_id`, Prisma.sql`d.student_id`)}
       ORDER BY d.student_id, d.type, d.created_at DESC, d.id DESC`;
    return rows.map((r) => ({ studentId: r.student_id, type: r.type, status: r.status }));
  }

  /**
   * R323: students admitted between `from` and `to` (inclusive), on the roll (active or
   * suspended) and in the caller's scope, whose newest row of a required type is missing,
   * awaiting a decision or rejected. Paged in SQL; `total` counts the same set.
   */
  async incompleteAdmissions(
    schoolId: SchoolId,
    scope: Scope,
    query: {
      from: Date;
      to: Date;
      types: readonly StudentDocumentType[];
      sort: 'admittedOn' | '-admittedOn';
      skip: number;
      take: number;
    },
  ): Promise<{ rows: IncompleteAdmissionRecord[]; total: number }> {
    if (query.types.length === 0) return { rows: [], total: 0 };
    const direction = query.sort === 'admittedOn' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
    const checklist = Prisma.sql`
      WITH req AS (
        SELECT DISTINCT t::student_document_type AS type
          FROM unnest(ARRAY[${Prisma.join([...query.types])}]::text[]) AS t
      ),
      roll AS (
        SELECT s.id, s.admission_no, s.full_name, s.admitted_on
          FROM students s
         WHERE s.school_id = ${schoolId}
           AND s.admitted_on BETWEEN ${sqlDate(query.from)} AND ${sqlDate(query.to)}
           AND s.status IN ('active', 'suspended')
           AND ${studentInScopeSql(scope, Prisma.sql`s.school_id`, Prisma.sql`s.id`)}
      ),
      newest AS (
        SELECT DISTINCT ON (d.student_id, d.type) d.student_id, d.type, d.status
          FROM student_documents d
          JOIN roll r ON r.id = d.student_id
         WHERE d.school_id = ${schoolId} AND d.type IN (SELECT type FROM req)
         ORDER BY d.student_id, d.type, d.created_at DESC, d.id DESC
      ),
      checklist AS (
        SELECT r.id, r.admission_no, r.full_name, r.admitted_on,
               array_agg(q.type::text ORDER BY q.type) FILTER (WHERE n.status IS NULL) AS missing,
               array_agg(q.type::text ORDER BY q.type) FILTER (WHERE n.status = 'uploaded') AS awaiting,
               array_agg(q.type::text ORDER BY q.type) FILTER (WHERE n.status = 'rejected') AS rejected
          FROM roll r
         CROSS JOIN req q
          LEFT JOIN newest n ON n.student_id = r.id AND n.type = q.type
         GROUP BY r.id, r.admission_no, r.full_name, r.admitted_on
        HAVING bool_or(n.status IS DISTINCT FROM 'verified')
      )`;
    const rows = await this.txHost.tx.$queryRaw<
      {
        id: bigint;
        admission_no: string;
        full_name: string;
        admitted_on: Date;
        missing: StudentDocumentType[] | null;
        awaiting: StudentDocumentType[] | null;
        rejected: StudentDocumentType[] | null;
      }[]
    >`${checklist}
      SELECT * FROM checklist
       ORDER BY admitted_on ${direction}, id ${direction}
       LIMIT ${query.take} OFFSET ${query.skip}`;
    const counted = await this.txHost.tx.$queryRaw<{ total: bigint }[]>`${checklist}
      SELECT count(*)::bigint AS total FROM checklist`;
    const placements = await this.placements(schoolId, rows.map((r) => r.id));
    return {
      rows: rows.map((r) => ({
        studentId: r.id,
        admissionNo: r.admission_no,
        fullName: r.full_name,
        admittedOn: r.admitted_on,
        className: placements.get(r.id)?.className ?? null,
        sectionName: placements.get(r.id)?.sectionName ?? null,
        missing: r.missing ?? [],
        awaiting: r.awaiting ?? [],
        rejected: r.rejected ?? [],
      })),
      total: Number(counted[0]?.total ?? 0n),
    };
  }

  /** Each student's active enrolment's class and section names (none: absent). */
  private async placements(
    schoolId: SchoolId,
    studentIds: readonly bigint[],
  ): Promise<Map<bigint, { className: string; sectionName: string }>> {
    if (studentIds.length === 0) return new Map();
    const rows = await this.txHost.tx.enrolment.findMany({
      where: { schoolId, studentId: { in: [...studentIds] }, status: 'active' },
      select: { studentId: true, class: { select: { name: true } }, section: { select: { name: true } } },
    });
    return new Map(
      rows.map((r) => [r.studentId, { className: r.class.name, sectionName: r.section.name }]),
    );
  }
}
