import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { Capability, concessionAmount, ErrorCode, outstanding } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { toPage, type Page } from '../../common/pagination';
import { SchoolContext, type Actor } from '../../common/school-context';
import { NotificationService } from '../../messaging/notification.service';
import { AcademicYearRepository, type AcademicYearRecord } from '../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ChargeRepository, type ChargeRecord } from '../../repositories/charge.repository';
import { ChargeRunRepository } from '../../repositories/charge-run.repository';
import { ConcessionRepository, type ConcessionRecord } from '../../repositories/concession.repository';
import { FeeHeadRepository, type FeeHeadRecord } from '../../repositories/fee-head.repository';
import { MessageRecipientRepository } from '../../repositories/message-recipient.repository';
import { ChangeContextRepository } from '../../repositories/change-context.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { requirePrincipal } from '../access/money-gates';
import { Advances } from '../payments/advances';
import { PermissionsService } from '../access/permissions.service';
import { yearClosed } from '../academics/academics.shared';
import { feeHeadArchived } from './fee-heads.service';
import type { ReasonDto } from './fees.dto';
import type {
  ApproveConcessionDto,
  ConcessionDecisionDto,
  ConcessionDto,
  CreateConcessionDto,
  ListConcessionsQueryDto,
} from './charges.dto';
import {
  adjustmentOf,
  concessionExists,
  concessionHeadNotEligible,
  concessionNotPending,
  runInProgress,
  toChargeDto,
  toConcessionDto,
  yearMonths,
} from './charges.shared';
import { isPrincipal, ownChildCheck } from './fee-gates';

const ENDPOINT = 'concessions';
const SUBJECT = 'concession';

export interface ConcessionCreateOutcome {
  replayed: boolean;
  concession: ConcessionDto;
}

/** What a new concession is: its terms and whether it is created approved. */
export interface NewConcession {
  studentId: bigint;
  academicYearId: bigint;
  enrolmentId: bigint;
  kind: 'percentage' | 'fixed';
  value: number;
  effectiveFrom: string;
  reason: string;
  feeHeadIds: readonly bigint[];
}

/**
 * Concessions (phase-3-financial.md slice 19, R182, R183, R232, R253): requested by
 * `charge.create`, decided by a principal holding `concession.grant`, created approved when that
 * principal raises it (`directApproval`); one live per student, year and head under the student's
 * row lock; approval may credit the open charges already raised (A6).
 */
@Injectable()
export class ConcessionsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly concessions: ConcessionRepository,
    private readonly charges: ChargeRepository,
    private readonly runs: ChargeRunRepository,
    private readonly heads: FeeHeadRepository,
    private readonly years: AcademicYearRepository,
    private readonly people: MessageRecipientRepository,
    private readonly permissions: PermissionsService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditLogRepository,
    private readonly idempotency: IdempotentRequests,
    private readonly advances: Advances,
    private readonly changeContext: ChangeContextRepository,
  ) {}

  async list(query: ListConcessionsQueryDto): Promise<Page<ConcessionDto>> {
    const { rows, total } = await this.concessions.list(this.context.schoolId, {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.studentId === undefined ? {} : { studentId: BigInt(query.studentId) }),
      ...(query.academicYearId === undefined ? {} : { academicYearId: BigInt(query.academicYearId) }),
      sort: query.sort ?? '-requestedAt',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map(toConcessionDto), query, total);
  }

  async get(id: bigint): Promise<ConcessionDto> {
    return toConcessionDto(await this.require(this.context.schoolId, id));
  }

  // ------------------------------------------------------------------------------ create

  /** Keyed by Idempotency-Key (endpoint concessions, path id the student). */
  async create(
    session: SchoolSessionContext,
    dto: CreateConcessionDto,
    rawKey: string | undefined,
  ): Promise<ConcessionCreateOutcome> {
    const actor = this.context.actor();
    const outcome = await this.idempotency.withIdempotencyKey(actor, ENDPOINT, BigInt(dto.studentId), dto, rawKey, (claim) =>
      this.createInTransaction(session, actor, dto, claim),
    );
    const id = outcome.replayed ? outcome.subjectId : outcome.value;
    return { replayed: outcome.replayed, concession: toConcessionDto(await this.require(actor.schoolId, id)) };
  }

  @Transactional()
  private async createInTransaction(
    session: SchoolSessionContext,
    actor: Actor,
    dto: CreateConcessionDto,
    claim: IdempotencyClaim,
  ): Promise<bigint> {
    const { schoolId, userId } = actor;
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, SUBJECT);
    const year = await this.years.findById(schoolId, BigInt(dto.academicYearId));
    if (!year) throw fieldRefused('academicYearId', ErrorCode.REFERENCE_NOT_FOUND, 'No such academic year');
    if (year.status === 'closed') throw yearClosed();
    assertMonthOfYear(year, dto.effectiveFrom);
    if (dto.kind === 'percentage' && dto.value > 100) {
      throw fieldRefused('value', ErrorCode.INVALID_VALUE, 'A percentage is 1-100');
    }
    const heads = await this.eligibleHeads(schoolId, dto.feeHeadIds);
    const studentId = BigInt(dto.studentId);
    const enrolment = await this.studentInYear(schoolId, studentId, year.id);
    // directApproval (R183): a principal holding both keys creates it approved.
    const direct = isPrincipal(session) && session.access.capabilities.has(Capability.CONCESSION_GRANT);
    const selfApproved = direct ? await ownChildCheck(this.permissions, session, schoolId, studentId) : false;
    const id = await this.insert(schoolId, userId, {
      studentId,
      academicYearId: year.id,
      enrolmentId: enrolment,
      kind: dto.kind,
      value: dto.value,
      effectiveFrom: dto.effectiveFrom,
      reason: dto.reason,
      feeHeadIds: heads.map((h) => h.id),
    }, direct ? { selfApproved } : null);
    await recordSubject(id);
    return id;
  }

  /**
   * Writes a concession under the student's row lock (already taken by the caller), refusing a
   * second live one on any of its heads (CONCESSION_EXISTS); audited, and the principals are told
   * of a request. Shared with admission (R239).
   */
  async insert(
    schoolId: SchoolId,
    userId: bigint,
    terms: NewConcession,
    approved: { selfApproved: boolean } | null,
  ): Promise<bigint> {
    const live = await this.concessions.findLiveOnHeads(schoolId, terms.studentId, terms.academicYearId, terms.feeHeadIds);
    if (live) throw concessionExists(live.concessionId, live.feeHeadId);
    const id = await this.concessions.create(schoolId, {
      ...terms,
      requestedBy: userId,
      approved: approved === null ? null : { by: userId, at: new Date(), selfApproved: approved.selfApproved },
    });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'concession.created',
      subjectType: SUBJECT,
      subjectId: id,
      reason: terms.reason,
      metadata: {
        studentId: terms.studentId.toString(),
        academicYearId: terms.academicYearId.toString(),
        kind: terms.kind,
        value: terms.value,
        effectiveFrom: terms.effectiveFrom,
        feeHeadIds: terms.feeHeadIds.map(String).join(','),
        directApproval: approved !== null,
        selfApproved: approved?.selfApproved ?? false,
      },
    });
    if (approved === null) await this.tellPrincipals(schoolId, id);
    return id;
  }

  // ----------------------------------------------------------------------------- decisions

  /**
   * R183, A6: approve a requested concession; with `applyToOpenCharges`, one credit per open charge
   * of the named heads from `effectiveFrom`, each at most what the charge still owes.
   */
  @Transactional()
  async approve(session: SchoolSessionContext, id: bigint, dto: ApproveConcessionDto): Promise<ConcessionDecisionDto> {
    requirePrincipal(session);
    const { schoolId, userId } = this.context.actor();
    const row = await this.require(schoolId, id);
    await this.concessions.lockStudent(schoolId, row.studentId);
    if (row.status !== 'requested') throw concessionNotPending(id);
    const year = await this.years.findById(schoolId, row.academicYearId);
    if (!year || year.status === 'closed') throw yearClosed();
    const selfApproved = await ownChildCheck(this.permissions, session, schoolId, row.studentId);
    if (dto.applyToOpenCharges) {
      const busy = await this.runs.findInProgress(schoolId, row.academicYearId);
      if (busy) throw runInProgress(busy.id);
    }
    const decided = await this.concessions.decide(schoolId, id, {
      status: 'approved',
      by: userId,
      at: new Date(),
      reason: dto.reason ?? null,
      selfApproved,
    });
    if (decided !== 1) throw concessionNotPending(id);
    const { adjustments, applied } = dto.applyToOpenCharges
      ? await this.creditOpenCharges(schoolId, userId, row, selfApproved)
      : { adjustments: [], applied: 0 };
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'concession.approved',
      subjectType: SUBJECT,
      subjectId: id,
      ...(dto.reason === undefined ? {} : { reason: dto.reason }),
      metadata: {
        studentId: row.studentId.toString(),
        kind: row.kind,
        value: row.value,
        appliedToOpenCharges: adjustments.length,
        creditedAmount: adjustments.reduce((sum, a) => sum + a.amount, 0),
        advanceApplied: applied,
        selfApproved,
      },
    });
    await this.tellRequester(schoolId, row, userId, 'approved');
    return {
      concession: toConcessionDto(await this.require(schoolId, id)),
      adjustments: adjustments.map(toChargeDto),
    };
  }

  @Transactional()
  async reject(session: SchoolSessionContext, id: bigint, dto: ReasonDto): Promise<ConcessionDto> {
    requirePrincipal(session);
    const { schoolId, userId } = this.context.actor();
    const row = await this.require(schoolId, id);
    if (row.status !== 'requested') throw concessionNotPending(id);
    const decided = await this.concessions.decide(schoolId, id, {
      status: 'rejected',
      by: userId,
      at: new Date(),
      reason: dto.reason,
      selfApproved: false,
    });
    if (decided !== 1) throw concessionNotPending(id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'concession.rejected',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: { studentId: row.studentId.toString() },
    });
    await this.tellRequester(schoolId, row, userId, 'rejected');
    return toConcessionDto(await this.require(schoolId, id));
  }

  /** Ending affects future charges only (R183): nothing already charged changes. */
  @Transactional()
  async end(session: SchoolSessionContext, id: bigint, dto: ReasonDto): Promise<ConcessionDto> {
    requirePrincipal(session);
    const { schoolId, userId } = this.context.actor();
    const row = await this.require(schoolId, id);
    if (row.status !== 'approved' || (await this.concessions.end(schoolId, id, userId, dto.reason, new Date())) !== 1) {
      throw new ApiException(409, ErrorCode.ILLEGAL_STATUS_TRANSITION, 'Only an approved concession can be ended.', {
        from: row.status,
        to: 'ended',
      });
    }
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'concession.ended',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: { studentId: row.studentId.toString() },
    });
    await this.tellRequester(schoolId, row, userId, 'ended');
    return toConcessionDto(await this.require(schoolId, id));
  }

  // ------------------------------------------------------------------------------ helpers

  /**
   * A6: one credit per open charge in range, never capped at what is owed: beyond it the charge's
   * newest live allocations go back into their payments as advances for the same child (slice
   * 20), except an admission-head allocation, which caps that one credit. Locks in R236's order:
   * the charges' payments, then the charges by id.
   */
  private async creditOpenCharges(
    schoolId: SchoolId,
    userId: bigint,
    row: ConcessionRecord,
    selfApproved: boolean,
  ): Promise<{ adjustments: ChargeRecord[]; applied: number }> {
    const feeHeadIds = row.heads.map((h) => h.feeHeadId);
    const open = await this.charges.openForConcession(schoolId, row.studentId, row.academicYearId, feeHeadIds, row.effectiveFrom);
    const locked = await this.advances.lockForCredit(schoolId, open.map((c) => c.id));
    // The allocation triggers read the acting user (R232); the sole principal's own child (R253)
    // moves money as the system would.
    if (!selfApproved) await this.changeContext.setChangeContext(userId, null);
    const terms = { kind: row.kind, value: row.value, feeHeadIds };
    const created: ChargeRecord[] = [];
    const now = new Date();
    for (const charge of locked) {
      if (charge.status !== 'open') continue;
      const head = row.heads.find((h) => h.feeHeadId === charge.feeHeadId);
      const due = concessionAmount(charge.grossAmount, terms, {
        id: charge.feeHeadId,
        concessionEligible: head?.feeHead.concessionEligible ?? false,
      });
      const owed = outstanding(charge);
      const credit = owed + (await this.advances.deallocate(schoolId, charge, due - owed, now));
      if (Math.min(due, credit) <= 0) continue;
      created.push(await this.charges.create(schoolId, adjustmentOf(charge, Math.min(due, credit), row.id, userId), now));
    }
    // The child's advance (freed money, or an earlier one) pays their other open charges.
    const applied = await this.advances.applyTo(schoolId, row.academicYearId, [row.studentId]);
    return { adjustments: created, applied: applied.amount };
  }

  /** Each named head exists, is live and takes concessions; listed once. */
  private async eligibleHeads(schoolId: SchoolId, ids: readonly string[]): Promise<FeeHeadRecord[]> {
    const heads: FeeHeadRecord[] = [];
    for (const [index, raw] of ids.entries()) {
      if (ids.indexOf(raw) !== index) {
        throw fieldRefused(`feeHeadIds[${index}]`, ErrorCode.INVALID_VALUE, 'This fee head is listed twice');
      }
      const head = await this.heads.findById(schoolId, BigInt(raw));
      if (!head) throw fieldRefused(`feeHeadIds[${index}]`, ErrorCode.REFERENCE_NOT_FOUND, 'No such fee head');
      if (head.status === 'archived') throw feeHeadArchived(head.id);
      if (!head.concessionEligible) throw concessionHeadNotEligible(head.id);
      heads.push(head);
    }
    return heads;
  }

  /** Locks the student (§4) and returns the enrolment of the year the concession originates from. */
  async studentInYear(schoolId: SchoolId, studentId: bigint, academicYearId: bigint): Promise<bigint> {
    if (!(await this.concessions.lockStudent(schoolId, studentId))) {
      throw fieldRefused('studentId', ErrorCode.REFERENCE_NOT_FOUND, 'No such student');
    }
    const enrolment = await this.concessions.enrolmentInYear(schoolId, studentId, academicYearId);
    if (!enrolment) {
      throw fieldRefused('studentId', ErrorCode.INVALID_VALUE, 'The student has no enrolment in that academic year');
    }
    return enrolment.id;
  }

  private async require(schoolId: SchoolId, id: bigint): Promise<ConcessionRecord> {
    const row = await this.concessions.findById(schoolId, id);
    if (!row) throw notFound();
    return row;
  }

  /** concession_requested to every active principal (push and email, no amount). */
  private async tellPrincipals(schoolId: SchoolId, id: bigint): Promise<void> {
    const principals = await this.people.activePrincipalStaffIds(schoolId);
    if (principals.length === 0) return;
    const row = await this.require(schoolId, id);
    await this.notifications.send(schoolId, {
      type: 'concession_requested',
      subject: { type: 'concession', id },
      recipients: principals.map((staffId) => ({ staffId })),
      vars: {
        studentName: row.enrolment.student.fullName,
        requesterName: row.requestedByUser.staff?.fullName ?? 'the office',
      },
    });
  }

  /** concession_decided to the requester, unless the decider is the requester. */
  private async tellRequester(
    schoolId: SchoolId,
    row: ConcessionRecord,
    deciderId: bigint,
    decision: 'approved' | 'rejected' | 'ended',
  ): Promise<void> {
    if (row.requestedBy === deciderId) return;
    const staffId = await this.concessions.staffIdOfUser(schoolId, row.requestedBy);
    if (staffId === null) return;
    await this.notifications.send(schoolId, {
      type: 'concession_decided',
      subject: { type: 'concession', id: row.id },
      recipients: [{ staffId }],
      vars: { studentName: row.enrolment.student.fullName, decision },
    });
  }
}

/** `effectiveFrom` is a month of the academic year (422). */
function assertMonthOfYear(year: AcademicYearRecord, month: string): void {
  const { from, to } = yearMonths(year);
  if (month < from || month > to) {
    throw fieldRefused('effectiveFrom', ErrorCode.INVALID_VALUE, 'effectiveFrom must be a month of the academic year');
  }
}
