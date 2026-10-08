import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import {
  ApiException,
  concurrentUpdate,
  fieldRefused,
  notFound,
} from '../../common/errors/api-exception';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { readLocked } from '../../common/locking';
import { toPage, type Page } from '../../common/pagination';
import { SchoolClock } from '../../common/school-clock';
import { SchoolContext, type Actor } from '../../common/school-context';
import { AcademicYearRepository } from '../../repositories/academic-year.repository';
import {
  AssessmentRepository,
  type AssessmentRecord,
} from '../../repositories/assessment.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { MarkRepository, type CorrectionRecord } from '../../repositories/mark.repository';
import type { SchoolId } from '../../tenancy/school-id';
import type { MarksScope } from '../../tenancy/scope';
import { requireOpenYear, toDateString } from '../academics/academics.shared';
import { PermissionsService } from '../access/permissions.service';
import { ownChildCheck } from '../fees/fee-gates';
import { ResultCardsService } from '../results/result-cards.service';
import { ResultRevisionService } from '../results/result-revision.service';
import { marksDateOf } from './assessments.shared';
import type {
  CorrectMarkDto,
  ListMarkCorrectionsQueryDto,
  MarkCorrectionDecisionDto,
  MarkCorrectionDto,
} from './mark-corrections.dto';

// contracts/slice-32.md §1-§4 (phase-4-academic.md slice 32, R280, R281): a mark on a published
// result is corrected by request and decision. The request (marks.enter, the caller's write scope
// on held_on) is a `pending` row superseding the live mark; the decision (result.approve) is never
// the requester's, except the sole principal's (recorded selfApproved), and never on the
// decider's own child. Approval makes the row live and runs the cascade (ResultRevisionService):
// the term sheet's version n+1 and the published final's, and the corrected family told once.

const ENDPOINT = 'assessments';
const SUBJECT = 'mark';

const notPending = (id: bigint): ApiException =>
  new ApiException(409, ErrorCode.MARK_CORRECTION_NOT_PENDING, 'This correction has already been decided.', {
    markId: id.toString(),
  });

const sheetNotPublished = (id: bigint): ApiException =>
  new ApiException(
    409,
    ErrorCode.MARK_CORRECTION_SHEET_NOT_PUBLISHED,
    "A mark is corrected only once the student's result is published; until then the sheet is returned and the mark re-entered.",
    { markId: id.toString() },
  );

const alreadyPending = (id: bigint): ApiException =>
  new ApiException(
    409,
    ErrorCode.ILLEGAL_STATUS_TRANSITION,
    'A correction of this mark is already waiting for a decision.',
    { markId: id.toString() },
  );

const ownRequest = (): ApiException =>
  new ApiException(409, ErrorCode.SELF_ACTION_FORBIDDEN, 'You asked for this correction; someone else decides it.', {
    reason: 'author',
  });

const markExceedsMax = (max: number): ApiException =>
  new ApiException(409, ErrorCode.MARK_EXCEEDS_MAX, `A mark cannot exceed the maximum of ${max}.`, { max });

export interface CorrectionCreateOutcome {
  replayed: boolean;
  correction: MarkCorrectionDto;
}

@Injectable()
export class MarkCorrectionsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly assessments: AssessmentRepository,
    private readonly marks: MarkRepository,
    private readonly years: AcademicYearRepository,
    private readonly permissions: PermissionsService,
    private readonly revision: ResultRevisionService,
    private readonly cards: ResultCardsService,
    private readonly idempotency: IdempotentRequests,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
  ) {}

  // ----------------------------------------------------------------------------------- request

  /**
   * POST /marks/:id/correct (R280): the live mark, inside the caller's write scope of held_on
   * (else 404), on an assessment whose student's term result is published
   * (MARK_CORRECTION_SHEET_NOT_PUBLISHED otherwise); one pending correction per mark; a value
   * different from the live one. Keyed (endpoint `assessments`, path id the mark).
   */
  async request(
    session: SchoolSessionContext,
    markId: bigint,
    dto: CorrectMarkDto,
    rawKey: string | undefined,
  ): Promise<CorrectionCreateOutcome> {
    const actor = this.context.actor();
    const outcome = await this.idempotency.withIdempotencyKey(actor, ENDPOINT, markId, dto, rawKey, (claim) =>
      this.requestInTransaction(session, actor, markId, dto, claim),
    );
    if (outcome.replayed) return { replayed: true, correction: await this.get(session, outcome.subjectId) };
    return { replayed: false, correction: outcome.value };
  }

  @Transactional()
  private async requestInTransaction(
    session: SchoolSessionContext,
    actor: Actor,
    markId: bigint,
    dto: CorrectMarkDto,
    claim: IdempotencyClaim,
  ): Promise<MarkCorrectionDto> {
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, SUBJECT);
    const { schoolId, userId } = actor;
    const value = valueOf(dto);
    const { scope, row } = await this.lockedFor(session, markId);
    const mark = await this.marks.find(schoolId, scope, markId);
    if (!mark) throw notFound();
    if (mark.status !== 'live') {
      throw new ApiException(409, ErrorCode.ILLEGAL_STATUS_TRANSITION, 'Only the live mark is corrected.', {
        markId: markId.toString(),
      });
    }
    if (row.voidedAt !== null) {
      throw new ApiException(409, ErrorCode.ASSESSMENT_VOIDED, 'This assessment has been voided.', {
        assessmentId: row.id.toString(),
      });
    }
    await requireOpenYear(this.years, schoolId, row.academicYearId);
    const published = await this.revision.publishedTermResultOf(schoolId, {
      studentId: mark.studentId,
      classId: row.classId,
      termId: row.termId,
    });
    if (!published) throw sheetNotPublished(markId);
    if (value.obtained !== null && value.obtained > row.maxMarks) throw markExceedsMax(row.maxMarks);
    if (mark.obtained === value.obtained && mark.absent === value.absent && !mark.excused) {
      throw fieldRefused('obtained', ErrorCode.INVALID_VALUE, 'The correction must change the mark');
    }
    if ((await this.marks.pendingFor(schoolId, scope, row.id, mark.enrolmentId)) !== null) throw alreadyPending(markId);
    const pending = await this.marks.insertPending(schoolId, scope, row, {
      enrolmentId: mark.enrolmentId,
      studentId: mark.studentId,
      ...value,
      supersedesId: mark.id,
      correctionReason: dto.reason,
      enteredBy: userId,
    });
    await recordSubject(pending.id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'mark_correction.requested',
      subjectType: SUBJECT,
      subjectId: pending.id,
      reason: dto.reason,
      metadata: {
        assessmentId: row.id.toString(),
        supersedesId: mark.id.toString(),
        enrolmentId: mark.enrolmentId.toString(),
      },
    });
    return this.get(session, pending.id);
  }

  // ------------------------------------------------------------------------------------- reads

  /**
   * GET /mark-corrections: the caller's read scope of today — marks.enter, marks.view_all or
   * result.approve (a decider reads what they decide, slice 36); newest request first.
   */
  async list(session: SchoolSessionContext, query: ListMarkCorrectionsQueryDto): Promise<Page<MarkCorrectionDto>> {
    const schoolId = session.schoolId;
    const scope = await this.permissions.sheetReadScopeOf(session, await this.clock.today(schoolId));
    if (!scope) return toPage([], query, 0);
    const { rows, total } = await this.marks.listCorrections(
      schoolId,
      scope,
      {
        ...(query.status === undefined ? {} : { state: query.status }),
        ...(query.sectionId === undefined ? {} : { sectionId: BigInt(query.sectionId) }),
        ...(query.termId === undefined ? {} : { termId: BigInt(query.termId) }),
      },
      { skip: (query.page - 1) * query.limit, take: query.limit },
    );
    return toPage(await this.toDtos(session, rows), query, total);
  }

  /** GET /mark-corrections/:id: read under the scope of the assessment's held_on. */
  async get(session: SchoolSessionContext, id: bigint): Promise<MarkCorrectionDto> {
    const schoolId = session.schoolId;
    const dates = await this.marks.scopeDatesOf(schoolId, id);
    const on = dates && marksDateOf(dates, await this.clock.today(schoolId));
    const scope = on && (await this.permissions.sheetReadScopeOf(session, on));
    const row = scope ? await this.marks.findCorrection(schoolId, scope, id) : null;
    if (!row) throw notFound();
    const [dto] = await this.toDtos(session, [row]);
    if (!dto) throw notFound();
    return dto;
  }

  // ------------------------------------------------------------------------------- decisions

  /**
   * POST /mark-corrections/:id/approve (R280, R281): pending only; never the requester (except
   * the sole principal, recorded selfApproved); never the decider's own child. The live mark is
   * superseded, the correction becomes live, and the results are revised in the same transaction.
   */
  @Transactional()
  async approve(session: SchoolSessionContext, id: bigint): Promise<MarkCorrectionDecisionDto> {
    const { schoolId, userId } = this.context.actor();
    const { scope, row, mark } = await this.decidable(session, id);
    const selfRequest = await this.notOwnRequest(schoolId, userId, mark.enteredBy);
    const ownChild = await ownChildCheck(this.permissions, session, schoolId, mark.studentId);
    const now = this.clock.now();
    // The mark it corrects must still be the live one (an excusal may have replaced it).
    if (mark.supersedesId === null || !(await this.marks.supersede(schoolId, scope, row, mark.supersedesId))) {
      throw concurrentUpdate();
    }
    if (!(await this.marks.decide(schoolId, scope, row, mark.id, { status: 'live', by: userId, at: now }))) {
      throw notPending(id);
    }
    const revision = await this.revision.revise(
      session,
      { studentId: mark.studentId, classId: row.classId, termId: row.termId },
      userId,
    );
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'mark_correction.approved',
      subjectType: SUBJECT,
      subjectId: mark.id,
      metadata: {
        assessmentId: row.id.toString(),
        supersedesId: mark.supersedesId.toString(),
        enrolmentId: mark.enrolmentId.toString(),
        resultId: revision.resultId.toString(),
        termSheetId: revision.termSheetId.toString(),
        finalSheetId: revision.finalSheetId?.toString() ?? null,
        revised: revision.revised,
        // Each sole-principal exception on its own (R281), and whether any applied.
        selfRequest,
        ownChild,
        selfSubmitter: revision.selfApproved,
        selfApproved: selfRequest || ownChild || revision.selfApproved,
      },
    });
    const [revisedResult] = await this.cards.cards(schoolId, [revision.resultId]);
    if (!revisedResult) throw notFound();
    return { mark: await this.get(session, id), revisedResult };
  }

  /** POST /mark-corrections/:id/reject: pending only; never on the decider's own child; the reason audited. */
  @Transactional()
  async reject(session: SchoolSessionContext, id: bigint, reason: string): Promise<MarkCorrectionDto> {
    const { schoolId, userId } = this.context.actor();
    const { scope, row, mark } = await this.decidable(session, id);
    const selfApproved = await ownChildCheck(this.permissions, session, schoolId, mark.studentId);
    if (!(await this.marks.decide(schoolId, scope, row, mark.id, { status: 'rejected', by: userId, at: this.clock.now() }))) {
      throw notPending(id);
    }
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'mark_correction.rejected',
      subjectType: SUBJECT,
      subjectId: mark.id,
      reason,
      metadata: {
        assessmentId: row.id.toString(),
        enrolmentId: mark.enrolmentId.toString(),
        selfApproved,
      },
    });
    return this.get(session, id);
  }

  /**
   * POST /mark-corrections/:id/withdraw (contracts/slice-32.md §4): the requester takes back their
   * own pending correction — `rejected`, decided by them, audited `mark_correction.withdrawn`
   * with the reason. Anyone else's correction is 404 here (they decide it, or cannot see it).
   */
  @Transactional()
  async withdraw(session: SchoolSessionContext, id: bigint, reason: string): Promise<MarkCorrectionDto> {
    const { schoolId, userId } = this.context.actor();
    const { scope, row, mark } = await this.decidable(session, id);
    if (mark.enteredBy !== userId) throw notFound();
    if (!(await this.marks.decide(schoolId, scope, row, mark.id, { status: 'rejected', by: userId, at: this.clock.now() }))) {
      throw notPending(id);
    }
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'mark_correction.withdrawn',
      subjectType: SUBJECT,
      subjectId: mark.id,
      reason,
      metadata: {
        assessmentId: row.id.toString(),
        enrolmentId: mark.enrolmentId.toString(),
        withdrawn: true,
      },
    });
    return this.get(session, id);
  }

  // ---------------------------------------------------------------------------------- helpers

  /** The correction and its assessment under the assessment's row lock, pending, the year open. */
  private async decidable(
    session: SchoolSessionContext,
    id: bigint,
  ): Promise<{ scope: MarksScope<'write'>; row: AssessmentRecord; mark: CorrectionRecord }> {
    const schoolId = session.schoolId;
    const { scope, row } = await this.lockedFor(session, id, 'decision');
    const mark = await this.marks.findCorrection(schoolId, scope, id);
    if (!mark) throw notFound();
    if (mark.state !== 'pending') throw notPending(id);
    await requireOpenYear(this.years, schoolId, row.academicYearId);
    return { scope, row, mark };
  }

  /**
   * The mark's assessment, locked, inside the caller's scope on its marks date; else 404. A
   * request is scoped by marks.enter; a decision by marks.enter or result.approve (slice 36).
   */
  private async lockedFor(
    session: SchoolSessionContext,
    markId: bigint,
    as: 'request' | 'decision' = 'request',
  ): Promise<{ scope: MarksScope<'write'>; row: AssessmentRecord }> {
    const schoolId = session.schoolId;
    const dates = await this.marks.scopeDatesOf(schoolId, markId);
    const on = dates && marksDateOf(dates, await this.clock.today(schoolId));
    const scope =
      on &&
      (as === 'decision'
        ? await this.permissions.marksDecisionScopeOf(session, on)
        : await this.permissions.marksWriteScopeOf(session, on));
    if (!scope) throw notFound();
    const found = await this.marks.find(schoolId, scope, markId);
    if (!found) throw notFound();
    const row = await readLocked(
      () => this.assessments.findWritable(schoolId, scope, found.assessmentId),
      (r) => this.assessments.lockIfUnchanged(schoolId, scope, r),
    );
    return { scope, row };
  }

  /** R281: the requester never decides, except the sole principal (true: recorded selfApproved). */
  private async notOwnRequest(schoolId: SchoolId, userId: bigint, requester: bigint): Promise<boolean> {
    if (requester !== userId) return false;
    if (await this.permissions.isSolePrincipal(schoolId, userId)) return true;
    throw ownRequest();
  }

  private async toDtos(session: SchoolSessionContext, rows: readonly CorrectionRecord[]): Promise<MarkCorrectionDto[]> {
    const names = await this.marks.names(
      session.schoolId,
      rows.flatMap((r) => [r.enteredBy, ...(r.decidedBy === null ? [] : [r.decidedBy])]),
    );
    const me = session.access.userId;
    return rows.map((r) => ({
      id: r.id.toString(),
      status: r.state,
      assessmentId: r.assessmentId.toString(),
      assessmentName: r.assessmentName,
      kind: r.kind,
      subjectName: r.subjectName,
      heldOn: toDateString(r.heldOn),
      classId: r.classId.toString(),
      className: r.className,
      sectionId: r.sectionId.toString(),
      sectionName: r.sectionName,
      termId: r.termId.toString(),
      termName: r.termName,
      enrolmentId: r.enrolmentId.toString(),
      studentId: r.studentId.toString(),
      studentName: r.studentName,
      admissionNo: r.admissionNo,
      maxMarks: r.maxMarks,
      from: r.from,
      to: { obtained: r.obtained, absent: r.absent, excused: r.excused },
      reason: r.correctionReason ?? '',
      requestedByName: names.get(r.enteredBy) ?? '',
      requestedByMe: r.enteredBy === me,
      requestedAt: r.enteredAt,
      decidedByName: r.decidedBy === null ? null : (names.get(r.decidedBy) ?? ''),
      decidedAt: r.decidedAt,
      withdrawn: r.state === 'rejected' && r.decidedBy === r.enteredBy,
    }));
  }
}

/** What a correction asks for: a mark, or an absence (exactly one, else 422). */
function valueOf(dto: CorrectMarkDto): { obtained: number | null; absent: boolean } {
  const hasMark = dto.obtained !== undefined && dto.obtained !== null;
  if (hasMark === (dto.absent === true)) {
    throw fieldRefused('obtained', ErrorCode.INVALID_VALUE, 'Give a mark, or absent: true, not both');
  }
  return hasMark ? { obtained: dto.obtained ?? null, absent: false } : { obtained: null, absent: true };
}
