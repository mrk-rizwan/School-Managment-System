import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { Scope } from '../tenancy/scope';
import type {
  ContactCapability,
  GuardianRelationship,
  Prisma,
  StudentStatus,
} from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';
import { studentInScope } from './student.repository';

// contracts/slice-6.md §4 (rule 9). The tenant table student_guardians. A link is live while
// ended_at is null; ending sets it, nothing is deleted. Exactly one live primary contact per
// student is the partial unique student_guardians_primary_key (R28); one live link per pair is
// student_guardians_live_pair_key. student_id and guardian_id never change (trigger).
//
// Shared interface (slice 6B's admission and readmission call these inside their transaction;
// keep the signatures stable):
//   create(schoolId, data: GuardianLinkCreate): Promise<GuardianLinkRecord>
//   liveForStudent(schoolId, scope, studentId): Promise<GuardianLinkRecord[]>
//   views(schoolId, rows): Promise<GuardianLinkView[]>

export interface GuardianLinkRecord {
  id: bigint;
  studentId: bigint;
  guardianId: bigint;
  relationship: GuardianRelationship;
  isPrimaryContact: boolean;
  isFeePayer: boolean;
  canLogin: boolean;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The guardian side of a link, as GuardianLinkDto shows it. */
export interface LinkedGuardian {
  fullName: string;
  phone: string | null;
  /** Ciphertext, AAD `schoolId|guardians|cnic`. */
  cnic: string | null;
  contactCapability: ContactCapability;
  address: string | null;
  userId: bigint | null;
}

export interface GuardianLinkView extends GuardianLinkRecord {
  guardian: LinkedGuardian;
}

/** A link seen from the guardian, with the student's name (GET /guardians/:id/students). */
export interface GuardianStudentLink extends GuardianLinkRecord {
  studentFullName: string;
  admissionNo: string;
}

/** A child in a guardian's capacity scope (contracts/slice-13.md §1.2, MeDto.children). */
export interface GuardianChildLink {
  studentId: bigint;
  /** This guardian's own link. */
  relationship: GuardianRelationship;
  fullName: string;
  status: StudentStatus;
}

export interface GuardianLinkCreate {
  studentId: bigint;
  guardianId: bigint;
  relationship: GuardianRelationship;
  isPrimaryContact: boolean;
  isFeePayer: boolean;
  canLogin: boolean;
}

export type GuardianLinkChanges = Partial<
  Pick<GuardianLinkRecord, 'relationship' | 'isPrimaryContact' | 'isFeePayer' | 'canLogin'>
>;

const SELECT = {
  id: true,
  studentId: true,
  guardianId: true,
  relationship: true,
  isPrimaryContact: true,
  isFeePayer: true,
  canLogin: true,
  endedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.StudentGuardianSelect;

const live = (includeEnded: boolean) => (includeEnded ? {} : { endedAt: null });

@Injectable()
export class StudentGuardianRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /**
   * A live link. A second live link of the pair fails student_guardians_live_pair_key; a second
   * live primary fails student_guardians_primary_key (clear the current one first).
   */
  create(schoolId: SchoolId, data: GuardianLinkCreate): Promise<GuardianLinkRecord> {
    return this.txHost.tx.studentGuardian.create({
      data: { schoolId, ...data },
      select: SELECT,
    });
  }

  /** Scoped through the link's student (contract §1): out of scope reads as absent. */
  findById(schoolId: SchoolId, scope: Scope, id: bigint): Promise<GuardianLinkRecord | null> {
    return this.txHost.tx.studentGuardian.findFirst({
      where: { schoolId, id, student: { is: studentInScope(scope) } },
      select: SELECT,
    });
  }

  findLivePair(
    schoolId: SchoolId,
    studentId: bigint,
    guardianId: bigint,
  ): Promise<GuardianLinkRecord | null> {
    return this.txHost.tx.studentGuardian.findFirst({
      where: { schoolId, studentId, guardianId, endedAt: null },
      select: SELECT,
    });
  }

  /** The student's live links, oldest first (R28 and R29 are decided over these). */
  liveForStudent(
    schoolId: SchoolId,
    scope: Scope,
    studentId: bigint,
  ): Promise<GuardianLinkRecord[]> {
    return this.txHost.tx.studentGuardian.findMany({
      where: { schoolId, studentId, endedAt: null, student: { is: studentInScope(scope) } },
      select: SELECT,
      orderBy: { id: 'asc' },
    });
  }

  /** Primary contact first, then by guardian name; none when the student is out of scope. */
  async listForStudent(
    schoolId: SchoolId,
    scope: Scope,
    studentId: bigint,
    query: { includeEnded: boolean; skip: number; take: number },
  ): Promise<{ rows: GuardianLinkView[]; total: number }> {
    const where = {
      schoolId,
      studentId,
      ...live(query.includeEnded),
      student: { is: studentInScope(scope) },
    };
    const rows = await this.txHost.tx.studentGuardian.findMany({
      where,
      select: SELECT,
      orderBy: [{ isPrimaryContact: 'desc' }, { guardian: { fullName: 'asc' } }, { id: 'asc' }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.studentGuardian.count({ where });
    return { rows: await this.views(schoolId, rows), total };
  }

  /** The guardian side of each link: one statement whatever the number of links. */
  async views(schoolId: SchoolId, rows: GuardianLinkRecord[]): Promise<GuardianLinkView[]> {
    if (rows.length === 0) return [];
    const guardians = await this.txHost.tx.guardian.findMany({
      where: { schoolId, id: { in: [...new Set(rows.map((r) => r.guardianId))] } },
      select: {
        id: true,
        fullName: true,
        phone: true,
        cnic: true,
        contactCapability: true,
        address: true,
        user: { select: { id: true } },
      },
    });
    const byId = new Map(
      guardians.map(({ id, user, ...g }) => [id, { ...g, userId: user?.id ?? null }]),
    );
    return rows.flatMap((row) => {
      const guardian = byId.get(row.guardianId);
      return guardian ? [{ ...row, guardian }] : [];
    });
  }

  /** Plain flags. The caller holds the student's row lock. */
  update(schoolId: SchoolId, id: bigint, data: GuardianLinkChanges): Promise<GuardianLinkRecord> {
    return this.txHost.tx.studentGuardian.update({
      where: { schoolId_id: { schoolId, id } },
      data,
      select: SELECT,
    });
  }

  /** Clears the live primary contact of the student, before another link takes it. */
  async clearPrimary(schoolId: SchoolId, studentId: bigint): Promise<number> {
    const { count } = await this.txHost.tx.studentGuardian.updateMany({
      where: { schoolId, studentId, isPrimaryContact: true, endedAt: null },
      data: { isPrimaryContact: false },
    });
    return count;
  }

  /** Sets ended_at on a live link. Returns rows changed (0 when already ended). */
  async end(schoolId: SchoolId, id: bigint, endedAt: Date): Promise<number> {
    const { count } = await this.txHost.tx.studentGuardian.updateMany({
      where: { schoolId, id, endedAt: null },
      data: { endedAt },
    });
    return count;
  }

  // -------------------------------------------------------------- guardian seams (slice 5)

  /** A live link of the guardian with can_login (gates guardian issue-login). */
  async hasLiveLoginLink(schoolId: SchoolId, guardianId: bigint): Promise<boolean> {
    const row = await this.txHost.tx.studentGuardian.findFirst({
      where: { schoolId, guardianId, canLogin: true, endedAt: null },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * The guardian capacity scope's rows (contracts/slice-13.md §1.2, R163): the guardian's live
   * links with `can_login`, the guardian not merged, with each child's name and status, by name.
   * No enrolment or status condition: a child who has left stays while the link is live (R164).
   * Read on every guardian request, never cached (R69).
   */
  async liveLoginChildren(schoolId: SchoolId, guardianId: bigint): Promise<GuardianChildLink[]> {
    const rows = await this.txHost.tx.studentGuardian.findMany({
      where: {
        schoolId,
        guardianId,
        endedAt: null,
        canLogin: true,
        guardian: { is: { mergedIntoId: null } },
      },
      select: {
        studentId: true,
        relationship: true,
        student: { select: { fullName: true, status: true } },
      },
      orderBy: [{ student: { fullName: 'asc' } }, { id: 'asc' }],
    });
    return rows.map(({ student, ...row }) => ({ ...row, ...student }));
  }

  /**
   * R232's own-child predicate: some guardian record in the merge family of the user's guardian
   * (asms_guardian_merge_family: merged_into_id followed both ways, at most five steps, defined
   * once in migration 20261006080000_slice18_review_fixes) has a live link to the student.
   * `can_login` does not matter: a parent is a parent whether or not they sign in. Every table
   * read is filtered on school_id (test/fees/isolation.e2e-spec.ts).
   */
  async userIsLiveGuardianOf(schoolId: SchoolId, userId: bigint, studentId: bigint): Promise<boolean> {
    const rows = await this.txHost.tx.$queryRaw<{ linked: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM users u
        CROSS JOIN LATERAL asms_guardian_merge_family(${schoolId}::bigint, u.guardian_id) AS fam(id)
        JOIN student_guardians sg
          ON sg.school_id = ${schoolId}::bigint AND sg.guardian_id = fam.id
        WHERE u.school_id = ${schoolId}::bigint
          AND u.id = ${userId}::bigint
          AND u.guardian_id IS NOT NULL
          AND sg.student_id = ${studentId}::bigint
          AND sg.ended_at IS NULL
      ) AS linked`;
    return rows[0]?.linked === true;
  }

  /** The guardian is the primary contact on some live link (R30: the phone must stay). */
  async isLivePrimaryContact(schoolId: SchoolId, guardianId: bigint): Promise<boolean> {
    const row = await this.txHost.tx.studentGuardian.findFirst({
      where: { schoolId, guardianId, isPrimaryContact: true, endedAt: null },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * The guardian's links with each student's name, by student name. Unscoped: GET
   * /guardians/:id/students is `guardian.manage`, school-wide (contract §9).
   */
  async listForGuardian(
    schoolId: SchoolId,
    guardianId: bigint,
    query: { includeEnded: boolean; skip: number; take: number },
  ): Promise<{ rows: GuardianStudentLink[]; total: number }> {
    const where = { schoolId, guardianId, ...live(query.includeEnded) };
    const rows = await this.txHost.tx.studentGuardian.findMany({
      where,
      select: SELECT,
      orderBy: [{ student: { fullName: 'asc' } }, { id: 'asc' }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.studentGuardian.count({ where });
    return { rows: await this.withStudents(schoolId, rows), total };
  }

  /** The live links of several guardians, with student names (guardian lookup). */
  async liveForGuardians(
    schoolId: SchoolId,
    guardianIds: readonly bigint[],
  ): Promise<GuardianStudentLink[]> {
    if (guardianIds.length === 0) return [];
    const rows = await this.txHost.tx.studentGuardian.findMany({
      where: { schoolId, guardianId: { in: [...guardianIds] }, endedAt: null },
      select: SELECT,
      orderBy: [{ student: { fullName: 'asc' } }, { id: 'asc' }],
    });
    return this.withStudents(schoolId, rows);
  }

  private async withStudents(
    schoolId: SchoolId,
    rows: GuardianLinkRecord[],
  ): Promise<GuardianStudentLink[]> {
    if (rows.length === 0) return [];
    const students = await this.txHost.tx.student.findMany({
      where: { schoolId, id: { in: [...new Set(rows.map((r) => r.studentId))] } },
      select: { id: true, fullName: true, admissionNo: true },
    });
    const byId = new Map(students.map((s) => [s.id, s]));
    return rows.flatMap((row) => {
      const student = byId.get(row.studentId);
      return student
        ? [{ ...row, studentFullName: student.fullName, admissionNo: student.admissionNo }]
        : [];
    });
  }
}
