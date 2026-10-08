import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { Capability, ErrorCode, type PromotionOutcome } from '@asms/shared';
import { scopeOf, type SchoolSessionContext } from '../../common/auth/school-session';
import {
  ApiException,
  concurrentUpdate,
  fieldRefused,
  notFound,
  ownChild,
} from '../../common/errors/api-exception';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { readLocked } from '../../common/locking';
import { toPage, type Page } from '../../common/pagination';
import { SchoolClock } from '../../common/school-clock';
import { SchoolContext, type Actor } from '../../common/school-context';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import {
  PromotionRepository,
  type DecisionCreate,
  type PromotionSection,
  type PromotionSheetRecord,
  type PromotionYear,
  type TargetClass,
} from '../../repositories/promotion.repository';
import type { SchoolId } from '../../tenancy/school-id';
import type { Scope } from '../../tenancy/scope';
import { toDateString, yearClosed } from '../academics/academics.shared';
import { isPrincipal, requirePrincipal } from '../access/money-gates';
import { PermissionsService } from '../access/permissions.service';
import { FinanceReportsService } from '../finance-reports/finance-reports.service';
import { EnrolmentsService, type EnrolmentTarget } from '../people/students/enrolments.service';
import { StudentsService } from '../people/students/students.service';
import type {
  ListPromotionSheetsQueryDto,
  OpenPromotionSheetDto,
  PromotionDecisionDto,
  PromotionDecisionInputDto,
  PromotionSheetDetailDto,
  PromotionSheetDto,
  UpdatePromotionSheetDto,
} from './promotion.dto';

// phase-4-academic.md slice 35 (R294-R300, §1.1 rule 30, §3.2 "Promotion", §7.1);
// contracts/slice-35.md. Enrolments are written only through EnrolmentsService and statuses only
// through StudentsService (withdrawForPromotion, promote) (§5.1); dues are read only through
// FinanceReportsService.clearance. The database holds the same lines (migration
// 20261008170000_wave_p_promotion); the service refuses first, with the contract's codes.

const ENDPOINT = 'promotion_sheets';
const SUBJECT = 'promotion_sheet';
const TARGETED: readonly PromotionOutcome[] = ['promote', 'detain'];
/** The reasons apply records on a status change when the row carried none (the proposal stood). */
const COMPLETED_REASON = 'Completed the final class (promotion)';

export interface PromotionSheetOutcome {
  replayed: boolean;
  sheet: PromotionSheetDetailDto;
}

const sheetRefusal = (code: ErrorCode, message: string) => (sheetId: bigint) =>
  new ApiException(409, code, message, { sheetId: sheetId.toString() });

const sheetOpen = sheetRefusal(ErrorCode.PROMOTION_SHEET_OPEN, 'This section already has an open promotion sheet.');
const sheetNotOpen = sheetRefusal(
  ErrorCode.PROMOTION_SHEET_NOT_OPEN,
  'This promotion sheet is no longer open: it has been applied or cancelled.',
);

const byEnrolment = (code: ErrorCode, message: string) => (rows: readonly { enrolmentId: bigint }[]) =>
  new ApiException(409, code, message, { enrolmentIds: rows.map((r) => r.enrolmentId.toString()) });

const incomplete = byEnrolment(ErrorCode.PROMOTION_INCOMPLETE, 'Decide every student on the sheet before applying it.');
const resultSuperseded = byEnrolment(
  ErrorCode.PROMOTION_RESULT_SUPERSEDED,
  'A result on this sheet was corrected since it was read: decide those students again.',
);
const enrolmentAfterYear = byEnrolment(
  ErrorCode.PROMOTION_ENROLMENT_AFTER_YEAR,
  "An enrolment on this sheet starts after the year's end, so it cannot close at it: correct its dates first.",
);
const studentsNotActive = byEnrolment(
  ErrorCode.STUDENT_NOT_ACTIVE,
  'A student who is not continuing must be active: reactivate a suspended student first.',
);

/** PROMOTION_TARGET_INVALID { reason } (R298). */
const TARGET_MESSAGES = {
  other_year: 'The class to move into belongs to another academic year.',
  archived: 'The class or section to move into is archived.',
  no_target: 'Choose the class and section to move into.',
  not_final: 'Only a final class completes: decide promote or detain instead.',
} as const;

const targetInvalid = (reason: keyof typeof TARGET_MESSAGES, extra: Record<string, string | string[]> = {}) =>
  new ApiException(409, ErrorCode.PROMOTION_TARGET_INVALID, TARGET_MESSAGES[reason], { reason, ...extra });

const statusChangeNeeded = (): ApiException =>
  new ApiException(403, ErrorCode.PERMISSION_DENIED, 'Marking a student as not continuing needs the student status permission.', {
    reason: 'capability_not_held',
    capabilities: [Capability.STUDENT_STATUS_CHANGE],
  });

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A section of `klass` for a student now in `sectionName`: the same name, else the only one. */
function pickSection(klass: TargetClass, sectionName: string): bigint | null {
  const named = klass.sections.find((s) => sameName(s.name, sectionName));
  if (named) return named.id;
  return klass.sections.length === 1 ? (klass.sections[0]?.id ?? null) : null;
}

/** The class a decision moves into by default (rule 30): the next class, or this class's namesake. */
function defaultTargetClass(
  decision: PromotionOutcome,
  section: PromotionSection,
  targets: readonly TargetClass[],
): TargetClass | null {
  const live = targets.filter((c) => c.status === 'active');
  if (decision === 'promote') return live.find((c) => c.id === section.nextClassId) ?? null;
  if (decision === 'detain') return live.find((c) => sameName(c.name, section.className)) ?? null;
  return null;
}

/** §1.1 rule 30: passed → complete (final class) or promote; failed → detain; no verdict → none. */
function proposalFor(passed: boolean | null | undefined, section: PromotionSection): PromotionOutcome | null {
  if (passed === true) return section.isFinal ? 'complete' : 'promote';
  if (passed === false) return 'detain';
  return null;
}

@Injectable()
export class PromotionService {
  constructor(
    private readonly context: SchoolContext,
    private readonly promotion: PromotionRepository,
    private readonly enrolments: EnrolmentsService,
    private readonly students: StudentsService,
    private readonly dues: FinanceReportsService,
    private readonly permissions: PermissionsService,
    private readonly idempotency: IdempotentRequests,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
  ) {}

  // ---------------------------------------------------------------------------------- reads

  async list(session: SchoolSessionContext, query: ListPromotionSheetsQueryDto): Promise<Page<PromotionSheetDto>> {
    const schoolId = this.context.schoolId;
    const { rows, total } = await this.promotion.list(schoolId, scopeOf(session), {
      ...(query.academicYearId === undefined ? {} : { academicYearId: BigInt(query.academicYearId) }),
      ...(query.sectionId === undefined ? {} : { sectionId: BigInt(query.sectionId) }),
      ...(query.status === undefined ? {} : { status: query.status }),
      descending: (query.sort ?? '-openedAt') === '-openedAt',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const names = await this.promotion.names(
      schoolId,
      rows.flatMap((r) => (r.appliedBy === null ? [r.openedBy] : [r.openedBy, r.appliedBy])),
    );
    return toPage(
      rows.map((r) => this.toSheetDto(r, r.rows, r.undecided, names)),
      query,
      total,
    );
  }

  async detail(session: SchoolSessionContext, id: bigint): Promise<PromotionSheetDetailDto> {
    const schoolId = this.context.schoolId;
    const sheet = await this.promotion.findById(schoolId, scopeOf(session), id);
    if (!sheet) throw notFound();
    return this.toDetail(schoolId, sheet);
  }

  // ----------------------------------------------------------------------------------- open

  /** R294. Keyed (endpoint `promotion_sheets`, path id the section): a replay answers 200. */
  async open(
    session: SchoolSessionContext,
    sectionId: bigint,
    dto: OpenPromotionSheetDto,
    rawKey: string | undefined,
  ): Promise<PromotionSheetOutcome> {
    const actor = this.context.actor();
    const outcome = await this.idempotency.withIdempotencyKey(actor, ENDPOINT, sectionId, dto, rawKey, (claim) =>
      this.openInTransaction(session, actor, sectionId, dto, claim),
    );
    if (outcome.replayed) return { replayed: true, sheet: await this.detail(session, outcome.subjectId) };
    return { replayed: false, sheet: outcome.value };
  }

  @Transactional()
  private async openInTransaction(
    session: SchoolSessionContext,
    actor: Actor,
    sectionId: bigint,
    dto: OpenPromotionSheetDto,
    claim: IdempotencyClaim,
  ): Promise<PromotionSheetDetailDto> {
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, SUBJECT);
    const { schoolId, userId } = actor;
    const section = await this.promotion.section(schoolId, scopeOf(session), sectionId);
    if (!section) throw notFound();
    const open = await this.promotion.findOpenForSection(schoolId, sectionId);
    if (open) throw sheetOpen(open.id);

    const year = await this.requireYear(schoolId, section.academicYearId);
    if (year.status === 'closed') throw yearClosed();
    const targetYearId = BigInt(dto.targetYearId);
    const targetYear = await this.promotion.year(schoolId, targetYearId);
    if (!targetYear) throw fieldRefused('targetYearId', ErrorCode.REFERENCE_NOT_FOUND, 'No such academic year');
    if (targetYearId === year.id) {
      throw fieldRefused('targetYearId', ErrorCode.INVALID_VALUE, 'Promotion moves students into another academic year');
    }
    if (targetYear.status === 'closed') throw yearClosed();

    // A7: the final sheet, or the only held term's when the year holds one for the class.
    const termId = await this.sourceTerm(schoolId, section);
    if (termId !== undefined && !(await this.promotion.sourceSheetDecided(schoolId, sectionId, termId))) {
      throw new ApiException(
        409,
        ErrorCode.PROMOTION_FINAL_NOT_APPROVED,
        termId === null
          ? 'Approve the section’s final result before opening its promotion sheet.'
          : 'Approve the section’s term result before opening its promotion sheet.',
        { sectionId: sectionId.toString() },
      );
    }

    // The next class must be of the target year and live (the schema lets it point anywhere).
    const targets = await this.promotion.classesOfYear(schoolId, targetYearId);
    if (section.nextClassId !== null) {
      const next = targets.find((c) => c.id === section.nextClassId);
      if (!next) throw targetInvalid('other_year', { classId: section.classId.toString() });
      if (next.status !== 'active') throw targetInvalid('archived', { classId: section.classId.toString() });
    }

    const roster = await this.promotion.roster(schoolId, sectionId, year.id);
    const results = new Map(
      termId === undefined
        ? []
        : (await this.promotion.liveResults(schoolId, roster.map((r) => r.enrolmentId), termId)).map((r) => [r.enrolmentId, r]),
    );
    const decisions: DecisionCreate[] = [];
    let arrears = 0;
    for (const row of roster) {
      const result = results.get(row.enrolmentId);
      const proposed = proposalFor(result?.passed, section);
      const klass = proposed === null ? null : defaultTargetClass(proposed, section, targets);
      const targetSectionId = klass === null ? null : pickSection(klass, section.name);
      // A proposal with its whole target (or none needed) stands as the decision until changed.
      const complete = proposed !== null && (!TARGETED.includes(proposed) || targetSectionId !== null);
      // R294: arrears from the dues endpoint, a flag only.
      const arrearsFlag = (await this.dues.clearance(row.studentId)).outstanding > 0;
      if (arrearsFlag) arrears += 1;
      decisions.push({
        enrolmentId: row.enrolmentId,
        studentId: row.studentId,
        resultId: result?.id ?? null,
        proposed,
        decision: complete ? proposed : null,
        targetClassId: klass?.id ?? null,
        targetSectionId,
        arrearsFlag,
      });
    }
    const id = await this.promotion.create(
      schoolId,
      { academicYearId: year.id, classId: section.classId, sectionId, targetYearId, openedBy: userId },
      decisions,
    );
    await recordSubject(id);
    const count = (outcome: PromotionOutcome) => decisions.filter((d) => d.proposed === outcome).length;
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'promotion_sheet.opened',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: {
        sectionId: sectionId.toString(),
        targetYearId: targetYearId.toString(),
        source: termId === undefined ? 'none' : termId === null ? 'final' : termId.toString(),
        rows: decisions.length,
        proposed: {
          promote: count('promote'),
          detain: count('detain'),
          complete: count('complete'),
          none: decisions.filter((d) => d.proposed === null).length,
        },
        arrears,
      },
    });
    const sheet = await this.promotion.findById(schoolId, scopeOf(session), id);
    if (!sheet) throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    return this.toDetail(schoolId, sheet);
  }

  // --------------------------------------------------------------------------------- decide

  /**
   * R295, R298: the given rows only, on an open sheet under its row lock. Each row re-reads its
   * result (a correction since opening re-proposes it); a decision other than the proposal, or
   * with none, needs a reason; promote and detain need a live class of the target year and a live
   * section of it; not_continuing needs student.status.change and an active student. A decision
   * other than the proposal (or with none) for the actor's own child is refused
   * (SELF_ACTION_FORBIDDEN own_child) unless they are the sole principal (recorded selfApproved);
   * every own-child row is flagged in the audit (slice 36).
   */
  @Transactional()
  async decide(session: SchoolSessionContext, id: bigint, dto: UpdatePromotionSheetDto): Promise<PromotionSheetDetailDto> {
    const { schoolId, userId } = this.context.actor();
    const scope = scopeOf(session);
    const sheet = await this.lockSheet(schoolId, scope, id);
    if (sheet.status !== 'open') throw sheetNotOpen(id);
    const year = await this.requireYear(schoolId, sheet.academicYearId);
    if (year.status === 'closed') throw yearClosed();

    const rows = new Map((await this.promotion.decisions(schoolId, id)).map((r) => [r.enrolmentId, r]));
    const seen = new Set<string>();
    dto.decisions.forEach((input, i) => {
      if (seen.has(input.enrolmentId)) {
        throw fieldRefused(`decisions[${i}].enrolmentId`, ErrorCode.INVALID_VALUE, 'Each student is decided once per request');
      }
      seen.add(input.enrolmentId);
      if (!rows.has(BigInt(input.enrolmentId))) {
        throw fieldRefused(`decisions[${i}].enrolmentId`, ErrorCode.REFERENCE_NOT_FOUND, 'That student is not on this sheet');
      }
    });
    if (dto.decisions.some((d) => d.decision === 'not_continuing') && !(await this.holdsStatusChange(session, sheet.sectionId))) {
      throw statusChangeNeeded();
    }

    const section = await this.promotion.section(schoolId, scope, sheet.sectionId);
    if (!section) throw notFound();
    const termId = await this.sourceTerm(schoolId, section);
    const targets = await this.promotion.classesOfYear(schoolId, sheet.targetYearId);
    const now = new Date();
    // Audit metadata holds no arrays: the rows by enrolment id.
    const changes: Record<string, Record<string, string | null>> = {};
    let selfApproved = false;
    for (const [i, input] of dto.decisions.entries()) {
      const row = rows.get(BigInt(input.enrolmentId));
      if (!row) throw notFound();
      // The re-read (R298): the live result now, and the proposal it makes.
      const [result] =
        termId === undefined ? [] : await this.promotion.liveResults(schoolId, [row.enrolmentId], termId);
      const proposed = proposalFor(result?.passed, section);
      const reason = input.reason ?? null;
      if (input.decision !== proposed && reason === null) {
        throw fieldRefused(
          `decisions[${i}].reason`,
          ErrorCode.INVALID_VALUE,
          proposed === null
            ? 'Give a reason: there is no proposal for this student'
            : 'Give a reason for deciding differently from the proposal',
        );
      }
      if (input.decision === 'complete' && !section.isFinal) {
        throw fieldRefused(`decisions[${i}].decision`, ErrorCode.INVALID_VALUE, 'Only a final class completes');
      }
      if (input.decision === 'not_continuing' && row.studentStatus !== 'active') {
        throw studentsNotActive([row]);
      }
      const isOwnChild = await this.permissions.actorIsGuardianOf(schoolId, userId, row.studentId);
      if (isOwnChild && input.decision !== proposed) {
        if (!(isPrincipal(session) && (await this.permissions.isSolePrincipal(schoolId, userId)))) throw ownChild();
        selfApproved = true;
      }
      const target = this.resolveTarget(i, input, section, targets);
      await this.promotion.updateDecision(schoolId, row.id, {
        resultId: result?.id ?? null,
        proposed,
        decision: input.decision,
        reason,
        targetClassId: target?.classId ?? null,
        targetSectionId: target?.sectionId ?? null,
        decidedBy: userId,
        decidedAt: now,
      });
      changes[row.enrolmentId.toString()] = {
        from: row.decision,
        to: input.decision,
        proposed,
        reason,
        targetClassId: target?.classId.toString() ?? null,
        targetSectionId: target?.sectionId.toString() ?? null,
        ...(isOwnChild ? { ownChild: 'true' } : {}),
      };
    }
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'promotion_sheet.decided',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { decisions: changes, ...(selfApproved ? { selfApproved: true } : {}) },
    });
    return this.toDetail(schoolId, sheet);
  }

  /** promote and detain: the given (or default) class of the target year, live, and a live section of it. */
  private resolveTarget(
    i: number,
    input: PromotionDecisionInputDto,
    section: PromotionSection,
    targets: readonly TargetClass[],
  ): { classId: bigint; sectionId: bigint } | null {
    if (!TARGETED.includes(input.decision)) {
      if (input.targetClassId !== undefined || input.targetSectionId !== undefined) {
        throw fieldRefused(`decisions[${i}].targetClassId`, ErrorCode.INVALID_VALUE, 'Only promote and detain move into a class');
      }
      return null;
    }
    let klass: TargetClass | null;
    if (input.targetClassId === undefined) {
      klass = defaultTargetClass(input.decision, section, targets);
      if (!klass) {
        throw fieldRefused(`decisions[${i}].targetClassId`, ErrorCode.INVALID_VALUE, 'Choose the class to move into');
      }
    } else {
      const classId = BigInt(input.targetClassId);
      klass = targets.find((c) => c.id === classId) ?? null;
      if (!klass) throw targetInvalid('other_year', { classId: input.targetClassId });
      if (klass.status !== 'active') throw targetInvalid('archived', { classId: input.targetClassId });
    }
    let sectionId: bigint | null;
    if (input.targetSectionId === undefined) {
      sectionId = pickSection(klass, section.name);
      if (sectionId === null) {
        throw fieldRefused(`decisions[${i}].targetSectionId`, ErrorCode.INVALID_VALUE, 'Choose the section to move into');
      }
    } else {
      sectionId = BigInt(input.targetSectionId);
      if (!klass.sections.some((s) => s.id === sectionId)) {
        throw fieldRefused(`decisions[${i}].targetSectionId`, ErrorCode.REFERENCE_NOT_FOUND, 'No such live section of that class');
      }
    }
    return { classId: klass.id, sectionId };
  }

  // ---------------------------------------------------------------------------------- apply

  /** R297. Keyed (endpoint `promotion_sheets`, path id the sheet): a replay answers 200 with the sheet. */
  async apply(
    session: SchoolSessionContext,
    id: bigint,
    rawKey: string | undefined,
  ): Promise<PromotionSheetOutcome> {
    const actor = this.context.actor();
    const outcome = await this.idempotency.withIdempotencyKey(actor, ENDPOINT, id, {}, rawKey, (claim) =>
      this.applyInTransaction(session, actor, id, claim),
    );
    if (outcome.replayed) return { replayed: true, sheet: await this.detail(session, outcome.subjectId) };
    return { replayed: false, sheet: outcome.value };
  }

  @Transactional()
  private async applyInTransaction(
    session: SchoolSessionContext,
    actor: Actor,
    id: bigint,
    claim: IdempotencyClaim,
  ): Promise<PromotionSheetDetailDto> {
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, SUBJECT);
    const { schoolId, userId } = actor;
    const scope = scopeOf(session);
    const sheet = await this.lockSheet(schoolId, scope, id);
    if (sheet.status !== 'open') throw sheetNotOpen(id);
    const year = await this.requireYear(schoolId, sheet.academicYearId);
    if (year.status === 'closed') throw yearClosed();
    const targetYear = await this.requireYear(schoolId, sheet.targetYearId);
    if (targetYear.status === 'closed') throw yearClosed();

    const section = await this.promotion.section(schoolId, scope, sheet.sectionId);
    if (!section) throw notFound();

    // R298: the rows' results held still while apply runs (see lockResults), then the rows read.
    await this.promotion.lockResults(schoolId, id);
    const rows = await this.promotion.decisions(schoolId, id);
    const live = rows.filter((r) => r.enrolmentStatus === 'active');
    const undecided = live.filter((r) => r.decision === null);
    if (undecided.length > 0) throw incomplete(undecided);
    const superseded = live.filter((r) => r.resultSuperseded);
    if (superseded.length > 0) throw resultSuperseded(superseded);
    // R295: only a final class completes (decide refuses it; a class's flag may change since).
    const notFinal = section.isFinal ? [] : live.filter((r) => r.decision === 'complete');
    if (notFinal.length > 0) {
      throw targetInvalid('not_final', { enrolmentIds: notFinal.map((r) => r.enrolmentId.toString()) });
    }
    // An enrolment cannot close on a year's end it starts after (enrolments_ended_check).
    const late = live.filter((r) => r.enrolmentStartedOn > year.endsOn);
    if (late.length > 0) throw enrolmentAfterYear(late);
    const leaving = live.filter((r) => r.decision === 'not_continuing');
    if (leaving.length > 0) {
      if (!(await this.holdsStatusChange(session, sheet.sectionId))) throw statusChangeNeeded();
      const inactive = leaving.filter((r) => r.studentStatus !== 'active');
      if (inactive.length > 0) throw studentsNotActive(inactive);
    }
    // R298: the targets re-checked and locked once each (section, class, target year).
    const targets = await this.promotion.classesOfYear(schoolId, sheet.targetYearId);
    const locked = new Map<bigint, EnrolmentTarget>();
    for (const row of live.filter((r) => r.decision !== null && TARGETED.includes(r.decision))) {
      const klass = targets.find((c) => c.id === row.targetClassId);
      if (row.targetClassId === null || row.targetSectionId === null) {
        throw targetInvalid('no_target', { enrolmentIds: [row.enrolmentId.toString()] });
      }
      if (!klass) throw targetInvalid('other_year', { enrolmentIds: [row.enrolmentId.toString()] });
      if (klass.status !== 'active' || !klass.sections.some((s) => s.id === row.targetSectionId)) {
        throw targetInvalid('archived', { enrolmentIds: [row.enrolmentId.toString()] });
      }
      if (!locked.has(row.targetSectionId)) {
        locked.set(row.targetSectionId, await this.enrolments.lockTarget(schoolId, klass.id, row.targetSectionId));
      }
    }

    // Statuses take effect on min(today, the year's end) — raised per student to their enrolment's
    // start or last status change when later, never in the future (contracts/slice-35.md §3);
    // enrolments close on the year's end and the new ones start on the target year's first day.
    const today = await this.clock.today(schoolId);
    const effectiveOn = toDateString(today < year.endsOn ? today : year.endsOn);
    const appliedAt = new Date();
    const skipped: Record<string, string> = {};
    for (const row of rows) {
      if (row.enrolmentStatus !== 'active') skipped[row.enrolmentId.toString()] = `enrolment ${row.enrolmentStatus}`;
    }
    // 1. The withdrawals: the status route's own, the enrolment closing as `left`.
    for (const row of leaving) {
      await this.students.withdrawForPromotion(scope, row.studentId, effectiveOn, row.reason ?? 'Not continuing');
    }
    // 2. The completions become alumni while their enrolment is still active, so a
    //    section-scoped caller still reaches them (one batch, §7.2).
    const completing = live.filter((r) => r.decision === 'complete');
    await this.students.promoteMany(
      scope,
      completing.map((r) => ({ studentId: r.studentId, reason: r.reason ?? COMPLETED_REASON })),
      effectiveOn,
    );
    // 3. Every other enrolment closes as `completed`; promote and detain open the next (one batch).
    const closing = live.filter((r) => r.decision !== 'not_continuing');
    const done = await this.enrolments.completeYearMany(
      schoolId,
      scope,
      closing.map((r) => {
        const target = r.targetSectionId === null ? undefined : locked.get(r.targetSectionId);
        return { enrolmentId: r.enrolmentId, next: target === undefined ? null : { target, startedOn: targetYear.startsOn } };
      }),
      year.endsOn,
    );
    // Every row read active must close now: one that left meanwhile is a race, retried.
    if (closing.some((r) => !done.has(r.enrolmentId))) throw concurrentUpdate();
    const marked = await this.promotion.markDecisionsApplied(
      schoolId,
      live.map((r) => ({ id: r.id, newEnrolmentId: done.get(r.enrolmentId)?.opened ?? null })),
      appliedAt,
    );
    if (marked !== live.length) throw concurrentUpdate();
    if ((await this.promotion.markApplied(schoolId, id, userId, appliedAt)) !== 1) throw concurrentUpdate();
    const counts: Record<PromotionOutcome, number> = { promote: 0, detain: 0, complete: 0, not_continuing: 0 };
    for (const row of live) if (row.decision !== null) counts[row.decision] += 1;
    await recordSubject(id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'promotion_sheet.applied',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: {
        sectionId: sheet.sectionId.toString(),
        targetYearId: sheet.targetYearId.toString(),
        ...counts,
        effectiveOn,
        skipped,
      },
    });
    const applied = await this.promotion.findById(schoolId, scope, id);
    if (!applied) throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    return this.toDetail(schoolId, applied);
  }

  // --------------------------------------------------------------------------------- cancel

  /**
   * contracts/slice-35.md §1: the principal cancels an open sheet (a wrong target year, a section
   * to open again from a corrected final). Its rows stay, frozen; the section's open slot is
   * freed; the year-close guard counts only applied sheets. Audited with the reason.
   */
  @Transactional()
  async cancel(session: SchoolSessionContext, id: bigint, reason: string): Promise<PromotionSheetDetailDto> {
    requirePrincipal(session);
    const { schoolId, userId } = this.context.actor();
    const scope = scopeOf(session);
    const sheet = await this.lockSheet(schoolId, scope, id);
    if (sheet.status !== 'open') throw sheetNotOpen(id);
    if ((await this.promotion.markCancelled(schoolId, id)) !== 1) throw concurrentUpdate();
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'promotion_sheet.cancelled',
      subjectType: SUBJECT,
      subjectId: id,
      reason,
      metadata: { sectionId: sheet.sectionId.toString(), targetYearId: sheet.targetYearId.toString() },
    });
    return this.detail(session, id);
  }

  // -------------------------------------------------------------------------------- helpers

  /**
   * The term the proposals read (A7): null for the final result when the class holds two or more
   * terms, the term's id when it holds one, undefined when it holds none (no result to read).
   */
  private async sourceTerm(schoolId: SchoolId, section: PromotionSection): Promise<bigint | null | undefined> {
    const held = await this.promotion.heldTerms(schoolId, section.academicYearId, section.classId);
    if (held.length === 0) return undefined;
    return held.length === 1 ? (held[0] ?? null) : null;
  }

  /** student.status.change over the sheet's section (school-wide, or a scope holding the section). */
  private async holdsStatusChange(session: SchoolSessionContext, sectionId: bigint): Promise<boolean> {
    const granted = await this.permissions.can(session.schoolId, session.access, Capability.STUDENT_STATUS_CHANGE);
    if (granted === null) return false;
    return granted.kind === 'all' || (granted.kind === 'sections' && granted.ids.includes(sectionId));
  }

  private async requireYear(schoolId: SchoolId, id: bigint): Promise<PromotionYear> {
    const year = await this.promotion.year(schoolId, id);
    if (!year) throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    return year;
  }

  private lockSheet(schoolId: SchoolId, scope: Scope, id: bigint): Promise<PromotionSheetRecord> {
    return readLocked(
      () => this.promotion.findById(schoolId, scope, id),
      (row) => this.promotion.lockIfUnchanged(schoolId, scope, row),
    );
  }

  private toSheetDto(
    sheet: PromotionSheetRecord,
    rows: number,
    undecided: number,
    names: ReadonlyMap<bigint, string>,
  ): PromotionSheetDto {
    return {
      id: sheet.id.toString(),
      academicYearId: sheet.academicYearId.toString(),
      academicYearName: sheet.academicYearName,
      classId: sheet.classId.toString(),
      className: sheet.className,
      classIsFinal: sheet.classIsFinal,
      sectionId: sheet.sectionId.toString(),
      sectionName: sheet.sectionName,
      targetYearId: sheet.targetYearId.toString(),
      targetYearName: sheet.targetYearName,
      status: sheet.status,
      rows,
      undecided,
      openedByName: names.get(sheet.openedBy) ?? '',
      openedAt: sheet.openedAt,
      appliedByName: sheet.appliedBy === null ? null : (names.get(sheet.appliedBy) ?? ''),
      appliedAt: sheet.appliedAt,
      updatedAt: sheet.updatedAt,
    };
  }

  private async toDetail(schoolId: SchoolId, sheet: PromotionSheetRecord): Promise<PromotionSheetDetailDto> {
    const rows = await this.promotion.decisions(schoolId, sheet.id);
    const names = await this.promotion.names(schoolId, [
      sheet.openedBy,
      ...(sheet.appliedBy === null ? [] : [sheet.appliedBy]),
      ...rows.flatMap((r) => (r.decidedBy === null ? [] : [r.decidedBy])),
    ]);
    const targets = await this.promotion.classesOfYear(schoolId, sheet.targetYearId);
    const applied = sheet.status === 'applied';
    return {
      ...this.toSheetDto(sheet, rows.length, rows.filter((r) => r.decision === null).length, names),
      targetYearHasClasses: targets.length > 0,
      decisions: rows.map(
        (r): PromotionDecisionDto => ({
          id: r.id.toString(),
          enrolmentId: r.enrolmentId.toString(),
          studentId: r.studentId.toString(),
          studentName: r.studentName,
          admissionNo: r.admissionNo,
          studentStatus: r.studentStatus,
          rollNo: r.rollNo,
          enrolmentStatus: r.enrolmentStatus,
          resultId: r.resultId?.toString() ?? null,
          resultSuperseded: r.resultSuperseded,
          percentBp: r.percentBp,
          grade: r.grade,
          passed: r.passed,
          proposed: r.proposed,
          decision: r.decision,
          reason: r.reason,
          targetClassId: r.targetClassId?.toString() ?? null,
          targetClassName: r.targetClassName,
          targetSectionId: r.targetSectionId?.toString() ?? null,
          targetSectionName: r.targetSectionName,
          arrearsFlag: r.arrearsFlag,
          decidedByName: r.decidedBy === null ? null : (names.get(r.decidedBy) ?? ''),
          decidedAt: r.decidedAt,
          appliedAt: r.appliedAt,
          skipped: applied && r.appliedAt === null,
          newEnrolmentId: r.newEnrolmentId?.toString() ?? null,
          revisedAfterApply: r.revisedAfterApply,
        }),
      ),
    };
  }
}
