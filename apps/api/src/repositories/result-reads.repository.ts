import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { ResultSheetStatus, ResultSubjectStatus, TestType } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { MarksScope, Scope } from '../tenancy/scope';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';
import { studentInScope } from './student.repository';
import { sheetScopeWhere } from './result-sheet.repository';

// contracts/slice-33.md (phase-4-academic.md slice 33, §0.29, §7.1): the read-only views of stored
// results for families, students, the student page and the result reports. It writes nothing.
// Families and students read only **published, live** rows (R274): `published_at` set and
// `superseded_at` null; the caller resolves the student (the guardian's live links, or the
// session's own student) before any method here runs. Class-test marks are `kind = test`, live
// rows, non-voided assessments (R286): never an exam mark, never a pending correction.

/** Published and not superseded (§0.29). */
const PUBLISHED_LIVE = { publishedAt: { not: null }, supersededAt: null } as const;

export interface ResultSummaryRecord {
  id: bigint;
  academicYearId: bigint;
  academicYearName: string;
  termId: bigint | null;
  termName: string | null;
  /** The term's rank in its year; null for the final result. */
  termSortOrder: number | null;
  className: string;
  sectionName: string;
  percentBp: number | null;
  grade: string | null;
  passed: boolean | null;
  position: number | null;
  positionOf: number | null;
  revised: boolean;
  publishedAt: Date;
}

export interface ResultYearRecord {
  id: bigint;
  name: string;
  startsOn: Date;
}

export interface TestMarkRecord {
  markId: bigint;
  assessmentId: bigint;
  name: string;
  testType: TestType | null;
  heldOn: Date;
  termId: bigint;
  termName: string;
  subjectName: string;
  maxMarks: number;
  obtained: number | null;
  absent: boolean;
  excused: boolean;
  enteredAt: Date;
}

/** A sheet as the section summary reads it. */
export interface ReportSheetRecord {
  id: bigint;
  status: ResultSheetStatus;
  version: number;
  termId: bigint | null;
  termName: string | null;
  academicYearId: bigint;
  classId: bigint;
  className: string;
  sectionId: bigint;
  sectionName: string;
  passPercent: number | null;
  publishedAt: Date | null;
}

export interface ReportSubjectRecord {
  classSubjectId: bigint;
  subjectName: string;
  sortOrder: number;
  percentBp: number | null;
  obtained: number | null;
  max: number;
  grade: string | null;
  status: ResultSubjectStatus;
}

export interface ReportRowRecord {
  id: bigint;
  studentId: bigint;
  percentBp: number | null;
  grade: string | null;
  passed: boolean | null;
  subjects: ReportSubjectRecord[];
}

/** One live stored subject figure of a term, for the subject report. */
export interface SubjectReportRecord {
  resultId: bigint;
  studentId: bigint;
  fullName: string;
  sectionId: bigint;
  sectionName: string;
  percentBp: number | null;
  status: ResultSubjectStatus;
  published: boolean;
}

const SUMMARY_SELECT = {
  id: true,
  academicYearId: true,
  termId: true,
  percentBp: true,
  grade: true,
  passed: true,
  position: true,
  positionOf: true,
  revised: true,
  publishedAt: true,
  // Same school by the composite foreign keys.
  term: { select: { name: true, sortOrder: true } },
  sheet: {
    select: {
      academicYear: { select: { name: true } },
      class: { select: { name: true } },
      section: { select: { name: true } },
    },
  },
} satisfies Prisma.ResultSelect;

type SummaryRow = Prisma.ResultGetPayload<{ select: typeof SUMMARY_SELECT }>;

const toSummary = (row: SummaryRow): ResultSummaryRecord => ({
  id: row.id,
  academicYearId: row.academicYearId,
  academicYearName: row.sheet.academicYear.name,
  termId: row.termId,
  termName: row.term?.name ?? null,
  termSortOrder: row.term?.sortOrder ?? null,
  className: row.sheet.class.name,
  sectionName: row.sheet.section.name,
  percentBp: row.percentBp,
  grade: row.grade,
  passed: row.passed,
  position: row.position,
  positionOf: row.positionOf,
  revised: row.revised,
  // PUBLISHED_LIVE guarantees it; a null here is a programming error.
  publishedAt: row.publishedAt ?? new Date(0),
});

@Injectable()
export class ResultReadsRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** The years in which the student has a published, live result, newest first. */
  async yearsWithResults(schoolId: SchoolId, studentId: bigint): Promise<ResultYearRecord[]> {
    const rows = await this.txHost.tx.result.findMany({
      where: { schoolId, studentId, ...PUBLISHED_LIVE },
      select: { academicYearId: true },
      distinct: ['academicYearId'],
    });
    if (rows.length === 0) return [];
    return this.txHost.tx.academicYear.findMany({
      where: { schoolId, id: { in: rows.map((r) => r.academicYearId) } },
      select: { id: true, name: true, startsOn: true },
      orderBy: [{ startsOn: 'desc' }, { id: 'desc' }],
    });
  }

  /** The student's published, live results of one year: terms by rank, the final last. */
  async summariesOfYear(
    schoolId: SchoolId,
    studentId: bigint,
    academicYearId: bigint,
  ): Promise<ResultSummaryRecord[]> {
    const rows = await this.txHost.tx.result.findMany({
      where: { schoolId, studentId, academicYearId, ...PUBLISHED_LIVE },
      select: SUMMARY_SELECT,
      orderBy: { id: 'asc' },
    });
    return rows.map(toSummary);
  }

  /** The result's id and year when it is the student's, published and live (R274, R285); else null. */
  async publishedLive(
    schoolId: SchoolId,
    studentId: bigint,
    resultId: bigint,
  ): Promise<{ id: bigint; academicYearId: bigint } | null> {
    return this.txHost.tx.result.findFirst({
      where: { schoolId, id: resultId, studentId, ...PUBLISHED_LIVE },
      select: { id: true, academicYearId: true },
    });
  }

  /**
   * The student's class-test marks (R286): live marks of non-voided tests, newest test first,
   * optionally of one term. Exams and pending corrections never. Bounded by the child (performance
   * review, slice 36): their live marks first (marks_school_id_student_id_academic_year_id_idx),
   * then only those marks' assessments — never a join over every assessment of the school — the
   * order and the page taken in memory, then the page's details.
   */
  async testMarks(
    schoolId: SchoolId,
    studentId: bigint,
    query: { termId?: bigint; skip: number; take: number },
  ): Promise<{ rows: TestMarkRecord[]; total: number }> {
    const live = await this.txHost.tx.mark.findMany({
      where: { schoolId, studentId, status: 'live' },
      select: { id: true, assessmentId: true },
    });
    const tests =
      live.length === 0
        ? []
        : await this.txHost.tx.assessment.findMany({
            where: {
              schoolId,
              id: { in: [...new Set(live.map((m) => m.assessmentId))] },
              kind: 'test',
              voidedAt: null,
              ...(query.termId === undefined ? {} : { termId: query.termId }),
            },
            select: { id: true, heldOn: true },
          });
    const heldOn = new Map(tests.map((t) => [t.id, t.heldOn.getTime()]));
    const ordered = live
      .filter((m) => heldOn.has(m.assessmentId))
      .sort(
        (a, b) =>
          heldOn.get(b.assessmentId)! - heldOn.get(a.assessmentId)! ||
          (a.assessmentId < b.assessmentId ? 1 : a.assessmentId > b.assessmentId ? -1 : 0),
      );
    const page = ordered.slice(query.skip, query.skip + query.take);
    const rows =
      page.length === 0
        ? []
        : await this.txHost.tx.mark.findMany({
            where: { schoolId, id: { in: page.map((m) => m.id) } },
            select: {
              id: true,
              obtained: true,
              absent: true,
              excused: true,
              enteredAt: true,
              assessment: {
                select: {
                  id: true,
                  name: true,
                  testType: true,
                  heldOn: true,
                  termId: true,
                  maxMarks: true,
                  term: { select: { name: true } },
                  classSubject: { select: { subject: { select: { name: true } } } },
                },
              },
            },
          });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return {
      total: ordered.length,
      rows: page.flatMap(({ id }) => {
        const found = byId.get(id);
        if (!found) return [];
        const { assessment: a, ...m } = found;
        return [
          {
            markId: m.id,
            assessmentId: a.id,
            name: a.name,
            testType: a.testType,
            heldOn: a.heldOn,
            termId: a.termId,
            termName: a.term.name,
            subjectName: a.classSubject.subject.name,
            maxMarks: a.maxMarks,
            obtained: m.obtained,
            absent: m.absent,
            excused: m.excused,
            enteredAt: m.enteredAt,
          },
        ];
      }),
    };
  }

  /** The student when the caller's student scope reaches them (the student page's reads). */
  async studentInScope(schoolId: SchoolId, scope: Scope, studentId: bigint): Promise<boolean> {
    const row = await this.txHost.tx.student.findFirst({
      where: { schoolId, id: studentId, AND: [studentInScope(scope)] },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * Every published, live result of the student across years, newest first (R288). `sheets` is
   * `any` for a school-wide reader, else the caller's sheet scope (a section-scoped teacher reads
   * only the cards of sheets they class-teach or cover, as GET /results/:id does).
   */
  async publishedIdsOfStudent(
    schoolId: SchoolId,
    studentId: bigint,
    sheets: MarksScope | 'any',
    page: { skip: number; take: number },
  ): Promise<{ ids: bigint[]; total: number }> {
    const scoped = sheets === 'any' ? {} : sheetScopeWhere(sheets);
    if (scoped === null) return { ids: [], total: 0 };
    const where = {
      schoolId,
      studentId,
      ...PUBLISHED_LIVE,
      ...(sheets === 'any' ? {} : { sheet: { is: scoped } }),
    } satisfies Prisma.ResultWhereInput;
    const rows = await this.txHost.tx.result.findMany({
      where,
      select: { id: true },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      skip: page.skip,
      take: page.take,
    });
    return { ids: rows.map((r) => r.id), total: await this.txHost.tx.result.count({ where }) };
  }

  /** The sheet the section summary reports on, or null. */
  async reportSheet(schoolId: SchoolId, sheetId: bigint): Promise<ReportSheetRecord | null> {
    const row = await this.txHost.tx.resultSheet.findFirst({
      where: { schoolId, id: sheetId },
      select: {
        id: true,
        status: true,
        version: true,
        termId: true,
        academicYearId: true,
        classId: true,
        sectionId: true,
        passPercent: true,
        publishedAt: true,
        term: { select: { name: true } },
        class: { select: { name: true } },
        section: { select: { name: true } },
      },
    });
    if (row === null) return null;
    const { term, class: klass, section, ...rest } = row;
    return { ...rest, termName: term?.name ?? null, className: klass.name, sectionName: section.name };
  }

  /**
   * The sheet version's stored rows (R287): the rows it was approved with — live ones, and those a
   * later correction's version replaced (a row naming them by supersedes_id; superseded_by stays
   * null, contracts/slice-32.md §9.1); never a set a return discarded.
   */
  async reportRows(schoolId: SchoolId, sheetId: bigint): Promise<ReportRowRecord[]> {
    return this.txHost.tx.result.findMany({
      where: {
        schoolId,
        sheetId,
        OR: [{ supersededAt: null }, { supersedesOf: { some: { schoolId } } }],
      },
      select: {
        id: true,
        studentId: true,
        percentBp: true,
        grade: true,
        passed: true,
        subjects: {
          select: {
            classSubjectId: true,
            subjectName: true,
            sortOrder: true,
            percentBp: true,
            obtained: true,
            max: true,
            grade: true,
            status: true,
          },
        },
      },
      orderBy: { id: 'asc' },
    });
  }

  /** The class-subject with its term's class, or null when either is not this school's. */
  async classSubjectOfTerm(
    schoolId: SchoolId,
    termId: bigint,
    classSubjectId: bigint,
  ): Promise<{ classId: bigint; className: string; subjectName: string; termName: string } | null> {
    const term = await this.txHost.tx.academicTerm.findFirst({
      where: { schoolId, id: termId },
      select: { name: true, academicYearId: true },
    });
    if (term === null) return null;
    const subject = await this.txHost.tx.classSubject.findFirst({
      where: { schoolId, id: classSubjectId, academicYearId: term.academicYearId },
      select: {
        classId: true,
        class: { select: { name: true } },
        subject: { select: { name: true } },
      },
    });
    if (subject === null) return null;
    return {
      classId: subject.classId,
      className: subject.class.name,
      subjectName: subject.subject.name,
      termName: term.name,
    };
  }

  /** The live stored figures of one class-subject in one term, across sections (R287). */
  async subjectRows(
    schoolId: SchoolId,
    termId: bigint,
    classSubjectId: bigint,
  ): Promise<SubjectReportRecord[]> {
    const rows = await this.txHost.tx.resultSubject.findMany({
      where: {
        schoolId,
        classSubjectId,
        result: { is: { termId, supersededAt: null } },
      },
      select: {
        percentBp: true,
        status: true,
        result: {
          select: {
            id: true,
            studentId: true,
            publishedAt: true,
            enrolment: { select: { student: { select: { fullName: true } } } },
            sheet: { select: { sectionId: true, section: { select: { name: true } } } },
          },
        },
      },
      orderBy: { resultId: 'asc' },
    });
    return rows.map(({ result: r, ...s }) => ({
      resultId: r.id,
      studentId: r.studentId,
      fullName: r.enrolment.student.fullName,
      sectionId: r.sheet.sectionId,
      sectionName: r.sheet.section.name,
      percentBp: s.percentBp,
      status: s.status,
      published: r.publishedAt !== null,
    }));
  }
}
