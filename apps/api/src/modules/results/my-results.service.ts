import { Injectable } from '@nestjs/common';
import { scopeOf, type SchoolSessionContext } from '../../common/auth/school-session';
import { notFound } from '../../common/errors/api-exception';
import { toPage, type Page, type PageQueryDto } from '../../common/pagination';
import { SchoolContext } from '../../common/school-context';
import {
  ResultReadsRepository,
  type ResultSummaryRecord,
} from '../../repositories/result-reads.repository';
import { toDateString } from '../academics/academics.shared';
import type {
  MyAssessmentMarkDto,
  MyAssessmentsQueryDto,
  MyChildResultsDto,
  MyResultDto,
  MyResultSummaryDto,
  MyResultsQueryDto,
} from './my-results.dto';
import { ResultCardsService } from './result-cards.service';
import { ResultSheetsService } from './result-sheets.service';
import type { ResultDto } from './results.dto';

/** Who is reading: a guardian sees the dues figure on a withheld card; a student sees no figure (R282). */
export type ResultsCapacity = 'guardian' | 'student';

/**
 * 404 unless the student is in the capacity scope the access guard bound (contracts/slice-13.md
 * §1.2): a guardian's live login children, or the student login's own id (R78, R285).
 */
function requireReachable(session: SchoolSessionContext, studentId: bigint): void {
  const scope = scopeOf(session);
  if (scope.kind !== 'students' || !scope.ids.includes(studentId)) throw notFound();
}

/**
 * The family's and the student's results (phase-4-academic.md slice 33, §0.29, contracts/
 * slice-33.md): only published, live rows (R274); class-test marks as entered (R286); the card
 * withheld while dues are owed when the school says so (R282, through ResultCardsService.withheldFor,
 * which reads FinanceReportsService.clearance). Also the student page's results (R288), never
 * withheld (a staff read).
 */
@Injectable()
export class MyResultsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly reads: ResultReadsRepository,
    private readonly cards: ResultCardsService,
    private readonly sheets: ResultSheetsService,
  ) {}

  /** GET /me/children/:id/results and GET /me/student/results. */
  async results(
    session: SchoolSessionContext,
    capacity: ResultsCapacity,
    studentId: bigint,
    query: MyResultsQueryDto,
  ): Promise<MyChildResultsDto> {
    requireReachable(session, studentId);
    const schoolId = this.context.schoolId;
    const years = await this.reads.yearsWithResults(schoolId, studentId);
    const yearId =
      query.academicYearId === undefined ? years[0]?.id ?? null : BigInt(query.academicYearId);
    const rows = yearId === null ? [] : await this.reads.summariesOfYear(schoolId, studentId, yearId);
    const hold = await this.hold(capacity, studentId, yearId);
    const toDto = (row: ResultSummaryRecord) => toSummary(row, hold.withheld && capacity === 'student');
    return {
      studentId: studentId.toString(),
      academicYearId: yearId?.toString() ?? null,
      years: years.map((y) => ({ id: y.id.toString(), name: y.name })),
      terms: rows
        .filter((r) => r.termId !== null)
        .sort((a, b) => (a.termSortOrder ?? 0) - (b.termSortOrder ?? 0))
        .map(toDto),
      final: ((row) => (row ? toDto(row) : null))(rows.find((r) => r.termId === null)),
      ...hold,
    };
  }

  /** GET /me/children/:id/results/:resultId and GET /me/student/results/:resultId: 200 either way. */
  async result(
    session: SchoolSessionContext,
    capacity: ResultsCapacity,
    studentId: bigint,
    resultId: bigint,
  ): Promise<MyResultDto> {
    requireReachable(session, studentId);
    const schoolId = this.context.schoolId;
    const found = await this.reads.publishedLive(schoolId, studentId, resultId);
    if (found === null) throw notFound();
    const hold = await this.hold(capacity, studentId, found.academicYearId);
    if (hold.withheld) return { ...hold, result: null };
    const [card] = await this.cards.cards(schoolId, [found.id]);
    if (!card) throw notFound();
    return { ...hold, result: card };
  }

  /** GET /me/children/:id/assessments and GET /me/student/assessments: class tests only (R286). */
  async assessments(
    session: SchoolSessionContext,
    studentId: bigint,
    query: MyAssessmentsQueryDto,
  ): Promise<Page<MyAssessmentMarkDto>> {
    requireReachable(session, studentId);
    const { rows, total } = await this.reads.testMarks(this.context.schoolId, studentId, {
      ...(query.termId === undefined ? {} : { termId: BigInt(query.termId) }),
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(
      rows.map((r) => ({
        markId: r.markId.toString(),
        assessmentId: r.assessmentId.toString(),
        name: r.name,
        testType: r.testType,
        heldOn: toDateString(r.heldOn),
        termId: r.termId.toString(),
        termName: r.termName,
        subjectName: r.subjectName,
        maxMarks: r.maxMarks,
        obtained: r.obtained,
        absent: r.absent,
        excused: r.excused,
      })),
      query,
      total,
    );
  }

  /**
   * GET /students/:id/results (R288): every published, live result across years, newest first, in
   * the caller's student scope (marks.view_all, or student.view as scoped); never withheld. A
   * section-scoped reader sees only the cards of sheets they class-teach or cover (the sheet scope
   * of GET /results/:id): a subject teacher reaches the student, not their report card.
   */
  async ofStudent(
    session: SchoolSessionContext,
    studentId: bigint,
    query: PageQueryDto,
  ): Promise<Page<ResultDto>> {
    const schoolId = this.context.schoolId;
    const scope = scopeOf(session);
    if (!(await this.reads.studentInScope(schoolId, scope, studentId))) throw notFound();
    const sheets = scope.kind === 'all' ? 'any' : await this.sheets.scopeOf(session);
    if (sheets === null) return toPage([], query, 0);
    const { ids, total } = await this.reads.publishedIdsOfStudent(schoolId, studentId, sheets, {
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(await this.cards.cards(schoolId, ids), query, total);
  }

  /**
   * The withholding of R282 for the year shown (the result's year; with none, the student's newest
   * enrolment's): a guardian learns the figure, a student never does.
   */
  private async hold(
    capacity: ResultsCapacity,
    studentId: bigint,
    academicYearId: bigint | null,
  ): Promise<{ withheld: boolean; outstanding: number | null }> {
    const { withheld, outstanding } = await this.cards.withheldFor(
      this.context.schoolId,
      studentId,
      academicYearId ?? undefined,
    );
    if (!withheld) return { withheld: false, outstanding: null };
    return { withheld: true, outstanding: capacity === 'guardian' ? outstanding : null };
  }
}

function toSummary(row: ResultSummaryRecord, hideFigures: boolean): MyResultSummaryDto {
  return {
    id: row.id.toString(),
    academicYearId: row.academicYearId.toString(),
    academicYearName: row.academicYearName,
    termId: row.termId?.toString() ?? null,
    termName: row.termName,
    isFinal: row.termId === null,
    className: row.className,
    sectionName: row.sectionName,
    percentBp: hideFigures ? null : row.percentBp,
    grade: hideFigures ? null : row.grade,
    revised: row.revised,
    publishedAt: row.publishedAt,
  };
}
