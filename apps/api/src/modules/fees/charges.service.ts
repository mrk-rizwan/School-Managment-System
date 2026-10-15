import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { Capability, concessionAmount, ErrorCode, outstanding, type FeeFrequency } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { recoverConstraint } from '../../common/errors/prisma-errors';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { toPage, type Page } from '../../common/pagination';
import { dayStart, SchoolClock } from '../../common/school-clock';
import { SchoolContext, type Actor } from '../../common/school-context';
import { OutboxDispatcher } from '../../messaging/outbox-dispatcher';
import { AcademicYearRepository } from '../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ChargeRepository, type ChargeRecord } from '../../repositories/charge.repository';
import { ChargeRunRepository, type ChargeRunRecord } from '../../repositories/charge-run.repository';
import { ChangeContextRepository } from '../../repositories/change-context.repository';
import { ConcessionRepository } from '../../repositories/concession.repository';
import { FeeHeadRepository } from '../../repositories/fee-head.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { requirePrincipal } from '../access/money-gates';
import { Advances } from '../payments/advances';
import { PaymentsService } from '../payments/payments.service';
import { PermissionsService } from '../access/permissions.service';
import { fromDateString, yearClosed } from '../academics/academics.shared';
import { feeHeadArchived } from './fee-heads.service';
import type { ReasonDto } from '../../common/reason.dto';
import type {
  AdjustChargeDto,
  ChargeDto,
  ChargeRunDto,
  CreateChargeDto,
  GenerateMonthDto,
  ListChargeRunsQueryDto,
  ListChargesQueryDto,
  StatementDto,
  StatementQueryDto,
} from './charges.dto';
import {
  adjustmentOf,
  chargeHasAllocations,
  chargeHasCredits,
  chargeNotLateFee,
  chargeNotOpen,
  monthNotGeneratable,
  periodOf,
  skippedClassesOf,
  studentNotActive,
  toChargeDto,
  toChargeRunDto,
  toConcessionDto,
  yearMonths,
} from './charges.shared';
import { ownChildCheck, requireHeld } from './fee-gates';
import { onceMore } from '../payments/payments.shared';

const ENDPOINT = 'charges';
const SUBJECT = 'charge';
const RUN_PERIOD_KEY = 'charge_runs_period_key';

export interface ChargeCreateOutcome {
  replayed: boolean;
  charge: ChargeDto;
}

/**
 * Charges (phase-3-financial.md slice 19, R179-R186, R205, R242): the list and statement, manual
 * charges, voids, late-fee waivers, adjustments (credits up to what is owed; beyond it needs slice
 * 20's de-allocation), and requesting a month's generation. Finance keys are school-wide (rule
 * 0.24); the principal gate and the own-child refusal are per verb (§3.1).
 */
@Injectable()
export class ChargesService {
  constructor(
    private readonly context: SchoolContext,
    private readonly charges: ChargeRepository,
    private readonly runs: ChargeRunRepository,
    private readonly concessions: ConcessionRepository,
    private readonly heads: FeeHeadRepository,
    private readonly years: AcademicYearRepository,
    private readonly permissions: PermissionsService,
    private readonly outbox: OutboxDispatcher,
    private readonly audit: AuditLogRepository,
    private readonly idempotency: IdempotentRequests,
    private readonly clock: SchoolClock,
    private readonly advances: Advances,
    private readonly payments: PaymentsService,
    private readonly changeContext: ChangeContextRepository,
  ) {}

  // ------------------------------------------------------------------------------- reads

  async list(query: ListChargesQueryDto): Promise<Page<ChargeDto>> {
    const { rows, total } = await this.charges.list(this.context.schoolId, {
      ...(query.studentId === undefined ? {} : { studentId: BigInt(query.studentId) }),
      ...(query.academicYearId === undefined ? {} : { academicYearId: BigInt(query.academicYearId) }),
      ...(query.classId === undefined ? {} : { classId: BigInt(query.classId) }),
      ...(query.sectionId === undefined ? {} : { sectionId: BigInt(query.sectionId) }),
      ...(query.feeHeadId === undefined ? {} : { feeHeadId: BigInt(query.feeHeadId) }),
      ...(query.campaignId === undefined ? {} : { campaignId: BigInt(query.campaignId) }),
      ...(query.period === undefined ? {} : { period: query.period }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.dueFrom === undefined ? {} : { dueFrom: fromDateString(query.dueFrom) }),
      ...(query.dueTo === undefined ? {} : { dueTo: fromDateString(query.dueTo) }),
      ...(query.voidedFrom === undefined ? {} : { voidedFrom: await this.dayStartOf(query.voidedFrom) }),
      sort: query.sort ?? '-dueOn',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map(toChargeDto), query, total);
  }

  async get(id: bigint): Promise<ChargeDto> {
    const row = await this.charges.findById(this.context.schoolId, id);
    if (!row) throw notFound();
    return toChargeDto(row);
  }

  /**
   * R205: a student's year, both dates on every line (rule 25); charged, concession, credits and
   * paid as separate totals; the payments that paid the child (or hold their advance) and the
   * advance (slice 20).
   */
  async statement(studentId: bigint, query: StatementQueryDto): Promise<StatementDto> {
    const schoolId = this.context.schoolId;
    if (!(await this.charges.studentExists(schoolId, studentId))) throw notFound();
    let academicYearId: bigint | null;
    if (query.academicYearId === undefined) {
      academicYearId = await this.charges.latestYearOf(schoolId, studentId);
    } else {
      academicYearId = BigInt(query.academicYearId);
      if (!(await this.years.findById(schoolId, academicYearId))) {
        throw fieldRefused('academicYearId', ErrorCode.REFERENCE_NOT_FOUND, 'No such academic year');
      }
    }
    if (academicYearId === null) {
      return {
        studentId: studentId.toString(),
        academicYearId: null,
        charges: { data: [], page: query.page, limit: query.limit, total: 0 },
        payments: [],
        adjustments: [],
        concessions: [],
        totals: { charged: 0, concession: 0, adjustments: 0, paid: 0, outstanding: 0, advance: 0 },
      };
    }
    const page = await this.charges.forStatement(schoolId, studentId, academicYearId, {
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const adjustments = await this.charges.adjustmentsOf(schoolId, studentId, academicYearId);
    const concessions = await this.concessions.forStudentYear(schoolId, studentId, academicYearId);
    const totals = await this.charges.totals(schoolId, studentId, academicYearId);
    const paid = await this.payments.forStatement(studentId, academicYearId);
    return {
      studentId: studentId.toString(),
      academicYearId: academicYearId.toString(),
      charges: { ...toPage(page.rows.map(toChargeDto), query, page.total) },
      payments: paid.payments,
      adjustments: adjustments.map(toChargeDto),
      concessions: concessions.map(toConcessionDto),
      totals: { ...totals, advance: paid.advance },
    };
  }

  // ------------------------------------------------------------------------- manual charge

  /** Keyed by Idempotency-Key (endpoint charges, path id the enrolment). */
  async create(dto: CreateChargeDto, rawKey: string | undefined): Promise<ChargeCreateOutcome> {
    const actor = this.context.actor();
    const outcome = await this.idempotency.withIdempotencyKey(actor, ENDPOINT, BigInt(dto.enrolmentId), dto, rawKey, (claim) =>
      this.createInTransaction(actor, dto, claim),
    );
    return this.outcome(actor.schoolId, outcome);
  }

  @Transactional()
  private async createInTransaction(actor: Actor, dto: CreateChargeDto, claim: IdempotencyClaim): Promise<ChargeRecord> {
    const { schoolId, userId } = actor;
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, SUBJECT);
    const enrolment = await this.charges.enrolmentForCharge(schoolId, BigInt(dto.enrolmentId));
    if (!enrolment) throw fieldRefused('enrolmentId', ErrorCode.REFERENCE_NOT_FOUND, 'No such enrolment');
    // A suspended student is charged (rule 20); one who has left is not.
    if (enrolment.student.status !== 'active' && enrolment.student.status !== 'suspended') throw studentNotActive();
    if (enrolment.endedOn !== null) {
      throw fieldRefused('enrolmentId', ErrorCode.INVALID_VALUE, 'That enrolment has ended; charge the current one');
    }
    if (enrolment.academicYear.status === 'closed') throw yearClosed();
    const head = await this.heads.findById(schoolId, BigInt(dto.feeHeadId));
    if (!head) throw fieldRefused('feeHeadId', ErrorCode.REFERENCE_NOT_FOUND, 'No such fee head');
    if (head.status === 'archived') throw feeHeadArchived(head.id);
    const today = await this.clock.today(schoolId);
    const dueOn = fromDateString(dto.dueOn);
    if (dueOn < today) throw fieldRefused('dueOn', ErrorCode.INVALID_VALUE, 'dueOn must be today or later');

    const con = dto.applyConcession
      ? await this.concessions.approvedFor(schoolId, enrolment.studentId, enrolment.academicYearId, head.id, periodOf(dueOn))
      : null;
    const conceded = con === null ? 0 : concessionAmount(dto.amount, { ...con, feeHeadIds: [head.id] }, head);
    const created = await this.charges.create(
      schoolId,
      {
        enrolmentId: enrolment.id,
        studentId: enrolment.studentId,
        academicYearId: enrolment.academicYearId,
        feeHeadId: head.id,
        headFrequency: head.frequency,
        kind: 'manual',
        period: null,
        concessionId: conceded > 0 && con !== null ? con.id : null,
        grossAmount: dto.amount,
        concessionAmount: conceded,
        description: dto.description,
        dueOn,
        createdBy: userId,
      },
      new Date(),
    );
    // R189: the child's advance in the year pays the new charge at once (payments locked first).
    const applied = await this.advances.applyTo(schoolId, enrolment.academicYearId, [enrolment.studentId]);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'charge.created',
      subjectType: SUBJECT,
      subjectId: created.id,
      metadata: {
        studentId: created.studentId.toString(),
        enrolmentId: created.enrolmentId.toString(),
        feeHeadId: head.id.toString(),
        amount: created.amount,
        grossAmount: created.grossAmount,
        concessionAmount: created.concessionAmount,
        dueOn: dto.dueOn,
        advanceApplied: applied.amount,
      },
    });
    await recordSubject(created.id);
    return applied.amount > 0 ? ((await this.charges.findById(schoolId, created.id)) ?? created) : created;
  }

  // ------------------------------------------------------- opening balances (slice 43)

  /**
   * Phase 5 rule 39, R342: the seeded "Opening balance" head an opening-balances import charges.
   * An archived one is FEE_HEAD_ARCHIVED; a school without it (never seeded) is refused too.
   */
  async openingBalanceHead(schoolId: SchoolId): Promise<{ id: bigint; name: string; frequency: FeeFrequency }> {
    const head = await this.heads.findSeededOpeningBalance(schoolId);
    if (!head) throw new ApiException(409, ErrorCode.REFERENCE_NOT_FOUND, 'The school has no Opening balance fee head.');
    if (head.status === 'archived') throw feeHeadArchived(head.id);
    return head;
  }

  /** Each child's advance in the year, unlocked: what an opening-balance preview shows applying. */
  openingBalanceAdvances(schoolId: SchoolId, academicYearId: bigint, studentIds: readonly bigint[]): Promise<Map<bigint, number>> {
    return this.advances.available(schoolId, academicYearId, studentIds);
  }

  /**
   * R342, inside the import's commit transaction (ImportsService): one manual charge per row under
   * the seeded head, due on the file's date, never late-fee'd (once-a-time head, no period; and
   * trigger charges_import_guard), then each child's advance in the year pays it at once (R189).
   */
  async createOpeningBalances(
    schoolId: SchoolId,
    input: {
      importId: bigint;
      academicYearId: bigint;
      dueOn: Date;
      createdBy: bigint;
      rows: readonly { enrolmentId: bigint; studentId: bigint; amount: number; note: string | null }[];
    },
  ): Promise<{ charges: number; amount: number; advanceApplied: number }> {
    const head = await this.openingBalanceHead(schoolId);
    const charges = await this.charges.createImported(
      schoolId,
      input.importId,
      head,
      input.rows.map((row) => ({
        enrolmentId: row.enrolmentId,
        studentId: row.studentId,
        academicYearId: input.academicYearId,
        amount: row.amount,
        description: row.note === null ? head.name : `${head.name}: ${row.note}`.slice(0, 200),
        dueOn: input.dueOn,
        createdBy: input.createdBy,
      })),
    );
    const applied = await this.advances.applyTo(
      schoolId,
      input.academicYearId,
      input.rows.map((row) => row.studentId),
    );
    return {
      charges,
      amount: input.rows.reduce((sum, row) => sum + row.amount, 0),
      advanceApplied: applied.amount,
    };
  }

  // ------------------------------------------------------------------------- void, waive

  /**
   * R186: a manual or campaign charge is voided by `charge.create`, a generated charge or late fee
   * by a principal holding `concession.grant`; never with allocations; its open late fee goes with
   * it; never for the actor's own child (the sole principal excepted, R253).
   */
  @Transactional()
  async void(session: SchoolSessionContext, id: bigint, dto: ReasonDto): Promise<ChargeDto> {
    const { schoolId, userId } = this.context.actor();
    const row = await this.lockedCharge(schoolId, id);
    if (row.kind === 'manual' || row.kind === 'campaign') {
      requireHeld(session, Capability.CHARGE_CREATE);
    } else {
      requireHeld(session, Capability.CONCESSION_GRANT);
      requirePrincipal(session);
    }
    if (row.status !== 'open' || row.kind === 'adjustment') throw chargeNotOpen(id);
    if (row.allocatedAmount > 0) throw chargeHasAllocations(id);
    if (row.creditedAmount > 0) throw chargeHasCredits(id);
    const selfApproved = await ownChildCheck(this.permissions, session, schoolId, row.studentId);
    const lateFees = await this.charges.openLateFeesFor(schoolId, id);
    await this.charges.lockForUpdate(schoolId, lateFees.map((f) => f.id));
    for (const fee of lateFees) {
      if (fee.allocatedAmount > 0) throw chargeHasAllocations(fee.id);
      if (fee.creditedAmount > 0) throw chargeHasCredits(fee.id);
    }
    const now = new Date();
    if ((await this.charges.void(schoolId, id, userId, dto.reason, now)) !== 1) throw chargeNotOpen(id);
    for (const fee of lateFees) {
      if ((await this.charges.void(schoolId, fee.id, userId, dto.reason, now)) !== 1) throw chargeNotOpen(fee.id);
    }
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'charge.voided',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: {
        kind: row.kind,
        studentId: row.studentId.toString(),
        feeHeadId: row.feeHeadId.toString(),
        period: row.period,
        amount: row.amount,
        lateFeesVoided: lateFees.map((f) => f.id.toString()).join(','),
        selfApproved,
      },
    });
    return this.reload(schoolId, id);
  }

  /** R185: a principal holding `concession.grant` waives an open late fee with no allocation. */
  @Transactional()
  async waive(session: SchoolSessionContext, id: bigint, dto: ReasonDto): Promise<ChargeDto> {
    const { schoolId, userId } = this.context.actor();
    requirePrincipal(session);
    const row = await this.lockedCharge(schoolId, id);
    if (row.kind !== 'late_fee') throw chargeNotLateFee(id);
    if (row.status !== 'open') throw chargeNotOpen(id);
    if (row.allocatedAmount > 0) throw chargeHasAllocations(id);
    const selfApproved = await ownChildCheck(this.permissions, session, schoolId, row.studentId);
    if ((await this.charges.waive(schoolId, id, userId, dto.reason, new Date())) !== 1) throw chargeNotOpen(id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'charge.waived',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: {
        studentId: row.studentId.toString(),
        period: row.period,
        amount: row.amount,
        lateFeeForChargeId: row.lateFeeForChargeId?.toString() ?? null,
        selfApproved,
      },
    });
    return this.reload(schoolId, id);
  }

  // ------------------------------------------------------------------------------ adjust

  /**
   * R186: a credit is its own settled row; the trigger raises the original's credited amount and
   * settles it when nothing is left owed. Keyed by Idempotency-Key (endpoint charges, path id the
   * charge). A credit beyond what is owed (a settled charge too) first de-allocates the charge's
   * newest live allocations into their payments as advances for the same child (A6, slice 20),
   * never an admission-head allocation: what cannot be freed is refused (409 CHARGE_NOT_OPEN,
   * reason exceeds_outstanding). Locks in R236's order: the payments, then the charge.
   */
  async adjust(
    session: SchoolSessionContext,
    id: bigint,
    dto: AdjustChargeDto,
    rawKey: string | undefined,
  ): Promise<ChargeCreateOutcome> {
    requirePrincipal(session);
    const actor = this.context.actor();
    if (!(await this.charges.findById(actor.schoolId, id))) throw notFound();
    const outcome = await this.idempotency.withIdempotencyKey(actor, ENDPOINT, id, dto, rawKey, (claim) =>
      onceMore(() => this.adjustInTransaction(session, actor, id, dto, claim)),
    );
    return this.outcome(actor.schoolId, outcome);
  }

  @Transactional()
  private async adjustInTransaction(
    session: SchoolSessionContext,
    actor: Actor,
    id: bigint,
    dto: AdjustChargeDto,
    claim: IdempotencyClaim,
  ): Promise<ChargeRecord> {
    const { schoolId, userId } = actor;
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, SUBJECT);
    const [row] = await this.advances.lockForCredit(schoolId, [id]);
    if (!row) throw notFound();
    if ((row.status !== 'open' && row.status !== 'settled') || row.kind === 'adjustment') throw chargeNotOpen(id);
    const owed = outstanding(row);
    const selfApproved = await ownChildCheck(this.permissions, session, schoolId, row.studentId);
    // The allocation triggers read the acting user (R232). The sole principal's own child (R253)
    // moves money as the system would: the service has already decided it.
    if (!selfApproved) await this.changeContext.setChangeContext(userId, null);
    const now = new Date();
    const beyond = dto.amount - owed;
    const freed = await this.advances.deallocate(schoolId, row, beyond, now);
    if (freed < beyond) {
      throw chargeNotOpen(id, { reason: 'exceeds_outstanding', outstanding: owed, creditable: owed + freed });
    }
    const created = await this.charges.create(schoolId, adjustmentOf(row, dto.amount, null, userId), now);
    // The child's advance (the money just freed, or an earlier one) pays their other open charges.
    const applied = await this.advances.applyTo(schoolId, row.academicYearId, [row.studentId]);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'charge.adjusted',
      subjectType: SUBJECT,
      subjectId: created.id,
      reason: dto.reason,
      metadata: {
        adjustsChargeId: id.toString(),
        studentId: row.studentId.toString(),
        amount: dto.amount,
        outstandingBefore: owed,
        deallocated: freed,
        applied: applied.amount,
        selfApproved,
      },
    });
    await recordSubject(created.id);
    return created;
  }

  // -------------------------------------------------------------- event cancel (slice 38)

  /**
   * Phase 5 R313 (contracts/slice-38.md §2.5), in the caller's (the cancel) transaction: every
   * live charge of the campaign and every live late fee of one is voided when no money is on it,
   * otherwise credited for what is left uncredited, which de-allocates the paid money into its
   * payment as the child's advance (R186; no cash moves). Money on any of them (a paid late fee
   * too) needs the principal, checked before anything is written. All the families' locks are
   * taken first, in R236's order (lockForCredit over every charge and late fee); a sole
   * principal's own child (R253) is credited before the change context is set, as adjust does;
   * any other actor's own child refuses (own_child).
   */
  async settleCancelledCampaign(
    session: SchoolSessionContext,
    campaignId: bigint,
    reason: string,
  ): Promise<{ voided: number; credited: number; applied: number }> {
    const { schoolId, userId } = this.context.actor();
    const ids = await this.charges.liveIdsOfCampaign(schoolId, campaignId);
    if (ids.length === 0) return { voided: 0, credited: 0, applied: 0 };
    const lateIds = await this.charges.liveLateFeeIdsFor(schoolId, ids);
    const rows = await this.advances.lockForCredit(schoolId, [...ids, ...lateIds]);
    const live = rows.filter((r) => r.kind === 'campaign' && r.status !== 'voided');
    const liveIds = new Set(live.map((r) => r.id));
    const lateFees = rows.filter(
      (r) => r.kind === 'late_fee' && r.status !== 'voided' && r.lateFeeForChargeId !== null && liveIds.has(r.lateFeeForChargeId),
    );
    const hasMoney = (r: ChargeRecord) => r.allocatedAmount > 0 || r.creditedAmount > 0;
    const withMoney = [...live, ...lateFees].filter(hasMoney);
    if (withMoney.length > 0) requirePrincipal(session);
    const self = new Set<bigint>();
    for (const row of withMoney) {
      if (await ownChildCheck(this.permissions, session, schoolId, row.studentId)) self.add(row.id);
    }
    const now = new Date();
    let voided = 0;
    for (const row of live) {
      // Each charge's open late fee with no money on it goes with it; one with money is credited below.
      const unpaidLate: bigint[] = [];
      for (const fee of lateFees) {
        if (fee.lateFeeForChargeId !== row.id || fee.status !== 'open' || hasMoney(fee)) continue;
        if ((await this.charges.void(schoolId, fee.id, userId, reason, now)) === 1) {
          voided += 1;
          unpaidLate.push(fee.id);
        }
      }
      if (hasMoney(row)) continue;
      if ((await this.charges.void(schoolId, row.id, userId, reason, now)) !== 1) throw chargeNotOpen(row.id);
      voided += 1;
      await this.audit.record(schoolId, {
        actorUserId: userId,
        action: 'charge.voided',
        subjectType: SUBJECT,
        subjectId: row.id,
        reason,
        metadata: {
          kind: row.kind,
          studentId: row.studentId.toString(),
          feeHeadId: row.feeHeadId.toString(),
          period: row.period,
          amount: row.amount,
          lateFeesVoided: unpaidLate.map((id) => id.toString()).join(','),
          selfApproved: false,
          source: 'event_cancelled',
        },
      });
    }
    // R253's own child first, with no acting user set; then everyone else under the actor (R232).
    const ordered = [...withMoney.filter((r) => self.has(r.id)), ...withMoney.filter((r) => !self.has(r.id))];
    let contextSet = false;
    let credited = 0;
    for (const row of ordered) {
      if (!self.has(row.id) && !contextSet) {
        await this.changeContext.setChangeContext(userId, null);
        contextSet = true;
      }
      const amount = row.amount - row.creditedAmount;
      if (amount <= 0) continue;
      const owed = outstanding(row);
      const beyond = amount - owed;
      const freed = await this.advances.deallocate(schoolId, row, beyond, now);
      if (freed < beyond) {
        throw chargeNotOpen(row.id, { reason: 'exceeds_outstanding', outstanding: owed, creditable: owed + freed });
      }
      const created = await this.charges.create(schoolId, adjustmentOf(row, amount, null, userId), now);
      credited += 1;
      await this.audit.record(schoolId, {
        actorUserId: userId,
        action: 'charge.adjusted',
        subjectType: SUBJECT,
        subjectId: created.id,
        reason,
        metadata: {
          adjustsChargeId: row.id.toString(),
          studentId: row.studentId.toString(),
          amount,
          outstandingBefore: owed,
          deallocated: freed,
          selfApproved: self.has(row.id),
          source: 'event_cancelled',
        },
      });
    }
    const first = live[0];
    const applied =
      withMoney.length === 0 || first === undefined
        ? { amount: 0 }
        : await this.advances.applyTo(schoolId, first.academicYearId, [...new Set(withMoney.map((r) => r.studentId))]);
    return { voided, credited, applied: applied.amount };
  }

  // -------------------------------------------------------------------------- generation

  /**
   * POST /charges/generate-month: queues a monthly run (201), or answers the run already queued or
   * running for that year and month (200). `regenerateVoided` is the principal's (R179).
   */
  async generateMonth(
    session: SchoolSessionContext,
    dto: GenerateMonthDto,
  ): Promise<{ created: boolean; run: ChargeRunDto }> {
    const regenerateVoided = dto.regenerateVoided ?? false;
    if (regenerateVoided) {
      requireHeld(session, Capability.CONCESSION_GRANT);
      requirePrincipal(session);
    }
    const schoolId = this.context.schoolId;
    const academicYearId = BigInt(dto.academicYearId);
    const outcome = await recoverConstraint(
      RUN_PERIOD_KEY,
      () => this.queueMonth(dto, academicYearId, regenerateVoided),
      async (error) => {
        const existing = await this.runs.findActive(schoolId, academicYearId, dto.period, 'monthly');
        if (!existing) throw error;
        return { created: false, run: existing };
      },
    );
    return { created: outcome.created, run: await this.runDto(schoolId, outcome.run) };
  }

  @Transactional()
  private async queueMonth(
    dto: GenerateMonthDto,
    academicYearId: bigint,
    regenerateVoided: boolean,
  ): Promise<{ created: boolean; run: ChargeRunRecord }> {
    const { schoolId, userId } = this.context.actor();
    const year = await this.years.findById(schoolId, academicYearId);
    if (!year) throw fieldRefused('academicYearId', ErrorCode.REFERENCE_NOT_FOUND, 'No such academic year');
    if (year.status === 'closed') throw monthNotGeneratable('year_closed');
    const months = yearMonths(year);
    if (dto.period < months.from || dto.period > months.to) throw monthNotGeneratable('outside_year');
    if (dto.period > periodOf(await this.clock.today(schoolId))) throw monthNotGeneratable('future');
    const existing = await this.runs.findActive(schoolId, year.id, dto.period, 'monthly');
    if (existing) return { created: false, run: existing };
    const run = await this.runs.createQueued(schoolId, {
      academicYearId: year.id,
      period: dto.period,
      kind: 'monthly',
      campaignId: null,
      triggeredBy: userId,
      regenerateVoided,
      queuedAt: new Date(),
    });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'charge_run.requested',
      subjectType: 'charge_run',
      subjectId: run.id,
      metadata: { academicYearId: year.id.toString(), period: dto.period, regenerateVoided },
    });
    this.outbox.chargeRunAfterCommit(schoolId, run.id);
    return { created: true, run };
  }

  async listRuns(query: ListChargeRunsQueryDto): Promise<Page<ChargeRunDto>> {
    const schoolId = this.context.schoolId;
    const { rows, total } = await this.runs.list(schoolId, {
      ...(query.academicYearId === undefined ? {} : { academicYearId: BigInt(query.academicYearId) }),
      ...(query.period === undefined ? {} : { period: query.period }),
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const names = await this.runs.classNames(
      schoolId,
      rows.flatMap((r) => skippedClassesOf(r).map((c) => BigInt(c.classId))),
    );
    return toPage(rows.map((r) => toChargeRunDto(r, names)), query, total);
  }

  async getRun(id: bigint): Promise<ChargeRunDto> {
    const schoolId = this.context.schoolId;
    const row = await this.runs.findById(schoolId, id);
    if (!row) throw notFound();
    return this.runDto(schoolId, row);
  }

  async runDto(schoolId: SchoolId, row: ChargeRunRecord): Promise<ChargeRunDto> {
    const names = await this.runs.classNames(schoolId, skippedClassesOf(row).map((c) => BigInt(c.classId)));
    return toChargeRunDto(row, names);
  }

  // ------------------------------------------------------------------------------ helpers

  /** The charge under its row lock, read after the lock. 404 when absent. */
  private async lockedCharge(schoolId: SchoolId, id: bigint): Promise<ChargeRecord> {
    if ((await this.charges.lockForUpdate(schoolId, [id])).length === 0) throw notFound();
    const row = await this.charges.findById(schoolId, id);
    if (!row) throw notFound();
    return row;
  }

  private async reload(schoolId: SchoolId, id: bigint): Promise<ChargeDto> {
    const row = await this.charges.findById(schoolId, id);
    if (!row) throw notFound();
    return toChargeDto(row);
  }

  private async outcome(
    schoolId: SchoolId,
    outcome: { replayed: true; subjectId: bigint } | { replayed: false; value: ChargeRecord },
  ): Promise<ChargeCreateOutcome> {
    if (outcome.replayed) {
      const row = await this.charges.findById(schoolId, outcome.subjectId);
      if (!row) throw notFound();
      return { replayed: true, charge: toChargeDto(row) };
    }
    return { replayed: false, charge: toChargeDto(outcome.value) };
  }

  /** The instant the school's day `day` starts (a `voidedFrom` filter). */
  private async dayStartOf(day: string): Promise<Date> {
    return dayStart(await this.clock.timezone(this.context.schoolId), fromDateString(day));
  }
}
