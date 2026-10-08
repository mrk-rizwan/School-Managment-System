import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { AssessmentKind } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { MarksScope } from '../tenancy/scope';
import type { PrismaTxAdapter } from './prisma';
import { sheetScopeReaches } from './result-sheet.repository';

// contracts/slice-31.md §4 (phase-4-academic.md §0.25, §2 "Boundary", §5.1): the results module's
// read-only view of enrolments, assessments and marks for composing a section's sheet. It writes
// nothing. Every method takes the caller's MarksScope and reads only for a section whose sheet the
// scope reaches (the class teacher or cover of the section, or school-wide); a student's marks are
// read across all their enrolments in the class (a mid-term section change keeps its marks, §0.25),
// never another class's (A14).

/** A student on the sheet: an enrolment of the section in force on the roster date. */
export interface SheetRosterRow {
  enrolmentId: bigint;
  studentId: bigint;
  fullName: string;
  admissionNo: string;
  rollNo: number | null;
}

/** An enrolment of a roster student in the sheet's class (any section): what applicability reads. */
export interface ClassEnrolmentRow {
  enrolmentId: bigint;
  studentId: bigint;
  sectionId: bigint;
  /** UTC midnight of the calendar dates. */
  startedOn: Date;
  endedOn: Date | null;
}

export interface LiveMarkRow {
  id: bigint;
  studentId: bigint;
  enrolmentId: bigint;
  obtained: number | null;
  absent: boolean;
  excused: boolean;
  enteredBy: bigint;
}

/** A non-voided assessment of the class and term, with the roster students' live marks. */
export interface TermAssessmentRow {
  id: bigint;
  sectionId: bigint;
  classSubjectId: bigint;
  kind: AssessmentKind;
  maxMarks: number;
  heldOn: Date;
  marks: LiveMarkRow[];
}

@Injectable()
export class MarkReadsRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /**
   * One statement: every enrolment in the class of each student who has an enrolment of the
   * section in force on `on` (§0.25, A9: a student who left before `on` is not on the sheet).
   * The roster is those in-force section enrolments, by roll number then name.
   */
  async enrolmentsForSheet(
    schoolId: SchoolId,
    scope: MarksScope,
    sheet: { classId: bigint; sectionId: bigint; on: Date },
  ): Promise<{ roster: SheetRosterRow[]; classEnrolments: ClassEnrolmentRow[] }> {
    if (!sheetScopeReaches(scope, sheet.sectionId)) return { roster: [], classEnrolments: [] };
    const rows = await this.txHost.tx.enrolment.findMany({
      where: {
        schoolId,
        classId: sheet.classId,
        student: {
          is: {
            enrolments: {
              some: {
                schoolId,
                sectionId: sheet.sectionId,
                startedOn: { lte: sheet.on },
                OR: [{ endedOn: null }, { endedOn: { gte: sheet.on } }],
              },
            },
          },
        },
      },
      select: {
        id: true,
        studentId: true,
        sectionId: true,
        startedOn: true,
        endedOn: true,
        rollNo: true,
        // Same school by the composite foreign key (school_id, student_id).
        student: { select: { fullName: true, admissionNo: true } },
      },
      orderBy: { id: 'asc' },
    });
    const inForce = (row: (typeof rows)[number]) =>
      row.sectionId === sheet.sectionId &&
      row.startedOn <= sheet.on &&
      (row.endedOn === null || row.endedOn >= sheet.on);
    const seen = new Set<bigint>();
    const roster: SheetRosterRow[] = [];
    for (const row of rows) {
      if (!inForce(row) || seen.has(row.studentId)) continue;
      seen.add(row.studentId);
      roster.push({
        enrolmentId: row.id,
        studentId: row.studentId,
        fullName: row.student.fullName,
        admissionNo: row.student.admissionNo,
        rollNo: row.rollNo,
      });
    }
    roster.sort(
      (a, b) =>
        (a.rollNo ?? Number.MAX_SAFE_INTEGER) - (b.rollNo ?? Number.MAX_SAFE_INTEGER) ||
        a.fullName.localeCompare(b.fullName) ||
        (a.enrolmentId < b.enrolmentId ? -1 : 1),
    );
    return {
      roster,
      classEnrolments: rows.map((row) => ({
        enrolmentId: row.id,
        studentId: row.studentId,
        sectionId: row.sectionId,
        startedOn: row.startedOn,
        endedOn: row.endedOn,
      })),
    };
  }

  /**
   * The names and roll numbers behind stored results (an approved sheet's detail): the given
   * enrolments of the section, whatever their status now.
   */
  async enrolmentNames(
    schoolId: SchoolId,
    scope: MarksScope,
    sectionId: bigint,
    enrolmentIds: readonly bigint[],
  ): Promise<Map<bigint, Pick<SheetRosterRow, 'fullName' | 'admissionNo' | 'rollNo'>>> {
    if (!sheetScopeReaches(scope, sectionId) || enrolmentIds.length === 0) return new Map();
    const rows = await this.txHost.tx.enrolment.findMany({
      where: { schoolId, sectionId, id: { in: [...enrolmentIds] } },
      select: {
        id: true,
        rollNo: true,
        student: { select: { fullName: true, admissionNo: true } },
      },
    });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          fullName: row.student.fullName,
          admissionNo: row.student.admissionNo,
          rollNo: row.rollNo,
        },
      ]),
    );
  }

  /**
   * One call: the class's non-voided assessments of the term (every section's, so a student who
   * moved section brings their marks, §0.25), each with the live marks of `studentIds`.
   */
  async termAssessmentsWithMarks(
    schoolId: SchoolId,
    scope: MarksScope,
    query: { classId: bigint; sectionId: bigint; termId: bigint; studentIds: readonly bigint[] },
  ): Promise<TermAssessmentRow[]> {
    if (!sheetScopeReaches(scope, query.sectionId)) return [];
    const rows = await this.txHost.tx.assessment.findMany({
      where: { schoolId, classId: query.classId, termId: query.termId, voidedAt: null },
      select: {
        id: true,
        sectionId: true,
        classSubjectId: true,
        kind: true,
        maxMarks: true,
        heldOn: true,
        marksOfYear: {
          where: { schoolId, status: 'live', studentId: { in: [...query.studentIds] } },
          select: {
            id: true,
            studentId: true,
            enrolmentId: true,
            obtained: true,
            absent: true,
            excused: true,
            enteredBy: true,
          },
          orderBy: { id: 'asc' },
        },
      },
      orderBy: [{ heldOn: 'asc' }, { id: 'asc' }],
    });
    return rows.map(({ marksOfYear, ...row }) => ({ ...row, marks: marksOfYear }));
  }
}
