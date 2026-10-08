import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { notFound } from '../../common/errors/api-exception';
import type { SafeHtml } from '../../common/print-view';
import { SchoolClock } from '../../common/school-clock';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { OwnSchoolRepository } from '../../repositories/own-school.repository';
import { ResultSettingsRepository } from '../../repositories/result-settings.repository';
import { ResultRepository, type ResultCardRecord } from '../../repositories/result.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { FinanceReportsService } from '../finance-reports/finance-reports.service';
import { resultCardPage, resultSheetPage } from './result-print';
import { ResultSheetsService } from './result-sheets.service';
import type { ResultDto } from './results.dto';

// contracts/slice-32.md §2, §5 (phase-4-academic.md §3.4, rule 28, R279, R282): the report card is
// the stored results row with its subjects (ResultDto); this service builds it for every reader —
// staff (GET /results/:id, the prints), the family and student routes of slice 33, the phone —
// and answers the withholding rule. It scopes nothing: each caller resolves the ids inside its own
// scope first (a staff key, a guardian's live child, the session's own student).

export interface Withholding {
  /** The per-subject card is held back from the guardian (and the student sees no figure). */
  withheld: boolean;
  /** The dues outstanding across every year (FinanceReportsService.clearance); 0 when not withheld. */
  outstanding: number;
}

/** A card as the DTO; the year's display toggles null the figures they hide (§3.4). */
export function toResultDto(card: ResultCardRecord, schoolName: string): ResultDto {
  return {
    id: card.id.toString(),
    sheetId: card.sheetId.toString(),
    sheetVersion: card.sheetVersion,
    schoolName,
    academicYearId: card.academicYearId.toString(),
    academicYearName: card.academicYearName,
    termId: card.termId?.toString() ?? null,
    termName: card.termName,
    isFinal: card.termId === null,
    classId: card.classId.toString(),
    className: card.className,
    sectionId: card.sectionId.toString(),
    sectionName: card.sectionName,
    enrolmentId: card.enrolmentId.toString(),
    studentId: card.studentId.toString(),
    studentName: card.studentName,
    admissionNo: card.admissionNo,
    rollNo: card.rollNo,
    totalObtained: card.totalObtained,
    totalMax: card.totalMax,
    percentBp: card.percentBp,
    grade: card.grade,
    passed: card.passed,
    failedSubjects: card.failedSubjects,
    position: card.show.position ? card.position : null,
    positionOf: card.show.position ? card.positionOf : null,
    attendanceBp: card.show.attendance ? card.attendanceBp : null,
    remark: card.show.remark ? card.remark : null,
    showPosition: card.show.position,
    showAttendance: card.show.attendance,
    showRemark: card.show.remark,
    revised: card.revised,
    publishedAt: card.publishedAt,
    supersededAt: card.supersededAt,
    subjects: card.subjects.map((s) => ({
      classSubjectId: s.classSubjectId.toString(),
      subjectName: s.subjectName,
      sortOrder: s.sortOrder,
      testBp: s.testBp,
      examBp: s.examBp,
      examObtained: s.examObtained,
      examMax: s.examMax,
      examAbsent: s.examAbsent,
      examExcused: s.examExcused,
      percentBp: s.percentBp,
      obtained: s.obtained,
      max: s.max,
      grade: s.grade,
      status: s.status,
    })),
  };
}

@Injectable()
export class ResultCardsService {
  constructor(
    private readonly results: ResultRepository,
    private readonly school: OwnSchoolRepository,
    private readonly settings: ResultSettingsRepository,
    private readonly dues: FinanceReportsService,
    private readonly sheets: ResultSheetsService,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
  ) {}

  // -------------------------------------------------------------------------- staff reads

  /**
   * GET /results/:id (R279): the stored row as the card, for a reader whose sheet scope reaches
   * it, published or superseded; a staff read is never withheld. Outside the scope: 404.
   */
  async staffCard(session: SchoolSessionContext, id: bigint): Promise<ResultDto> {
    const schoolId = session.schoolId;
    const scope = await this.sheets.scopeOf(session);
    if (!scope || !(await this.results.staffVisible(schoolId, scope, id))) throw notFound();
    const [card] = await this.cards(schoolId, [id]);
    if (!card) throw notFound();
    return card;
  }

  /** GET /results/:id/print (R283, R284): the card's page; audited `result.printed` with ids only. */
  @Transactional()
  async printCard(session: SchoolSessionContext, id: bigint): Promise<SafeHtml> {
    const card = await this.staffCard(session, id);
    await this.audit.record(session.schoolId, {
      actorUserId: session.access.userId,
      action: 'result.printed',
      subjectType: 'result',
      subjectId: id,
      metadata: { resultId: id.toString(), sheetId: card.sheetId },
    });
    return resultCardPage(card, await this.clock.timezone(session.schoolId));
  }

  /**
   * GET /result-sheets/:id/print (R283): every live card of the sheet in the caller's scope, one
   * per page, by roll number then name; audited `result_sheet.printed` with ids and the count.
   */
  @Transactional()
  async printSheet(session: SchoolSessionContext, sheetId: bigint): Promise<SafeHtml> {
    const schoolId = session.schoolId;
    const { scope, sheet } = await this.sheets.load(session, sheetId);
    const ids = await this.results.sheetCardIds(schoolId, scope, sheet.id);
    const cards = await this.cards(schoolId, ids);
    await this.audit.record(schoolId, {
      actorUserId: session.access.userId,
      action: 'result_sheet.printed',
      subjectType: 'result_sheet',
      subjectId: sheet.id,
      metadata: { sheetId: sheet.id.toString(), cards: cards.length },
    });
    const title = `Report cards ${sheet.className} ${sheet.sectionName} ${sheet.termName ?? 'Final'}`;
    return resultSheetPage(title, cards, await this.clock.timezone(schoolId));
  }

  /** ResultDto for each id, in the order given; an id that is not the school's is omitted. */
  async cards(schoolId: SchoolId, resultIds: readonly bigint[]): Promise<ResultDto[]> {
    const rows = await this.results.cards(schoolId, resultIds);
    if (rows.length === 0) return [];
    const school = await this.school.find(schoolId);
    if (!school) throw notFound();
    return rows.map((row) => toResultDto(row, school.name));
  }

  /**
   * A11 (slice 34's certificates): the card a certificate of `academicYearId` prints — the
   * published final result of the year, else its last published term; null when none.
   */
  async certificateResultFor(
    schoolId: SchoolId,
    studentId: bigint,
    academicYearId: bigint,
  ): Promise<ResultDto | null> {
    const id = await this.results.certificateResultOf(schoolId, studentId, academicYearId);
    if (id === null) return null;
    const [card] = await this.cards(schoolId, [id]);
    return card ?? null;
  }

  /** The stored rows behind `cards` (the print views read the records). */
  records(schoolId: SchoolId, resultIds: readonly bigint[]): Promise<ResultCardRecord[]> {
    return this.results.cards(schoolId, resultIds);
  }

  /**
   * R282 (rule 28, §1.1 "Withheld card"): with the year's `withhold_card_for_dues` on, the card is
   * withheld until FinanceReportsService.clearance says cleared (nothing owed, or the principal's
   * override) — read at request time, so a later payment unlocks it with no write. The year is
   * `academicYearId` (the result's), else the student's newest enrolment's. Off: never withheld,
   * and no dues are read. Staff reads never call this.
   */
  async withheldFor(
    schoolId: SchoolId,
    studentId: bigint,
    academicYearId?: bigint,
  ): Promise<Withholding> {
    const yearId = academicYearId ?? (await this.results.newestEnrolmentYear(schoolId, studentId));
    if (yearId === null) return { withheld: false, outstanding: 0 };
    const settings = await this.settings.findForYear(schoolId, yearId);
    if (!settings?.withholdCardForDues) return { withheld: false, outstanding: 0 };
    const clearance = await this.dues.clearance(studentId);
    return clearance.cleared
      ? { withheld: false, outstanding: 0 }
      : { withheld: true, outstanding: clearance.outstanding };
  }
}
