import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { Capability, ErrorCode } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import {
  ApiException,
  concurrentUpdate,
  fieldRefused,
  notFound,
} from '../../common/errors/api-exception';
import { readLocked } from '../../common/locking';
import { toPage, type Page } from '../../common/pagination';
import { SchoolClock } from '../../common/school-clock';
import { SchoolContext } from '../../common/school-context';
import { OutboxDispatcher } from '../../messaging/outbox-dispatcher';
import {
  AcademicTermRepository,
  type AcademicTermRecord,
} from '../../repositories/academic-term.repository';
import { AcademicYearRepository } from '../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ClassRepository } from '../../repositories/class.repository';
import { MarkReadsRepository } from '../../repositories/mark-reads.repository';
import {
  ResultSheetRepository,
  sheetScopeReaches,
  type ResultSheetRecord,
  type TermWeight,
} from '../../repositories/result-sheet.repository';
import { ResultSettingsRepository } from '../../repositories/result-settings.repository';
import { ResultRepository, type OwnChildFlag } from '../../repositories/result.repository';
import { SectionRepository } from '../../repositories/section.repository';
import { TeacherAssignmentRepository } from '../../repositories/teacher-assignment.repository';
import type { SchoolId } from '../../tenancy/school-id';
import type { MarksScope } from '../../tenancy/scope';
import { classArchived, requireOpenYear, yearClosed } from '../academics/academics.shared';
import { PermissionsService } from '../access/permissions.service';
import {
  ResultComposer,
  storedRow,
  subjectHeadersOf,
  type Composition,
  type CompositionSettings,
} from './result-composer';
import type {
  CreateResultSheetDto,
  ListResultSheetsQueryDto,
  ResultSheetDetailDto,
  ResultSheetDto,
  UpdateResultSheetDto,
} from './results.dto';
import {
  examNotSetUp,
  gapDto,
  marksIncomplete,
  MAX_GAPS,
  selfDecision,
  sheetFlags,
  sheetNotApproved,
  sheetNotDraft,
  sheetNotSubmitted,
  sheetPublished,
  termsUnpublished,
  toPreviewRow,
  toSheetDto,
} from './results.shared';

// contracts/slice-31.md §1-§3 (phase-4-academic.md slice 31, R267-R278): a section's term (or
// final) result sheet — created by an explicit POST, previewed from the live marks by the shared
// composition, remarked and submitted by the class teacher, returned or approved (ResultApproval)
// by a result.approve holder, published by a result.publish holder. Every read uses the caller's
// sheet scope of today (sheetReadScopeOf): school-wide, or the sections they class-teach or cover.

const SUBJECT = 'result_sheet';

/** The approvals queue's page (GET /result-sheets?status=submitted composes each row): the inbox size. */
export const SUBMITTED_PAGE_CAP = 10;

const notClassTeacher = (): ApiException =>
  new ApiException(
    403,
    ErrorCode.PERMISSION_DENIED,
    "Only the section's class teacher (or cover) writes remarks and submits the sheet.",
    { reason: 'not_class_teacher' },
  );

export interface SheetCreateOutcome {
  created: boolean;
  sheet: ResultSheetDetailDto;
}

/** Who may author a sheet today (§1.1 "Who submits"), and the cover assignment behind it. */
interface Authorship {
  allowed: boolean;
  coverAssignmentId: bigint | null;
}

@Injectable()
export class ResultSheetsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly sheets: ResultSheetRepository,
    private readonly results: ResultRepository,
    private readonly reads: MarkReadsRepository,
    private readonly composer: ResultComposer,
    private readonly terms: AcademicTermRepository,
    private readonly settings: ResultSettingsRepository,
    private readonly sections: SectionRepository,
    private readonly classes: ClassRepository,
    private readonly years: AcademicYearRepository,
    private readonly assignments: TeacherAssignmentRepository,
    private readonly permissions: PermissionsService,
    private readonly outbox: OutboxDispatcher,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
  ) {}

  // ------------------------------------------------------------------------------- scope, lock

  /** The caller's sheet scope of today; null reads nothing. */
  async scopeOf(session: SchoolSessionContext): Promise<MarksScope<'read'> | null> {
    return this.permissions.sheetReadScopeOf(session, await this.clock.today(session.schoolId));
  }

  /** The sheet in the caller's scope, else 404. */
  async load(
    session: SchoolSessionContext,
    id: bigint,
  ): Promise<{ scope: MarksScope; sheet: ResultSheetRecord }> {
    const scope = await this.scopeOf(session);
    const sheet = scope && (await this.sheets.find(session.schoolId, scope, id));
    if (!scope || !sheet) throw notFound();
    return { scope, sheet };
  }

  /** The sheet under its row lock (a compare-and-set on updated_at), in the caller's scope. */
  async lock(
    session: SchoolSessionContext,
    id: bigint,
  ): Promise<{ scope: MarksScope; sheet: ResultSheetRecord }> {
    const scope = await this.scopeOf(session);
    if (!scope) throw notFound();
    const sheet = await readLocked(
      () => this.sheets.find(session.schoolId, scope, id),
      (found) => this.sheets.lockIfUnchanged(session.schoolId, scope, found),
    );
    return { scope, sheet };
  }

  /**
   * §1.1: the section's class teacher or cover on today, or, when the section has no class
   * teacher today, an assessment.define holder.
   */
  private async authorship(session: SchoolSessionContext, sectionId: bigint): Promise<Authorship> {
    const { schoolId, access } = session;
    const today = await this.clock.today(schoolId);
    const write = await this.permissions.marksWriteScopeOf(session, today);
    const roles = write?.kind === 'sections' ? write.sections.get(sectionId) : undefined;
    if (roles && (roles.classTeacher || roles.cover) && access.staffId !== null) {
      const coverAssignmentId = roles.classTeacher
        ? null
        : await this.assignments.coverAssignmentOn(schoolId, access.staffId, sectionId, today);
      return { allowed: true, coverAssignmentId };
    }
    if (
      this.permissions.holds(access, Capability.ASSESSMENT_DEFINE) &&
      !(await this.assignments.hasClassTeacherOn(schoolId, sectionId, today))
    ) {
      return { allowed: true, coverAssignmentId: null };
    }
    return { allowed: false, coverAssignmentId: null };
  }

  // ------------------------------------------------------------------------------------ create

  /**
   * R267: a sheet exists only by this POST; a repeat answers the open version (200). A term not
   * held for the class is refused; the final sheet (termId null) needs every held term of the
   * year published for the section (R275) and held weights summing to 100.
   */
  @Transactional()
  async create(
    session: SchoolSessionContext,
    sectionId: bigint,
    dto: CreateResultSheetDto,
  ): Promise<SheetCreateOutcome> {
    const { schoolId, userId } = this.context.actor();
    const scope = await this.scopeOf(session);
    const section = await this.sections.findById(schoolId, sectionId);
    if (!section || !scope) throw notFound();
    const allowed =
      sheetScopeReaches(scope, sectionId) &&
      ((await this.authorship(session, sectionId)).allowed ||
        this.permissions.holds(session.access, Capability.ASSESSMENT_DEFINE));
    if (!allowed) throw notFound();
    if (section.deletedAt !== null)
      throw new ApiException(409, ErrorCode.SECTION_ARCHIVED, 'This section is archived.');
    const klass = await this.classes.findById(schoolId, section.classId);
    const year = klass && (await this.years.findById(schoolId, klass.academicYearId));
    if (!klass || !year) throw notFound();
    if (klass.status === 'archived') throw classArchived();
    if (year.status === 'closed') throw yearClosed();

    const termId = dto.termId === null ? null : BigInt(dto.termId);
    const yearTerms = await this.terms.allForYear(schoolId, year.id);
    if (termId === null) {
      await this.finalWeights(schoolId, sectionId, klass.id, yearTerms);
    } else {
      const term = yearTerms.find((t) => t.id === termId);
      if (!term)
        throw fieldRefused(
          'termId',
          ErrorCode.REFERENCE_NOT_FOUND,
          "Not a term of the class's year",
        );
      if (term.skips.some((skip) => skip.classId === klass.id)) {
        throw fieldRefused(
          'termId',
          ErrorCode.INVALID_VALUE,
          'This term is not held for the class',
        );
      }
    }

    const open = await this.sheets.findOpen(schoolId, scope, sectionId, termId);
    if (open) return { created: false, sheet: await this.detailOf(session, scope, open) };
    if (await this.sheets.hasPublished(schoolId, sectionId, termId)) {
      const published = await this.sheets.list(
        schoolId,
        scope,
        { sectionId, ...(termId === null ? { finalOnly: true } : { termId }), status: 'published' },
        { skip: 0, take: 1, sort: '-updatedAt' },
      );
      throw sheetPublished(published.rows[0]?.id ?? 0n);
    }
    const sheet = await this.sheets.create(schoolId, {
      academicYearId: year.id,
      termId,
      classId: klass.id,
      sectionId,
      createdBy: userId,
    });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'result_sheet.created',
      subjectType: SUBJECT,
      subjectId: sheet.id,
      metadata: {
        sectionId: sectionId.toString(),
        termId: termId?.toString() ?? null,
        version: sheet.version,
      },
    });
    return { created: true, sheet: await this.detailOf(session, scope, sheet) };
  }

  // ------------------------------------------------------------------------------------- reads

  /**
   * §2.2: real rows only, in the caller's scope. Only the approvals queue (`status=submitted`)
   * composes: each of its sheets carries its own-child flags (R278) with the caller as the
   * would-be approver, and that page is capped at the inbox size (SUBMITTED_PAGE_CAP), so one
   * request composes at most ten sheets. Every other list carries no flags and composes nothing
   * (the detail carries them for every status).
   */
  async list(
    session: SchoolSessionContext,
    query: ListResultSheetsQueryDto,
  ): Promise<Page<ResultSheetDto>> {
    const schoolId = session.schoolId;
    const queue = query.status === 'submitted';
    const page = queue ? { ...query, limit: Math.min(query.limit, SUBMITTED_PAGE_CAP) } : query;
    const scope = await this.scopeOf(session);
    if (!scope) return toPage([], page, 0);
    const { rows, total } = await this.sheets.list(
      schoolId,
      scope,
      {
        ...(query.final === 'true' ? { finalOnly: true } : {}),
        ...(query.termId === undefined ? {} : { termId: BigInt(query.termId) }),
        ...(query.classId === undefined ? {} : { classId: BigInt(query.classId) }),
        ...(query.sectionId === undefined ? {} : { sectionId: BigInt(query.sectionId) }),
        ...(query.status === undefined ? {} : { status: query.status }),
      },
      { skip: (page.page - 1) * page.limit, take: page.limit, sort: query.sort ?? '-updatedAt' },
    );
    const flagsBySheet = new Map<bigint, OwnChildFlag[]>();
    if (queue) {
      for (const sheet of rows) {
        const composition = await this.compose(session, scope, sheet, { attendance: false });
        flagsBySheet.set(sheet.id, sheetFlags(composition.rows));
      }
    }
    const names = await this.sheets.names(schoolId, [
      ...rows.flatMap((s) =>
        [s.submittedBy, s.decidedBy, s.publishedBy].filter((id): id is bigint => id !== null),
      ),
      ...[...flagsBySheet.values()].flat().map((f) => f.userId),
    ]);
    const callerUserId = session.access.userId;
    return toPage(
      rows.map((sheet) =>
        toSheetDto(sheet, { callerUserId, names, ownChildFlags: flagsBySheet.get(sheet.id) ?? [] }),
      ),
      page,
      total,
    );
  }

  async detail(session: SchoolSessionContext, id: bigint): Promise<ResultSheetDetailDto> {
    const { scope, sheet } = await this.load(session, id);
    return this.detailOf(session, scope, sheet);
  }

  /**
   * §2.3: the sheet with its preview — the shared composition over the live marks while it is a
   * draft, submitted or returned (never stored, R267's "a GET never writes"), the stored results
   * once approved — and the flags (own child, cover, self-approval, gaps, exams not set up).
   */
  async detailOf(
    session: SchoolSessionContext,
    scope: MarksScope,
    sheet: ResultSheetRecord,
  ): Promise<ResultSheetDetailDto> {
    const schoolId = session.schoolId;
    const stored = sheet.status === 'approved' || sheet.status === 'published';
    let composition: Composition;
    let settings: CompositionSettings | null;
    // Slice 32: each stored row's id, so the screens open and print its card.
    const resultIds = new Map<bigint, bigint>();
    if (stored) {
      const rows = await this.results.forSheet(schoolId, scope, sheet.id);
      for (const r of rows) resultIds.set(r.enrolmentId, r.id);
      const names = await this.reads.enrolmentNames(
        schoolId,
        scope,
        sheet.sectionId,
        rows.map((r) => r.enrolmentId),
      );
      const composed = rows
        .map((r) =>
          storedRow(r, names.get(r.enrolmentId) ?? { fullName: '', admissionNo: '', rollNo: null }),
        )
        .sort(
          (a, b) =>
            (a.rollNo ?? Number.MAX_SAFE_INTEGER) - (b.rollNo ?? Number.MAX_SAFE_INTEGER) ||
            a.fullName.localeCompare(b.fullName),
        );
      composition = {
        rows: composed,
        subjects: subjectHeadersOf(composed),
        gaps: [],
        examsNotSetUp: [],
      };
      settings = snapshotSettings(sheet);
    } else {
      settings = await this.liveSettings(schoolId, sheet.academicYearId);
      composition = await this.compose(session, scope, sheet);
    }
    const flags = sheetFlags(composition.rows);
    const names = await this.sheets.names(schoolId, [
      ...[sheet.submittedBy, sheet.decidedBy, sheet.publishedBy].filter(
        (x): x is bigint => x !== null,
      ),
      ...flags.map((f) => f.userId),
    ]);
    // A gap names the enrolment the assessment applied to; it is counted on the student's row.
    const missingByStudent = new Map<bigint, number>();
    for (const gap of composition.gaps)
      missingByStudent.set(gap.studentId, (missingByStudent.get(gap.studentId) ?? 0) + 1);
    const { access } = session;
    const userId = access.userId;
    // Remarks: the author while draft or returned, the final sheet included; submit: a term sheet.
    const open = sheet.status === 'draft' || sheet.status === 'returned';
    const canRemark = open && (await this.authorship(session, sheet.sectionId)).allowed;
    const holdsApprove = this.permissions.holds(access, Capability.RESULT_APPROVE);
    const decidable =
      sheet.status === 'submitted' ||
      sheet.status === 'approved' ||
      (sheet.termId === null && open);
    // The submitter never decides their own sheet, except the sole active principal (R271); a GET
    // asks without the lock the decision takes.
    const canDecide =
      holdsApprove &&
      decidable &&
      (sheet.submittedBy !== userId ||
        (await this.permissions.isSolePrincipalForRead(schoolId, userId)));
    return {
      ...toSheetDto(sheet, { callerUserId: userId, names, ownChildFlags: flags }),
      source: stored ? 'stored' : 'preview',
      settings: {
        testWeight: sheet.termId === null ? null : (settings?.testWeight ?? null),
        examWeight: sheet.termId === null ? null : (settings?.examWeight ?? null),
        passPercent: settings?.passPercent ?? 0,
        passRule: settings?.passRule ?? 'all_subjects',
        snapshot: stored,
      },
      subjects: composition.subjects.map((s) => ({
        classSubjectId: s.classSubjectId.toString(),
        subjectName: s.subjectName,
        sortOrder: s.sortOrder,
      })),
      preview: composition.rows.map((row) =>
        toPreviewRow(
          row,
          missingByStudent.get(row.studentId) ?? 0,
          names,
          resultIds.get(row.enrolmentId) ?? null,
        ),
      ),
      flags: {
        cover: sheet.submittedUnderAssignmentId !== null,
        selfApproved: sheet.selfApproved,
        missing: composition.gaps.slice(0, MAX_GAPS).map(gapDto),
        missingCount: composition.gaps.length,
        examsNotSetUp: composition.examsNotSetUp.map((id) => id.toString()),
      },
      canRemark,
      canSubmit: canRemark && sheet.termId !== null,
      canDecide,
      canPublish:
        this.permissions.holds(access, Capability.RESULT_PUBLISH) && sheet.status === 'approved',
    };
  }

  /**
   * The live composition of a sheet not yet approved, with the year's live settings (a preview,
   * §3.3). The caller counts as the approver when they hold result.approve (the flag the inbox
   * shows is the one their approval would carry, R276).
   */
  async compose(
    session: SchoolSessionContext,
    scope: MarksScope,
    sheet: ResultSheetRecord,
    options: { attendance: boolean } = { attendance: true },
  ): Promise<Composition> {
    const schoolId = session.schoolId;
    const settings = await this.liveSettings(schoolId, sheet.academicYearId);
    const contributors = {
      remarks: await this.sheets.remarks(schoolId, sheet.id),
      submittedBy: sheet.submittedBy,
      approver: this.permissions.holds(session.access, Capability.RESULT_APPROVE)
        ? session.access.userId
        : null,
    };
    const yearTerms = await this.terms.allForYear(schoolId, sheet.academicYearId);
    if (sheet.termId === null) {
      const year = await this.years.findById(schoolId, sheet.academicYearId);
      if (!year) throw notFound();
      return this.composer.final(
        schoolId,
        scope,
        sheet,
        yearTerms,
        termWeightsOf(yearTerms, sheet.classId),
        year,
        settings,
        contributors,
      );
    }
    const term = yearTerms.find((t) => t.id === sheet.termId);
    if (!term) throw notFound();
    return this.composer.term(schoolId, scope, sheet, term, settings, contributors, options);
  }

  /** The year's live composition settings. */
  async liveSettings(schoolId: SchoolId, academicYearId: bigint): Promise<CompositionSettings> {
    const row = await this.settings.findForYear(schoolId, academicYearId);
    if (!row) throw notFound();
    return {
      testWeight: row.testWeight,
      examWeight: row.examWeight,
      passPercent: row.passPercent,
      passRule: row.passRule,
      bands: row.bands,
    };
  }

  // ----------------------------------------------------------------------------------- remarks

  /** §2.4: the given rows' term remarks (null clears one), draft or returned only. */
  @Transactional()
  async updateRemarks(
    session: SchoolSessionContext,
    id: bigint,
    dto: UpdateResultSheetDto,
  ): Promise<ResultSheetDetailDto> {
    const { schoolId, userId } = this.context.actor();
    const { scope, sheet } = await this.lock(session, id);
    if (sheet.status !== 'draft' && sheet.status !== 'returned') throw sheetNotDraft(sheet);
    if (!(await this.authorship(session, sheet.sectionId)).allowed) throw notClassTeacher();
    await requireOpenYear(this.years, schoolId, sheet.academicYearId);
    const seen = new Set<string>();
    dto.remarks.forEach((r, i) => {
      if (seen.has(r.enrolmentId)) {
        throw fieldRefused(
          `remarks[${i}].enrolmentId`,
          ErrorCode.INVALID_VALUE,
          'Each student appears once',
        );
      }
      seen.add(r.enrolmentId);
    });
    const onSheet = new Set((await this.rosterOf(schoolId, scope, sheet)).map((e) => e.toString()));
    dto.remarks.forEach((r, i) => {
      if (!onSheet.has(r.enrolmentId)) {
        throw fieldRefused(
          `remarks[${i}].enrolmentId`,
          ErrorCode.REFERENCE_NOT_FOUND,
          'Not a student on this sheet',
        );
      }
    });
    await this.sheets.writeRemarks(
      schoolId,
      sheet.id,
      userId,
      dto.remarks.map((r) => ({ enrolmentId: BigInt(r.enrolmentId), remark: r.remark })),
    );
    // A remark is a draft's text (R57: no audit row); the row records its writer.
    return this.detailOf(session, scope, sheet);
  }

  /** The enrolment ids on the sheet (in force on its roster date). */
  private async rosterOf(
    schoolId: SchoolId,
    scope: MarksScope,
    sheet: ResultSheetRecord,
  ): Promise<bigint[]> {
    const yearTerms = await this.terms.allForYear(schoolId, sheet.academicYearId);
    const on =
      sheet.termId === null
        ? (
            yearTerms.filter((t) => !t.skips.some((s) => s.classId === sheet.classId)).at(-1) ??
            yearTerms.at(-1)
          )?.endsOn
        : yearTerms.find((t) => t.id === sheet.termId)?.endsOn;
    if (!on) return [];
    const { roster } = await this.reads.enrolmentsForSheet(schoolId, scope, {
      classId: sheet.classId,
      sectionId: sheet.sectionId,
      on,
    });
    return roster.map((r) => r.enrolmentId);
  }

  // ------------------------------------------------------------------------------------ submit

  /**
   * §2.5 (R268): the class teacher (or cover; or, with no class teacher, an assessment.define
   * holder) submits a draft or returned term sheet when every student has a live mark or absence
   * for every assessment that applies to them and every class-subject has the section's exam;
   * the tests the sheet holds are locked, and its roster's marks of the class-term with them.
   */
  @Transactional()
  async submit(session: SchoolSessionContext, id: bigint): Promise<ResultSheetDetailDto> {
    const { schoolId, userId } = this.context.actor();
    const { scope, sheet } = await this.lock(session, id);
    if (sheet.termId === null) {
      throw new ApiException(
        409,
        ErrorCode.ILLEGAL_STATUS_TRANSITION,
        'The final sheet is approved directly; it is not submitted.',
        {
          sheetId: sheet.id.toString(),
        },
      );
    }
    if (sheet.status !== 'draft' && sheet.status !== 'returned') throw sheetNotDraft(sheet);
    const authorship = await this.authorship(session, sheet.sectionId);
    if (!authorship.allowed) throw notClassTeacher();
    await requireOpenYear(this.years, schoolId, sheet.academicYearId);
    const composition = await this.compose(session, scope, sheet, { attendance: false });
    const notSetUp = composition.examsNotSetUp[0];
    if (notSetUp !== undefined) throw examNotSetUp(notSetUp, sheet.sectionId, sheet.termId);
    if (composition.gaps.length > 0) throw marksIncomplete(composition.gaps);
    const now = this.clock.now();
    // §2.4: the submission locks every test the sheet holds (a moved student's old-section tests
    // included) and, through the roster, the roster's marks on every assessment of the class-term.
    const heldTestIds = composition.heldTestIds ?? [];
    const moved = await this.sheets.submit(schoolId, sheet.id, {
      submittedBy: userId,
      submittedAt: now,
      submittedUnderAssignmentId: authorship.coverAssignmentId,
    });
    if (moved !== 1) throw concurrentUpdate();
    const lockedTests = await this.sheets.lockSubmission(schoolId, sheet.id, {
      testIds: heldTestIds,
      studentIds: composition.rows.map((r) => r.studentId),
      at: now,
    });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'result_sheet.submitted',
      subjectType: SUBJECT,
      subjectId: sheet.id,
      metadata: {
        cover: authorship.coverAssignmentId !== null,
        assignmentId: authorship.coverAssignmentId?.toString() ?? null,
        lockedTests,
      },
    });
    return this.detail(session, sheet.id);
  }

  // ------------------------------------------------------------------------------------ return

  /**
   * §2.6 (R269): a result.approve holder returns a submitted or approved sheet with a reason;
   * from approved, that version's stored rows are superseded. The tests its submission locked
   * unlock, except those another submitted (or later) sheet still holds. The submitter never returns their own sheet, except the sole principal.
   */
  @Transactional()
  async return(
    session: SchoolSessionContext,
    id: bigint,
    reason: string,
  ): Promise<ResultSheetDetailDto> {
    const { schoolId, userId } = this.context.actor();
    const { sheet } = await this.lock(session, id);
    if (sheet.status !== 'submitted' && sheet.status !== 'approved') throw sheetNotSubmitted(sheet);
    if (sheet.submittedBy === userId && !(await this.permissions.isSolePrincipal(schoolId, userId)))
      throw selfDecision();
    await requireOpenYear(this.years, schoolId, sheet.academicYearId);
    const now = this.clock.now();
    const moved = await this.sheets.markReturned(schoolId, sheet.id, {
      decidedBy: userId,
      decidedAt: now,
      returnReason: reason,
    });
    if (moved !== 1) throw concurrentUpdate();
    const superseded =
      sheet.status === 'approved'
        ? await this.results.supersedeSheetRows(schoolId, sheet.id, now)
        : 0;
    const unlocked = await this.sheets.releaseSubmission(schoolId, sheet.id, now);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'result_sheet.returned',
      subjectType: SUBJECT,
      subjectId: sheet.id,
      reason,
      metadata: { from: sheet.status, supersededResults: superseded, unlockedTests: unlocked },
    });
    return this.detail(session, sheet.id);
  }

  // ----------------------------------------------------------------------------------- publish

  /**
   * §2.8 (R272, R273): a result.publish holder publishes an approved sheet; its rows become
   * visible to families and `result-notify` is enqueued after commit.
   */
  @Transactional()
  async publish(session: SchoolSessionContext, id: bigint): Promise<ResultSheetDetailDto> {
    const { schoolId, userId } = this.context.actor();
    const { sheet } = await this.lock(session, id);
    if (sheet.status !== 'approved') throw sheetNotApproved(sheet);
    await this.publishLocked(schoolId, userId, sheet);
    return this.detail(session, sheet.id);
  }

  /** The publication itself, under the caller's row lock (also the approval's, R272). */
  async publishLocked(
    schoolId: SchoolId,
    userId: bigint,
    sheet: Pick<ResultSheetRecord, 'id'>,
  ): Promise<number> {
    const now = this.clock.now();
    if (
      (await this.sheets.markPublished(schoolId, sheet.id, {
        publishedBy: userId,
        publishedAt: now,
      })) !== 1
    ) {
      throw concurrentUpdate();
    }
    const published = await this.results.publishSheetRows(schoolId, sheet.id, now);
    this.outbox.resultNotifyAfterCommit(schoolId, sheet.id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'result_sheet.published',
      subjectType: SUBJECT,
      subjectId: sheet.id,
      metadata: { results: published },
    });
    return published;
  }

  /**
   * R275: the final sheet is ready — the held weights sum to 100 and every held term of the year
   * is published for the section. Its term weights; else refused. Create and approve both ask.
   */
  async finalWeights(
    schoolId: SchoolId,
    sectionId: bigint,
    classId: bigint,
    yearTerms: readonly AcademicTermRecord[],
  ): Promise<TermWeight[]> {
    const weights = termWeightsOf(yearTerms, classId);
    assertHeldWeights(weights);
    const held = weights.filter((t) => t.held).map((t) => t.termId);
    const published = await this.sheets.publishedTermIds(schoolId, sectionId, held);
    const missing = held.filter((termId) => !published.has(termId));
    if (missing.length > 0) throw termsUnpublished(missing);
    return weights;
  }
}

/** The year's terms in order with their weights, and whether each is held for the class (A6). */
export function termWeightsOf(terms: readonly AcademicTermRecord[], classId: bigint): TermWeight[] {
  return [...terms]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((t) => ({
      termId: t.id,
      weight: t.weight,
      held: !t.skips.some((skip) => skip.classId === classId),
    }));
}

/**
 * The final sheet's weights (contracts/slice-29.md §2: an unequal sum is refused here): the year's
 * term weights sum to 100 and some held term weighs more than 0. A term not held for the class is
 * skipped and composeFinal renormalises over the terms assessed (A6), so a nursery class without
 * a mid-term still closes its year.
 */
export function assertHeldWeights(weights: readonly TermWeight[]): void {
  const total = weights.reduce((sum, t) => sum + t.weight, 0);
  const held = weights.filter((t) => t.held).reduce((sum, t) => sum + t.weight, 0);
  if (total !== 100 || held === 0) {
    throw fieldRefused(
      'termId',
      ErrorCode.INVALID_VALUE,
      "The year's term weights must sum to 100, with a held term weighing more than 0",
    );
  }
}

/** A sheet's stored snapshot as composition settings (approved and published sheets). */
export function snapshotSettings(sheet: ResultSheetRecord): CompositionSettings | null {
  const s = sheet.snapshot;
  if (s.passPercent === null || s.passRule === null || s.bands === null) return null;
  return {
    // The final sheet stores no component weights (it composes stored term results).
    testWeight: s.testWeight ?? 0,
    examWeight: s.examWeight ?? 0,
    passPercent: s.passPercent,
    passRule: s.passRule,
    bands: s.bands,
  };
}
