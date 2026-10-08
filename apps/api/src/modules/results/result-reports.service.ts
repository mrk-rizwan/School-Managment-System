import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@asms/shared';
import { ApiException, notFound } from '../../common/errors/api-exception';
import { SchoolContext } from '../../common/school-context';
import { ResultReadsRepository } from '../../repositories/result-reads.repository';
import type {
  GradeCountDto,
  SectionSummaryQueryDto,
  SectionSummaryReportDto,
  SubjectReportDto,
  SubjectReportQueryDto,
  SubjectReportStudentDto,
} from './result-reports.dto';

/** The subject report's top and bottom per section. */
const TOP_N = 3;

/** The mean of non-negative integers, rounded half-up; null for none. */
function averageOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return Math.floor((2 * sum + values.length) / (2 * values.length));
}

/** Grade counts, most frequent first, then by grade. */
function gradeCounts(grades: readonly (string | null)[]): GradeCountDto[] {
  const counts = new Map<string, number>();
  for (const grade of grades) if (grade !== null) counts.set(grade, (counts.get(grade) ?? 0) + 1);
  return [...counts]
    .map(([grade, count]) => ({ grade, count }))
    .sort((a, b) => b.count - a.count || a.grade.localeCompare(b.grade));
}

/**
 * The result reports (phase-4-academic.md slice 33, contracts/slice-33.md §3, R287): figures read
 * from the stored rows only, so the section summary's pass count is the stored `passed` rows and
 * the subject report's averages are the mean of the stored `percent_bp`. `marks.view_all` only
 * (school-wide), so no row scope applies.
 */
@Injectable()
export class ResultReportsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly reads: ResultReadsRepository,
  ) {}

  /** GET /result-reports/section-summary: one approved or published sheet version. */
  async sectionSummary(query: SectionSummaryQueryDto): Promise<SectionSummaryReportDto> {
    const schoolId = this.context.schoolId;
    const sheet = await this.reads.reportSheet(schoolId, BigInt(query.sheetId));
    if (sheet === null) throw notFound();
    if (sheet.status !== 'approved' && sheet.status !== 'published') {
      throw new ApiException(
        409,
        ErrorCode.RESULT_SHEET_NOT_APPROVED,
        'The sheet has no stored results until it is approved.',
        { sheetId: sheet.id.toString() },
      );
    }
    const rows = await this.reads.reportRows(schoolId, sheet.id);
    const subjects = new Map<
      bigint,
      { name: string; sortOrder: number; bps: number[]; passed: number; failed: number; grades: (string | null)[] }
    >();
    for (const row of rows) {
      for (const s of row.subjects) {
        const entry = subjects.get(s.classSubjectId) ?? {
          name: s.subjectName,
          sortOrder: s.sortOrder,
          bps: [],
          passed: 0,
          failed: 0,
          grades: [],
        };
        subjects.set(s.classSubjectId, entry);
        if (s.status !== 'assessed' || s.percentBp === null || s.obtained === null) continue;
        entry.bps.push(s.percentBp);
        entry.grades.push(s.grade);
        // The composition's per-subject check (§0.26): printed obtained ÷ max ≥ the pass mark.
        if (sheet.passPercent !== null && s.obtained * 100 >= sheet.passPercent * s.max) entry.passed += 1;
        else entry.failed += 1;
      }
    }
    const assessed = rows.filter((r) => r.percentBp !== null);
    return {
      sheetId: sheet.id.toString(),
      status: sheet.status,
      version: sheet.version,
      academicYearId: sheet.academicYearId.toString(),
      termId: sheet.termId?.toString() ?? null,
      termName: sheet.termName,
      classId: sheet.classId.toString(),
      className: sheet.className,
      sectionId: sheet.sectionId.toString(),
      sectionName: sheet.sectionName,
      passPercent: sheet.passPercent,
      students: rows.length,
      assessed: assessed.length,
      passed: rows.filter((r) => r.passed === true).length,
      failed: rows.filter((r) => r.passed === false).length,
      averageBp: averageOf(assessed.map((r) => r.percentBp ?? 0)),
      grades: gradeCounts(rows.map((r) => r.grade)),
      subjects: [...subjects]
        .sort(([idA, a], [idB, b]) => a.sortOrder - b.sortOrder || (idA < idB ? -1 : idA > idB ? 1 : 0))
        .map(([id, s]) => ({
          classSubjectId: id.toString(),
          subjectName: s.name,
          assessed: s.bps.length,
          passed: s.passed,
          failed: s.failed,
          averageBp: averageOf(s.bps),
          grades: gradeCounts(s.grades),
        })),
    };
  }

  /** GET /result-reports/subject: one class-subject in one term, per section (live rows). */
  async subject(query: SubjectReportQueryDto): Promise<SubjectReportDto> {
    const schoolId = this.context.schoolId;
    const termId = BigInt(query.termId);
    const classSubjectId = BigInt(query.classSubjectId);
    const target = await this.reads.classSubjectOfTerm(schoolId, termId, classSubjectId);
    if (target === null) throw notFound();
    const rows = await this.reads.subjectRows(schoolId, termId, classSubjectId);
    const sections = new Map<bigint, { name: string; rows: typeof rows }>();
    for (const row of rows) {
      const entry = sections.get(row.sectionId) ?? { name: row.sectionName, rows: [] };
      entry.rows.push(row);
      sections.set(row.sectionId, entry);
    }
    const toStudent = (r: (typeof rows)[number]): SubjectReportStudentDto => ({
      resultId: r.resultId.toString(),
      studentId: r.studentId.toString(),
      fullName: r.fullName,
      percentBp: r.percentBp ?? 0,
    });
    const assessedAll = rows.filter((r) => r.percentBp !== null);
    return {
      termId: termId.toString(),
      termName: target.termName,
      classId: target.classId.toString(),
      className: target.className,
      classSubjectId: classSubjectId.toString(),
      subjectName: target.subjectName,
      assessed: assessedAll.length,
      averageBp: averageOf(assessedAll.map((r) => r.percentBp ?? 0)),
      sections: [...sections]
        .sort(([, a], [, b]) => a.name.localeCompare(b.name))
        .map(([id, s]) => {
          const assessed = s.rows.filter((r) => r.percentBp !== null);
          const ranked = [...assessed].sort(
            (a, b) => (b.percentBp ?? 0) - (a.percentBp ?? 0) || a.fullName.localeCompare(b.fullName),
          );
          return {
            sectionId: id.toString(),
            sectionName: s.name,
            published: s.rows.every((r) => r.published),
            students: s.rows.length,
            assessed: assessed.length,
            averageBp: averageOf(assessed.map((r) => r.percentBp ?? 0)),
            top: ranked.slice(0, TOP_N).map(toStudent),
            bottom: ranked.slice(-TOP_N).reverse().map(toStudent),
          };
        }),
    };
  }
}
