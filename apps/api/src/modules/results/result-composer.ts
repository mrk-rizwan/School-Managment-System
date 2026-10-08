import { Injectable } from '@nestjs/common';
import {
  composeFinal,
  composeResult,
  composeSubject,
  positions,
  type FinalTermInput,
  type GradeBand,
  type KeyedSubject,
  type PassRule,
  type TestMarkInput,
} from '@asms/shared';
import { SchoolSettingsReader } from '../../common/school-settings-reader';
import type { AcademicTermRecord } from '../../repositories/academic-term.repository';
import { AttendanceReportRepository } from '../../repositories/attendance-report.repository';
import {
  ClassSubjectRepository,
  type ClassSubjectRecord,
} from '../../repositories/class-subject.repository';
import {
  MarkReadsRepository,
  type ClassEnrolmentRow,
  type LiveMarkRow,
  type SheetRosterRow,
  type TermAssessmentRow,
} from '../../repositories/mark-reads.repository';
import type {
  RemarkRecord,
  ResultSheetRecord,
  TermWeight,
} from '../../repositories/result-sheet.repository';
import {
  ResultRepository,
  type NewResult,
  type OwnChildFlag,
  type OwnChildRole,
  type ResultRecord,
  type ResultSubjectRecord,
} from '../../repositories/result.repository';
import { StudentGuardianRepository } from '../../repositories/student-guardian.repository';
import type { SchoolId } from '../../tenancy/school-id';
import type { MarksScope } from '../../tenancy/scope';

// contracts/slice-31.md §4 (phase-4-academic.md §0.25, §0.26, §1.1, §3.3, A6, A9, A14): one sheet's
// composition, the same code for the draft's preview and the approval's stored rows. The figures
// come only from the shared pure functions (@asms/shared results); this file gathers their inputs
// in four reads — the enrolments, the term's assessments with the live marks, one attendance
// aggregate and the own-child set — and never writes.

/** The composition rules of a sheet: the year's live settings for a preview, the snapshot at approval. */
export interface CompositionSettings {
  testWeight: number;
  examWeight: number;
  passPercent: number;
  passRule: PassRule;
  bands: readonly GradeBand[];
}

export interface ComposedRow {
  enrolmentId: bigint;
  studentId: bigint;
  fullName: string;
  admissionNo: string;
  rollNo: number | null;
  totalObtained: number;
  totalMax: number;
  percentBp: number | null;
  grade: string | null;
  passed: boolean | null;
  failedSubjects: number;
  position: number | null;
  positionOf: number | null;
  attendanceBp: number | null;
  remark: string | null;
  ownChildFlags: OwnChildFlag[];
  subjects: ResultSubjectRecord[];
}

/** A student with no live mark on an assessment that applies to them (R268). */
export interface Gap {
  enrolmentId: bigint;
  studentId: bigint;
  assessmentId: bigint;
}

export interface SubjectHeader {
  classSubjectId: bigint;
  subjectName: string;
  sortOrder: number;
}

export interface Composition {
  rows: ComposedRow[];
  subjects: SubjectHeader[];
  gaps: Gap[];
  /** Class-subjects with no live exam for the sheet's section (EXAM_NOT_SET_UP). */
  examsNotSetUp: bigint[];
  /**
   * A term sheet's: the class-term's live tests the sheet holds — the section's own, and any
   * other section's carrying a live mark of a roster student (a moved student's, §0.25). What a
   * submission locks (contracts/slice-31.md §2.4).
   */
  heldTestIds?: bigint[];
}

export interface Contributors {
  remarks: readonly RemarkRecord[];
  submittedBy: bigint | null;
  /** The approver at approval; the reader in a preview, so the inbox shows the flag they would carry. */
  approver: bigint | null;
}

const ROLE_ORDER: Record<OwnChildRole, number> = {
  mark_author: 0,
  remark_author: 1,
  submitter: 2,
  approver: 3,
};

/** Percent with one decimal (92.3) → basis points (9230); null stays null. */
export const attendanceBpOf = (percentage: number | null): number | null =>
  percentage === null ? null : Math.round(percentage * 100);

/** In force on a date: started on or before it, not ended before it. */
const inForceOn = (e: Pick<ClassEnrolmentRow, 'startedOn' | 'endedOn'>, on: Date): boolean =>
  e.startedOn <= on && (e.endedOn === null || e.endedOn >= on);

@Injectable()
export class ResultComposer {
  constructor(
    private readonly reads: MarkReadsRepository,
    private readonly classSubjects: ClassSubjectRepository,
    private readonly results: ResultRepository,
    private readonly attendance: AttendanceReportRepository,
    private readonly attendanceSettings: SchoolSettingsReader,
    private readonly guardians: StudentGuardianRepository,
  ) {}

  /**
   * A term sheet (R268-R270, R276, R277): the section's enrolments in force on the term's last
   * day; each student's live marks across their enrolments in the class for the term's
   * assessments; composeSubject per class-subject, composeResult, positions; the term's
   * attendance; the own-child flags recomputed from the live contributors.
   */
  async term(
    schoolId: SchoolId,
    scope: MarksScope,
    sheet: Pick<ResultSheetRecord, 'classId' | 'sectionId'>,
    term: Pick<AcademicTermRecord, 'id' | 'startsOn' | 'endsOn'>,
    settings: CompositionSettings,
    contributors: Contributors,
    options: { attendance: boolean; subjects?: readonly SubjectHeader[] } = { attendance: true },
  ): Promise<Composition> {
    // A correction re-composes over the subjects its version was approved with (slice 32 fix
    // round), whatever today's list holds; otherwise the class's live list.
    const listed = options.subjects
      ? await this.storedSubjects(schoolId, sheet.classId, options.subjects)
      : await this.classSubjects.liveForClass(schoolId, sheet.classId);
    const subjects = [...listed].sort(
      (a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1),
    );
    // Read 1: the enrolments.
    const { roster, classEnrolments } = await this.reads.enrolmentsForSheet(schoolId, scope, {
      classId: sheet.classId,
      sectionId: sheet.sectionId,
      on: term.endsOn,
    });
    // Read 2: the assessments with the roster's live marks.
    const assessments = await this.reads.termAssessmentsWithMarks(schoolId, scope, {
      classId: sheet.classId,
      sectionId: sheet.sectionId,
      termId: term.id,
      studentIds: roster.map((r) => r.studentId),
    });
    // Read 3: attendance over the term's dates.
    const attendance = options.attendance
      ? await this.attendanceOf(schoolId, roster, term.startsOn, term.endsOn)
      : new Map<bigint, number | null>();

    const enrolmentsOf = groupBy(classEnrolments, (e) => e.studentId);
    const markOf = new Map<string, LiveMarkRow>();
    for (const a of assessments) for (const m of a.marks) markOf.set(`${a.id}|${m.studentId}`, m);

    const gaps: Gap[] = [];
    const authorsOf = new Map<bigint, Map<bigint, bigint[]>>();
    const composed = roster.map((student) => {
      const enrolments = enrolmentsOf.get(student.studentId) ?? [];
      const applicable = (a: TermAssessmentRow): ClassEnrolmentRow | undefined =>
        enrolments.find((e) => e.sectionId === a.sectionId && inForceOn(e, a.heldOn));
      const subjectAuthors = new Map<bigint, bigint[]>();
      authorsOf.set(student.studentId, subjectAuthors);
      const figures = subjects.map((cs) => {
        const own = assessments.filter((a) => a.classSubjectId === cs.id);
        const tests: TestMarkInput[] = [];
        const authors: bigint[] = [];
        for (const a of own.filter((x) => x.kind === 'test')) {
          const mark = markOf.get(`${a.id}|${student.studentId}`);
          const enrolment = applicable(a);
          if (!mark) {
            if (enrolment)
              gaps.push({
                enrolmentId: enrolment.enrolmentId,
                studentId: student.studentId,
                assessmentId: a.id,
              });
            continue;
          }
          authors.push(mark.enteredBy);
          tests.push({
            obtained: mark.obtained,
            max: a.maxMarks,
            absent: mark.absent,
            excused: mark.excused,
            applicable: true,
          });
        }
        const exams = own.filter(
          (x) => x.kind === 'exam' && (applicable(x) || markOf.has(`${x.id}|${student.studentId}`)),
        );
        const exam = exams.find((x) => markOf.has(`${x.id}|${student.studentId}`)) ?? exams[0];
        const examMark = exam ? markOf.get(`${exam.id}|${student.studentId}`) : undefined;
        if (exam && !examMark) {
          const enrolment = applicable(exam);
          if (enrolment)
            gaps.push({
              enrolmentId: enrolment.enrolmentId,
              studentId: student.studentId,
              assessmentId: exam.id,
            });
        }
        if (examMark) authors.push(examMark.enteredBy);
        subjectAuthors.set(cs.id, authors);
        const result = composeSubject({
          tests,
          exam: examMark
            ? {
                obtained: examMark.obtained,
                max: exam!.maxMarks,
                absent: examMark.absent,
                excused: examMark.excused,
              }
            : null,
          weights: { test: settings.testWeight, exam: settings.examWeight },
          max: exam?.maxMarks ?? cs.examMaxMarks,
        });
        return { cs, result, exam: exam ?? null, examMark: examMark ?? null };
      });
      return { student, figures };
    });

    // Read 4: the own-child set — the contributors who are a guardian of a student on the sheet.
    const flags = await this.ownChildFlags(schoolId, roster, contributors, (studentId) =>
      [...(authorsOf.get(studentId)?.values() ?? [])].flat(),
    );

    const rows: ComposedRow[] = composed.map(({ student, figures }) => {
      const overall = composeResult({
        subjects: figures.map(({ cs, result }) => ({ key: cs.id.toString(), ...result })),
        bands: settings.bands,
        passRule: settings.passRule,
        passPercent: settings.passPercent,
      });
      const guardianOf = flags.guardiansOf.get(student.studentId) ?? new Set<bigint>();
      return {
        ...rowBase(student, contributors.remarks),
        totalObtained: overall.totalObtained,
        totalMax: overall.totalMax,
        percentBp: overall.percentBp,
        grade: overall.grade,
        passed: overall.passed,
        failedSubjects: overall.failedSubjects.length,
        attendanceBp: attendance.get(student.studentId) ?? null,
        ownChildFlags: flags.rows.get(student.studentId) ?? [],
        subjects: figures.map(({ cs, result, exam, examMark }, i) => ({
          classSubjectId: cs.id,
          subjectName: cs.subjectName,
          sortOrder: cs.sortOrder,
          testBp: result.testBp,
          examBp: result.examBp,
          examObtained: examMark?.obtained ?? null,
          examMax: examMark ? exam!.maxMarks : null,
          examAbsent: examMark?.absent ?? false,
          examExcused: examMark?.excused ?? false,
          percentBp: result.percentBp,
          obtained: result.obtained,
          max: result.max,
          grade: overall.subjects[i]?.grade ?? null,
          status: result.status,
          ownChildOf:
            (authorsOf.get(student.studentId)?.get(cs.id) ?? []).find((userId) =>
              guardianOf.has(userId),
            ) ?? null,
        })),
      };
    });
    return {
      rows: ranked(rows),
      subjects: subjects.map(header),
      gaps,
      heldTestIds: assessments
        .filter((a) => a.kind === 'test' && (a.sectionId === sheet.sectionId || a.marks.length > 0))
        .map((a) => a.id),
      examsNotSetUp: subjects
        .filter(
          (cs) =>
            !assessments.some(
              (a) =>
                a.kind === 'exam' && a.classSubjectId === cs.id && a.sectionId === sheet.sectionId,
            ),
        )
        .map((cs) => cs.id),
    };
  }

  /** The class-subjects named, archived or not, with the stored names and print order. */
  private async storedSubjects(
    schoolId: SchoolId,
    classId: bigint,
    headers: readonly SubjectHeader[],
  ): Promise<ClassSubjectRecord[]> {
    const ids = headers.map((h) => h.classSubjectId);
    const records = new Map(
      (await this.classSubjects.forClassByIds(schoolId, classId, ids)).map((r) => [r.id, r]),
    );
    return headers.flatMap((h) => {
      const record = records.get(h.classSubjectId);
      return record ? [{ ...record, subjectName: h.subjectName, sortOrder: h.sortOrder }] : [];
    });
  }

  /**
   * The final sheet (R275, A6): per student, composeFinal over their published, live term results
   * in the class and year, held terms only, weights renormalised per subject; the year's
   * attendance; the flags of the remark author and the approver, plus those the term results
   * carry.
   */
  async final(
    schoolId: SchoolId,
    scope: MarksScope,
    sheet: Pick<ResultSheetRecord, 'classId' | 'sectionId' | 'academicYearId'>,
    terms: readonly Pick<AcademicTermRecord, 'id' | 'endsOn'>[],
    termWeights: readonly TermWeight[],
    year: { startsOn: Date; endsOn: Date },
    settings: Pick<CompositionSettings, 'passPercent' | 'passRule' | 'bands'>,
    contributors: Contributors,
  ): Promise<Composition> {
    const held = termWeights.filter((t) => t.held);
    const lastHeld =
      terms.filter((t) => held.some((h) => h.termId === t.id)).at(-1) ?? terms.at(-1);
    if (!lastHeld) return { rows: [], subjects: [], gaps: [], examsNotSetUp: [] };
    const { roster } = await this.reads.enrolmentsForSheet(schoolId, scope, {
      classId: sheet.classId,
      sectionId: sheet.sectionId,
      on: lastHeld.endsOn,
    });
    const termResults = await this.results.publishedTermResults(schoolId, {
      academicYearId: sheet.academicYearId,
      classId: sheet.classId,
      studentIds: roster.map((r) => r.studentId),
    });
    const attendance = await this.attendanceOf(schoolId, roster, year.startsOn, year.endsOn);
    const resultsOf = groupBy(termResults, (r) => r.studentId);
    const inherited = (studentId: bigint) =>
      (resultsOf.get(studentId) ?? []).flatMap((r) => r.ownChildFlags);
    const flags = await this.ownChildFlags(schoolId, roster, contributors, () => [], inherited);

    // Names and print order: the latest term snapshot of each class-subject.
    const order = new Map(termWeights.map((t, i) => [t.termId, i]));
    const byTerm = [...termResults].sort(
      (a, b) => (order.get(a.termId ?? 0n) ?? 0) - (order.get(b.termId ?? 0n) ?? 0),
    );
    const subjectHeaders = subjectHeadersOf(byTerm);
    const headers = new Map(subjectHeaders.map((h) => [h.classSubjectId.toString(), h]));

    const rows: ComposedRow[] = roster.map((student) => {
      const mine = resultsOf.get(student.studentId) ?? [];
      const input: FinalTermInput[] = termWeights.map((t) => {
        const result = mine.find((r) => r.termId === t.termId);
        return {
          weight: t.weight,
          held: t.held,
          subjects: (result?.subjects ?? []).map((s) => ({
            key: s.classSubjectId.toString(),
            percentBp: s.percentBp,
            max: s.max,
          })),
        };
      });
      const figures = composeFinal({
        terms: input,
        bands: settings.bands,
        passRule: settings.passRule,
        passPercent: settings.passPercent,
      });
      const ordered = sortSubjects(figures.subjectFigures, headers);
      return {
        ...rowBase(student, contributors.remarks),
        totalObtained: figures.totalObtained,
        totalMax: figures.totalMax,
        percentBp: figures.percentBp,
        grade: figures.grade,
        passed: figures.passed,
        failedSubjects: figures.failedSubjects.length,
        attendanceBp: attendance.get(student.studentId) ?? null,
        ownChildFlags: flags.rows.get(student.studentId) ?? [],
        subjects: ordered.map((s) => ({
          classSubjectId: BigInt(s.key),
          subjectName: headers.get(s.key)?.subjectName ?? '',
          sortOrder: headers.get(s.key)?.sortOrder ?? 0,
          testBp: null,
          examBp: null,
          examObtained: null,
          examMax: null,
          examAbsent: false,
          examExcused: false,
          percentBp: s.percentBp,
          obtained: s.obtained,
          max: s.max,
          grade: figures.subjects.find((x) => x.key === s.key)?.grade ?? null,
          status: s.status,
          ownChildOf: null,
        })),
      };
    });
    return { rows: ranked(rows), subjects: subjectHeaders, gaps: [], examsNotSetUp: [] };
  }

  /** One aggregate over the range for the roster (R277), as basis points. */
  private async attendanceOf(
    schoolId: SchoolId,
    roster: readonly SheetRosterRow[],
    from: Date,
    to: Date,
  ): Promise<Map<bigint, number | null>> {
    if (roster.length === 0) return new Map();
    const settings = await this.attendanceSettings.read(schoolId);
    const percentages = await this.attendance.percentageForStudents(schoolId, {
      studentIds: roster.map((r) => r.studentId),
      from,
      to,
      weeklyOffDays: settings.weeklyOffDays,
      settings: settings.value,
    });
    return new Map(
      [...percentages].map(([studentId, percentage]) => [studentId, attendanceBpOf(percentage)]),
    );
  }

  /**
   * §0.28, R276: for each student, the contributors who are a guardian of them (merge-resolved,
   * live link) with their roles — every mark author, the remark's writer, the submitter and the
   * approver — recomputed from live rows, never copied (a final sheet also carries its term
   * results' flags). One statement.
   */
  private async ownChildFlags(
    schoolId: SchoolId,
    roster: readonly SheetRosterRow[],
    contributors: Contributors,
    markAuthors: (studentId: bigint) => bigint[],
    inherited: (studentId: bigint) => OwnChildFlag[] = () => [],
  ): Promise<{ rows: Map<bigint, OwnChildFlag[]>; guardiansOf: Map<bigint, Set<bigint>> }> {
    const remarkBy = new Map(contributors.remarks.map((r) => [r.enrolmentId, r]));
    const candidates = new Set<bigint>();
    for (const student of roster)
      for (const userId of markAuthors(student.studentId)) candidates.add(userId);
    for (const remark of contributors.remarks)
      if (remark.remark !== null) candidates.add(remark.writtenBy);
    if (contributors.submittedBy !== null) candidates.add(contributors.submittedBy);
    if (contributors.approver !== null) candidates.add(contributors.approver);
    const pairs = await this.guardians.guardianPairs(
      schoolId,
      [...candidates],
      roster.map((r) => r.studentId),
    );
    const guardiansOf = new Map<bigint, Set<bigint>>();
    for (const { userId, studentId } of pairs) {
      const set = guardiansOf.get(studentId) ?? new Set<bigint>();
      set.add(userId);
      guardiansOf.set(studentId, set);
    }
    const rows = new Map<bigint, OwnChildFlag[]>();
    for (const student of roster) {
      const guardian = guardiansOf.get(student.studentId) ?? new Set<bigint>();
      const flags: OwnChildFlag[] = [];
      const add = (userId: bigint | null, role: OwnChildRole) => {
        if (userId === null || !guardian.has(userId)) return;
        if (!flags.some((f) => f.userId === userId && f.role === role))
          flags.push({ userId, role });
      };
      for (const userId of markAuthors(student.studentId)) add(userId, 'mark_author');
      const remark = remarkBy.get(student.enrolmentId);
      if (remark && remark.remark !== null) add(remark.writtenBy, 'remark_author');
      add(contributors.submittedBy, 'submitter');
      add(contributors.approver, 'approver');
      for (const flag of inherited(student.studentId)) {
        if (!flags.some((f) => f.userId === flag.userId && f.role === flag.role)) flags.push(flag);
      }
      flags.sort(
        (a, b) =>
          ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
          (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
      );
      rows.set(student.studentId, flags);
    }
    return { rows, guardiansOf };
  }
}

function groupBy<T>(rows: readonly T[], key: (row: T) => bigint): Map<bigint, T[]> {
  const map = new Map<bigint, T[]>();
  for (const row of rows) {
    const list = map.get(key(row)) ?? [];
    list.push(row);
    map.set(key(row), list);
  }
  return map;
}

/**
 * The subjects of rows (stored results, or composed rows) as headers: each class-subject once, a
 * later row's snapshot winning, in print order (sort order, then id).
 */
export function subjectHeadersOf(
  rows: readonly { readonly subjects: readonly SubjectHeader[] }[],
): SubjectHeader[] {
  const headers = new Map<bigint, SubjectHeader>();
  for (const row of rows) {
    for (const s of row.subjects) {
      headers.set(s.classSubjectId, {
        classSubjectId: s.classSubjectId,
        subjectName: s.subjectName,
        sortOrder: s.sortOrder,
      });
    }
  }
  return [...headers.values()].sort(
    (a, b) => a.sortOrder - b.sortOrder || (a.classSubjectId < b.classSubjectId ? -1 : 1),
  );
}

const header = (cs: ClassSubjectRecord): SubjectHeader => ({
  classSubjectId: cs.id,
  subjectName: cs.subjectName,
  sortOrder: cs.sortOrder,
});

function rowBase(
  student: SheetRosterRow,
  remarks: readonly RemarkRecord[],
): Pick<
  ComposedRow,
  | 'enrolmentId'
  | 'studentId'
  | 'fullName'
  | 'admissionNo'
  | 'rollNo'
  | 'remark'
  | 'position'
  | 'positionOf'
> {
  return {
    enrolmentId: student.enrolmentId,
    studentId: student.studentId,
    fullName: student.fullName,
    admissionNo: student.admissionNo,
    rollNo: student.rollNo,
    remark: remarks.find((r) => r.enrolmentId === student.enrolmentId)?.remark ?? null,
    position: null,
    positionOf: null,
  };
}

/** Positions within the section (R260, A5), in roster order. */
function ranked(rows: ComposedRow[]): ComposedRow[] {
  const ranks = positions(rows);
  return rows.map((row, i) => ({
    ...row,
    position: ranks[i]?.position ?? null,
    positionOf: ranks[i]?.positionOf ?? null,
  }));
}

function sortSubjects(
  subjects: readonly KeyedSubject[],
  headers: ReadonlyMap<string, SubjectHeader>,
): KeyedSubject[] {
  return [...subjects].sort(
    (a, b) =>
      (headers.get(a.key)?.sortOrder ?? 0) - (headers.get(b.key)?.sortOrder ?? 0) ||
      (BigInt(a.key) < BigInt(b.key) ? -1 : 1),
  );
}

/**
 * A composed row as a new stored result of `sheet`: unrevised and unpublished (a correction's
 * version sets those, and what it supersedes, over it).
 */
export function newResultOf(
  sheet: Pick<ResultSheetRecord, 'id' | 'academicYearId' | 'termId' | 'classId'>,
  row: Omit<ComposedRow, 'fullName' | 'admissionNo' | 'rollNo'>,
): NewResult {
  return {
    sheetId: sheet.id,
    enrolmentId: row.enrolmentId,
    studentId: row.studentId,
    academicYearId: sheet.academicYearId,
    termId: sheet.termId,
    classId: sheet.classId,
    totalObtained: row.totalObtained,
    totalMax: row.totalMax,
    percentBp: row.percentBp,
    grade: row.grade,
    passed: row.passed,
    failedSubjects: row.failedSubjects,
    position: row.position,
    positionOf: row.positionOf,
    attendanceBp: row.attendanceBp,
    remark: row.remark,
    ownChildFlags: row.ownChildFlags,
    revised: false,
    publishedAt: null,
    subjects: row.subjects,
  };
}

/** A stored result as a composed row (an approved or published sheet's detail). */
export function storedRow(
  result: ResultRecord,
  student: Pick<SheetRosterRow, 'fullName' | 'admissionNo' | 'rollNo'>,
): ComposedRow {
  return {
    enrolmentId: result.enrolmentId,
    studentId: result.studentId,
    fullName: student.fullName,
    admissionNo: student.admissionNo,
    rollNo: student.rollNo,
    totalObtained: result.totalObtained,
    totalMax: result.totalMax,
    percentBp: result.percentBp,
    grade: result.grade,
    passed: result.passed,
    failedSubjects: result.failedSubjects,
    position: result.position,
    positionOf: result.positionOf,
    attendanceBp: result.attendanceBp,
    remark: result.remark,
    ownChildFlags: result.ownChildFlags,
    subjects: result.subjects,
  };
}
