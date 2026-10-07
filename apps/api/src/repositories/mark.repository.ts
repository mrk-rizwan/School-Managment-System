import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { MarksScope } from '../tenancy/scope';
import { assessmentScopeWhere, scopeReaches, type AssessmentRecord } from './assessment.repository';
import type { AssessmentMarkStatus, Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

// contracts/slice-30.md §3 (phase-4-academic.md §0.25, §3.2, R261, R262). The tenant table marks:
// a fact about a student on an assessment, never edited — a changed mark, an excusal and (slice
// 32) a correction are new rows superseding the old one. Every method takes the MarksScope and
// applies it through the mark's assessment (a relation predicate), or checks the assessment it is
// handed against it before writing; outside the scope nothing is read or written.

export interface MarkRecord {
  id: bigint;
  assessmentId: bigint;
  enrolmentId: bigint;
  studentId: bigint;
  academicYearId: bigint;
  maxMarks: number;
  obtained: number | null;
  absent: boolean;
  excused: boolean;
  status: AssessmentMarkStatus;
  supersedesId: bigint | null;
  correctionReason: string | null;
  enteredBy: bigint;
  enteredAt: Date;
  clientEntryKey: string | null;
  supersededAt: Date | null;
}

const SELECT = {
  id: true,
  assessmentId: true,
  enrolmentId: true,
  studentId: true,
  academicYearId: true,
  maxMarks: true,
  obtained: true,
  absent: true,
  excused: true,
  status: true,
  supersedesId: true,
  correctionReason: true,
  enteredBy: true,
  enteredAt: true,
  clientEntryKey: true,
  supersededAt: true,
} satisfies Prisma.MarkSelect;

/** A student on an assessment's grid: an enrolment of its section in force on held_on. */
export interface RosterRow {
  enrolmentId: bigint;
  studentId: bigint;
  fullName: string;
  admissionNo: string;
  rollNo: number | null;
}

/** The assessment a write is for: its section and subject are checked against the scope. */
type Target = Pick<
  AssessmentRecord,
  'id' | 'sectionId' | 'subjectId' | 'academicYearId' | 'maxMarks'
>;

export interface NewMark {
  enrolmentId: bigint;
  studentId: bigint;
  obtained: number | null;
  absent: boolean;
  excused: boolean;
  supersedesId: bigint | null;
  correctionReason: string | null;
  enteredBy: bigint;
  clientEntryKey: string | null;
}

/** Thrown when a write method is handed an assessment its scope does not reach: a service bug. */
export class MarksScopeViolation extends Error {
  override readonly name = 'MarksScopeViolation';
}

@Injectable()
export class MarkRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /**
   * The mark's assessment's held_on and nothing else: the date the caller's MarksScope is minted
   * for. Every answer is then read through a scoped method.
   */
  async scopeDateOf(schoolId: SchoolId, markId: bigint): Promise<Date | null> {
    const mark = await this.txHost.tx.mark.findFirst({
      where: { schoolId, id: markId },
      select: { assessment: { select: { heldOn: true } } },
    });
    return mark?.assessment.heldOn ?? null;
  }

  /** The mark if `scope` reads its assessment, else null. */
  async find(schoolId: SchoolId, scope: MarksScope, markId: bigint): Promise<MarkRecord | null> {
    const scoped = assessmentScopeWhere(scope, 'read');
    if (scoped === null) return null;
    return this.txHost.tx.mark.findFirst({
      where: { schoolId, id: markId, assessment: { is: scoped } },
      select: SELECT,
    });
  }

  /**
   * The grid's rows (§3.1): the section's enrolments in force on held_on (a joiner after it is not
   * listed), by roll number then name; empty when `scope` does not read the assessment.
   */
  async roster(
    schoolId: SchoolId,
    scope: MarksScope,
    assessment: Pick<AssessmentRecord, 'sectionId' | 'subjectId' | 'heldOn'>,
  ): Promise<RosterRow[]> {
    if (!scopeReaches(scope, 'read', assessment.sectionId, assessment.subjectId)) return [];
    const rows = await this.txHost.tx.enrolment.findMany({
      where: {
        schoolId,
        sectionId: assessment.sectionId,
        startedOn: { lte: assessment.heldOn },
        OR: [{ endedOn: null }, { endedOn: { gte: assessment.heldOn } }],
      },
      select: {
        id: true,
        studentId: true,
        rollNo: true,
        // Same school by the composite foreign key (school_id, student_id).
        student: { select: { fullName: true, admissionNo: true } },
      },
    });
    return rows
      .map((row) => ({
        enrolmentId: row.id,
        studentId: row.studentId,
        fullName: row.student.fullName,
        admissionNo: row.student.admissionNo,
        rollNo: row.rollNo,
      }))
      .sort(
        (a, b) =>
          (a.rollNo ?? Number.MAX_SAFE_INTEGER) - (b.rollNo ?? Number.MAX_SAFE_INTEGER) ||
          a.fullName.localeCompare(b.fullName) ||
          (a.enrolmentId < b.enrolmentId ? -1 : 1),
      );
  }

  /** The live marks of an assessment `scope` reads, by enrolment (`marks_live_key`: one each). */
  async liveForAssessment(
    schoolId: SchoolId,
    scope: MarksScope,
    assessmentId: bigint,
  ): Promise<MarkRecord[]> {
    const scoped = assessmentScopeWhere(scope, 'read');
    if (scoped === null) return [];
    return this.txHost.tx.mark.findMany({
      where: { schoolId, assessmentId, status: 'live', assessment: { is: scoped } },
      select: SELECT,
      orderBy: { id: 'asc' },
    });
  }

  /** Whether the assessment has any mark of any status (the edit guard's own test, assessments_has_marks). */
  async anyFor(schoolId: SchoolId, scope: MarksScope, assessmentId: bigint): Promise<boolean> {
    const scoped = assessmentScopeWhere(scope, 'read');
    if (scoped === null) return false;
    const row = await this.txHost.tx.mark.findFirst({
      where: { schoolId, assessmentId, assessment: { is: scoped } },
      select: { id: true },
    });
    return row !== null;
  }

  /** The rows a phone's keys already wrote on this assessment (R262: a resend finds them). */
  async findByEntryKeys(
    schoolId: SchoolId,
    scope: MarksScope<'write'>,
    assessmentId: bigint,
    keys: readonly string[],
  ): Promise<MarkRecord[]> {
    const scoped = assessmentScopeWhere(scope, 'write');
    if (scoped === null || keys.length === 0) return [];
    return this.txHost.tx.mark.findMany({
      where: {
        schoolId,
        assessmentId,
        clientEntryKey: { in: [...keys] },
        assessment: { is: scoped },
      },
      select: SELECT,
    });
  }

  /** Live marks per assessment for a page of assessments `scope` reads (the list's count). */
  async liveCounts(
    schoolId: SchoolId,
    scope: MarksScope,
    assessmentIds: readonly bigint[],
  ): Promise<Map<bigint, number>> {
    const scoped = assessmentScopeWhere(scope, 'read');
    if (scoped === null || assessmentIds.length === 0) return new Map();
    const rows = await this.txHost.tx.mark.groupBy({
      by: ['assessmentId'],
      where: {
        schoolId,
        assessmentId: { in: [...assessmentIds] },
        status: 'live',
        assessment: { is: scoped },
      },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.assessmentId, row._count._all]));
  }

  /**
   * Of `studentIds`, those `guardianId` holds a live link to (the grid's own-child flag). Display
   * only: a refusal reads the merge-resolved PermissionsService.actorIsGuardianOf.
   */
  async childrenAmong(
    schoolId: SchoolId,
    guardianId: bigint,
    studentIds: readonly bigint[],
  ): Promise<Set<bigint>> {
    if (studentIds.length === 0) return new Set();
    const rows = await this.txHost.tx.studentGuardian.findMany({
      where: { schoolId, guardianId, endedAt: null, studentId: { in: [...studentIds] } },
      select: { studentId: true },
    });
    return new Set(rows.map((row) => row.studentId));
  }

  /**
   * `test_marked`'s recipients per student (R266): the guardians on a live link (not merged
   * away), and the student's own login when student logins are on and that login is active.
   * Reads no mark: the students are those the caller just marked inside its scope.
   */
  async testMarkedRecipients(
    schoolId: SchoolId,
    studentIds: readonly bigint[],
    studentLoginEnabled: boolean,
  ): Promise<Map<bigint, { guardianIds: bigint[]; student: boolean }>> {
    const result = new Map<bigint, { guardianIds: bigint[]; student: boolean }>(
      studentIds.map((id) => [id, { guardianIds: [], student: false }]),
    );
    if (studentIds.length === 0) return result;
    const links = await this.txHost.tx.studentGuardian.findMany({
      where: {
        schoolId,
        endedAt: null,
        studentId: { in: [...studentIds] },
        guardian: { is: { mergedIntoId: null } },
      },
      select: { studentId: true, guardianId: true },
      orderBy: [{ studentId: 'asc' }, { guardianId: 'asc' }],
    });
    for (const link of links) result.get(link.studentId)?.guardianIds.push(link.guardianId);
    if (studentLoginEnabled) {
      const logins = await this.txHost.tx.student.findMany({
        where: {
          schoolId,
          id: { in: [...studentIds] },
          status: 'active',
          user: { is: { status: 'active' } },
        },
        select: { id: true },
      });
      for (const login of logins) {
        const entry = result.get(login.id);
        if (entry) entry.student = true;
      }
    }
    return result;
  }

  /**
   * Marks a live row superseded, under the assessment's row lock. Call before inserting the row
   * that replaces it (marks_live_key holds one live row per enrolment). False when it was no
   * longer live.
   */
  async supersede(
    schoolId: SchoolId,
    scope: MarksScope<'write'>,
    target: Target,
    markId: bigint,
  ): Promise<boolean> {
    this.assertWrites(scope, target);
    const { count } = await this.txHost.tx.mark.updateMany({
      where: { schoolId, id: markId, assessmentId: target.id, status: 'live' },
      data: { status: 'superseded', supersededAt: new Date() },
    });
    return count === 1;
  }

  /**
   * A live row on `target`, under its row lock. max_marks is copied from the assessment
   * (marks_assessment_max_fkey); `obtained` above it fails on marks_obtained_check.
   */
  async insertLive(
    schoolId: SchoolId,
    scope: MarksScope<'write'>,
    target: Target,
    mark: NewMark,
  ): Promise<MarkRecord> {
    this.assertWrites(scope, target);
    return this.txHost.tx.mark.create({
      data: {
        schoolId,
        assessmentId: target.id,
        academicYearId: target.academicYearId,
        maxMarks: target.maxMarks,
        status: 'live',
        ...mark,
      },
      select: SELECT,
    });
  }

  private assertWrites(scope: MarksScope<'write'>, target: Target): void {
    if (!scopeReaches(scope, 'write', target.sectionId, target.subjectId)) {
      throw new MarksScopeViolation("a mark write outside the caller's marks scope");
    }
  }
}
