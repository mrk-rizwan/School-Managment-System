import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { Capability } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { concurrentUpdate, notFound } from '../../common/errors/api-exception';
import { SchoolClock } from '../../common/school-clock';
import { SchoolContext } from '../../common/school-context';
import { AcademicTermRepository } from '../../repositories/academic-term.repository';
import { AcademicYearRepository } from '../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import {
  ResultSheetRepository,
  type SheetSnapshot,
} from '../../repositories/result-sheet.repository';
import { ResultRepository } from '../../repositories/result.repository';
import { requireOpenYear } from '../academics/academics.shared';
import { PermissionsService } from '../access/permissions.service';
import { newResultOf, ResultComposer, type Composition } from './result-composer';
import { ResultSheetsService } from './result-sheets.service';
import type { ResultSheetDetailDto } from './results.dto';
import {
  examNotSetUp,
  flagsText,
  marksIncomplete,
  selfDecision,
  sheetFlags,
  sheetNotSubmitted,
} from './results.shared';

// contracts/slice-31.md §2.7 (phase-4-academic.md slice 31 "Behaviour", R269-R272, R275, R276):
// approval composes and stores. Under the sheet's row lock: the section's enrolments in force on
// the term's last day, the live marks of every student on the sheet across their enrolments in
// the class, one attendance aggregate and the own-child set (ResultComposer, four reads); then the
// shared functions in memory, the settings snapshot onto the sheet, and the full row set in two
// inserts. It publishes in the same transaction when the approver holds result.publish.

const SUBJECT = 'result_sheet';

@Injectable()
export class ResultApprovalService {
  constructor(
    private readonly context: SchoolContext,
    private readonly sheetsService: ResultSheetsService,
    private readonly sheets: ResultSheetRepository,
    private readonly results: ResultRepository,
    private readonly composer: ResultComposer,
    private readonly terms: AcademicTermRepository,
    private readonly years: AcademicYearRepository,
    private readonly permissions: PermissionsService,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
  ) {}

  @Transactional()
  async approve(session: SchoolSessionContext, id: bigint): Promise<ResultSheetDetailDto> {
    const { schoolId, userId } = this.context.actor();
    const { scope, sheet } = await this.sheetsService.lock(session, id);
    const isFinal = sheet.termId === null;
    const ready = isFinal
      ? sheet.status === 'draft' || sheet.status === 'returned' || sheet.status === 'submitted'
      : sheet.status === 'submitted';
    if (!ready) throw sheetNotSubmitted(sheet);
    const year = await requireOpenYear(this.years, schoolId, sheet.academicYearId);

    // R271: never the submitter, except the sole principal (recorded self_approved).
    let selfApproved = false;
    if (sheet.submittedBy !== null && sheet.submittedBy === userId) {
      if (!(await this.permissions.isSolePrincipal(schoolId, userId))) throw selfDecision();
      selfApproved = true;
    }

    const settings = await this.sheetsService.liveSettings(schoolId, sheet.academicYearId);
    const yearTerms = await this.terms.allForYear(schoolId, sheet.academicYearId);
    const contributors = {
      remarks: await this.sheets.remarks(schoolId, sheet.id),
      submittedBy: sheet.submittedBy,
      approver: userId,
    };
    let composition: Composition;
    let snapshot: SheetSnapshot;
    if (isFinal) {
      // R275: every held term published for the section; held weights sum to 100.
      const weights = await this.sheetsService.finalWeights(schoolId, sheet.sectionId, sheet.classId, yearTerms);
      composition = await this.composer.final(
        schoolId,
        scope,
        sheet,
        yearTerms,
        weights,
        year,
        settings,
        contributors,
      );
      snapshot = {
        testWeight: null,
        examWeight: null,
        passPercent: settings.passPercent,
        passRule: settings.passRule,
        bands: [...settings.bands],
        termWeights: weights,
      };
      // The final sheet has no submitter: it enters review in this transaction (§3.2's edges).
      if (sheet.status !== 'submitted')
        await this.sheets.enterReviewWithoutSubmitter(schoolId, sheet.id);
    } else {
      const term = yearTerms.find((t) => t.id === sheet.termId);
      if (!term || sheet.termId === null) throw notFound();
      composition = await this.composer.term(schoolId, scope, sheet, term, settings, contributors);
      // The roster can change between submission and approval (a joiner); marks cannot (locked).
      const notSetUp = composition.examsNotSetUp[0];
      if (notSetUp !== undefined) throw examNotSetUp(notSetUp, sheet.sectionId, sheet.termId);
      if (composition.gaps.length > 0) throw marksIncomplete(composition.gaps);
      snapshot = {
        testWeight: settings.testWeight,
        examWeight: settings.examWeight,
        passPercent: settings.passPercent,
        passRule: settings.passRule,
        bands: [...settings.bands],
        termWeights: null,
      };
    }

    const now = this.clock.now();
    const moved = await this.sheets.markApproved(schoolId, sheet.id, {
      decidedBy: userId,
      decidedAt: now,
      selfApproved,
      snapshot,
    });
    if (moved !== 1) throw concurrentUpdate();
    await this.results.insertSet(
      schoolId,
      sheet.id,
      composition.rows.map((row) => newResultOf(sheet, row)),
    );
    const flags = sheetFlags(composition.rows);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'result_sheet.approved',
      subjectType: SUBJECT,
      subjectId: sheet.id,
      metadata: {
        results: composition.rows.length,
        ownChildFlags: flagsText(flags),
        cover: sheet.submittedUnderAssignmentId !== null,
        selfApproved,
      },
    });
    // R272: the approval publishes when the approver holds result.publish.
    if (this.permissions.holds(session.access, Capability.RESULT_PUBLISH)) {
      await this.sheetsService.publishLocked(schoolId, userId, sheet);
    }
    return this.sheetsService.detail(session, sheet.id);
  }
}
