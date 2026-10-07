import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, concurrentUpdate, fieldRefused, notFound, ownChild } from '../../common/errors/api-exception';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { SchoolClock } from '../../common/school-clock';
import { SchoolContext, type Actor } from '../../common/school-context';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { CashHandoverRepository } from '../../repositories/cash-handover.repository';
import { ChangeContextRepository } from '../../repositories/change-context.repository';
import { PaymentAllocationRepository } from '../../repositories/payment-allocation.repository';
import { PaymentReversalRepository, type ReversalRecord } from '../../repositories/payment-reversal.repository';
import { PaymentRepository, type PaymentRecord } from '../../repositories/payment.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { requirePrincipal } from '../access/money-gates';
import { PermissionsService } from '../access/permissions.service';
import type { ReasonDto } from '../../common/reason.dto';
import { Advances } from './advances';
import type {
  CarryForwardDto,
  CarryForwardResultDto,
  PaymentDto,
  RefundDto,
  ReversalDto,
  ReverseRefundDto,
  UndoCarryForwardDto,
} from './payments.dto';
import { PaymentsService } from './payments.service';
import {
  illegalTransition,
  nothingToCarryForward,
  notSelf,
  onceMore,
  paymentHasRefund,
  paymentInCustody,
  paymentVoided,
  refundExceedsUnallocated,
  toReversalDto,
} from './payments.shared';

const ENDPOINT = 'payment_reversals';
const SUBJECT = 'payment';

export interface ReversalOutcome<T> {
  replayed: boolean;
  value: T;
}

/**
 * Corrections of a payment, each a new row (phase-3-financial.md §3.2, §3.4, R191, R192, R232,
 * R242, R251): a void (`payment.void`, never by the recorder, refused inside an open handover and
 * while a refund or carry-forward stands), a refund and a refund reversal (`payment.void` and the
 * principal), and the year-end carry-forward of an advance (`payment.record`). Each locks the
 * payment first (R236); the triggers do the rest under the same lock. Cash keeps no
 * sole-principal exception: nobody reverses money paid for their own child.
 */
@Injectable()
export class PaymentReversalsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly payments: PaymentRepository,
    private readonly allocations: PaymentAllocationRepository,
    private readonly reversals: PaymentReversalRepository,
    private readonly handovers: CashHandoverRepository,
    private readonly advances: Advances,
    private readonly paymentsService: PaymentsService,
    private readonly permissions: PermissionsService,
    private readonly audit: AuditLogRepository,
    private readonly idempotency: IdempotentRequests,
    private readonly clock: SchoolClock,
    private readonly changeContext: ChangeContextRepository,
  ) {}

  // ---------------------------------------------------------------------------------- void

  /**
   * R191: the whole payment, with a reason. Reverses its live allocations (the charges reopen),
   * voids its receipt (the number stays) and takes a cash payment out of custody; refused to its
   * recorder, inside an open handover and while a refund or carry-forward stands. Not replayable:
   * a second void is PAYMENT_VOIDED.
   */
  async void(id: bigint, dto: ReasonDto): Promise<PaymentDto> {
    await onceMore(() => this.voidInTransaction(id, dto));
    return this.paymentsService.get(id);
  }

  @Transactional()
  private async voidInTransaction(id: bigint, dto: ReasonDto): Promise<void> {
    const { schoolId, userId } = this.context.actor();
    await this.changeContext.setChangeContext(userId, null);
    const pre = await this.payments.findById(schoolId, id);
    if (!pre) throw notFound();
    // R236: every lock the void and the re-application below need, up front, in the one order: this
    // payment and its children's advances, then the charges it paid and their open charges.
    const paid = (await this.allocations.ofPayments(schoolId, [id])).filter((a) => a.reversedAt === null);
    const children = [...new Set([...paid.map((a) => a.studentId), ...(pre.advanceForStudentId === null ? [] : [pre.advanceForStudentId])])];
    const lockedCharges = new Set(paid.map((a) => a.chargeId));
    await this.advances.lockFamily(schoolId, pre.academicYearId, children, [id], [...lockedCharges]);
    const row = await this.locked(schoolId, id);
    const live = (await this.allocations.ofPayments(schoolId, [id])).filter((a) => a.reversedAt === null);
    if (live.some((a) => !lockedCharges.has(a.chargeId))) throw concurrentUpdate();
    if (row.status === 'voided') throw paymentVoided({ paymentId: id.toString() });
    if (row.method === 'carried_forward') {
      throw illegalTransition('A carried-forward payment is not voided; refund or carry its advance instead.');
    }
    if (row.recordedBy === userId) {
      throw notSelf('You recorded this payment. Ask a colleague to void it.', { reason: 'recorder' });
    }
    const standing = await this.reversals.ofPayments(schoolId, [id]);
    if (netReversed(standing) > 0) throw paymentHasRefund({ paymentId: id.toString() });
    if (row.handoverId !== null && (await this.handovers.findById(schoolId, row.handoverId))?.status === 'open') {
      throw paymentInCustody({ paymentId: id.toString(), handoverId: row.handoverId.toString() });
    }
    await this.refuseOwnChild(schoolId, userId, row);
    const reversal = await this.reversals.create(
      schoolId,
      {
        paymentId: id,
        academicYearId: row.academicYearId,
        kind: 'void',
        reversesId: null,
        amount: row.amount,
        reason: dto.reason,
        requestedBy: userId,
        approvedBy: null,
        refundMethod: null,
        refundReference: null,
      },
      new Date(),
    );
    // The reopened charges are paid at once by the children's own advances in the year (A5).
    const applied = await this.advances.applyTo(schoolId, row.academicYearId, children);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'payment.voided',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: {
        reversalId: reversal.id.toString(),
        amount: row.amount,
        method: row.method,
        recordedByUserId: row.recordedBy.toString(),
        // §3.4: a cash void in custody leaves it (voidedBeforeHandover); after a confirmed one it is
        // voidedAfterHandover on the daily cash report.
        custody: row.method !== 'cash' ? 'none' : row.handoverId === null ? 'before_handover' : 'after_handover',
        applied: applied.amount,
      },
    });
  }

  // -------------------------------------------------------------------------------- refund

  /** R192: at most the unallocated amount (the advance), by a principal, with method and reason. */
  async refund(session: SchoolSessionContext, id: bigint, dto: RefundDto, rawKey: string | undefined): Promise<ReversalOutcome<ReversalDto>> {
    requirePrincipal(session);
    return this.keyed(id, dto, rawKey, (actor, claim) => this.refundInTransaction(actor, id, dto, claim));
  }

  @Transactional()
  private async refundInTransaction(actor: Actor, id: bigint, dto: RefundDto, claim: IdempotencyClaim): Promise<bigint> {
    const { schoolId, userId } = actor;
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, 'payment_reversal');
    await this.changeContext.setChangeContext(userId, null);
    const row = await this.locked(schoolId, id);
    if (row.status === 'voided') throw paymentVoided({ paymentId: id.toString() });
    if (dto.amount > row.unallocatedAmount) {
      throw refundExceedsUnallocated({ paymentId: id.toString(), unallocated: row.unallocatedAmount });
    }
    await this.refuseOwnChild(schoolId, userId, row);
    const reversal = await this.reversals.create(
      schoolId,
      {
        paymentId: id,
        academicYearId: row.academicYearId,
        kind: 'refund',
        reversesId: null,
        amount: dto.amount,
        reason: dto.reason,
        requestedBy: userId,
        approvedBy: userId,
        refundMethod: dto.method,
        refundReference: dto.reference ?? null,
      },
      new Date(),
    );
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'payment.refunded',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: {
        reversalId: reversal.id.toString(),
        amount: dto.amount,
        method: dto.method,
        advanceForStudentId: row.advanceForStudentId?.toString() ?? null,
      },
    });
    await recordSubject(reversal.id);
    return reversal.id;
  }

  /** R192: a refund undone by a further row, restoring the advance; principal only. */
  async reverseRefund(
    session: SchoolSessionContext,
    id: bigint,
    dto: ReverseRefundDto,
    rawKey: string | undefined,
  ): Promise<ReversalOutcome<ReversalDto>> {
    requirePrincipal(session);
    return this.keyed(id, dto, rawKey, (actor, claim) => this.reverseRefundInTransaction(actor, id, dto, claim));
  }

  @Transactional()
  private async reverseRefundInTransaction(actor: Actor, id: bigint, dto: ReverseRefundDto, claim: IdempotencyClaim): Promise<bigint> {
    const { schoolId, userId } = actor;
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, 'payment_reversal');
    await this.changeContext.setChangeContext(userId, null);
    const row = await this.locked(schoolId, id);
    if (row.status === 'voided') throw paymentVoided({ paymentId: id.toString() });
    const standing = await this.reversals.ofPayments(schoolId, [id]);
    const refund = standing.find((r) => r.id === BigInt(dto.reversalId));
    if (!refund || refund.kind !== 'refund') {
      throw fieldRefused('reversalId', ErrorCode.REFERENCE_NOT_FOUND, 'No such refund of this payment');
    }
    if (standing.some((r) => r.reversesId === refund.id)) throw illegalTransition('This refund has already been reversed.');
    await this.refuseOwnChild(schoolId, userId, row);
    const reversal = await this.reversals.create(
      schoolId,
      {
        paymentId: id,
        academicYearId: row.academicYearId,
        kind: 'refund_reversal',
        reversesId: refund.id,
        amount: refund.amount,
        reason: dto.reason,
        requestedBy: userId,
        approvedBy: userId,
        refundMethod: null,
        refundReference: null,
      },
      new Date(),
    );
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'payment.refund_reversed',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: { reversalId: reversal.id.toString(), refundId: refund.id.toString(), amount: refund.amount },
    });
    await recordSubject(reversal.id);
    return reversal.id;
  }

  // ------------------------------------------------------------------------- carry forward

  /**
   * R251, A5: an advance left in one year moves to another as a carried_forward reversal plus a
   * new carried_forward payment there (linked both ways, checked at commit), bound to the same
   * child, who needs an enrolment in the target year; it then pays that child's open charges
   * there oldest first. No cash moves: no receipt, never collections. `payment.record`.
   */
  async carryForward(id: bigint, dto: CarryForwardDto, rawKey: string | undefined): Promise<ReversalOutcome<CarryForwardResultDto>> {
    const outcome = await this.keyed(id, dto, rawKey, (actor, claim) => this.carryInTransaction(actor, id, dto, claim));
    const schoolId = this.context.schoolId;
    const reversal = await this.reversals.findById(schoolId, BigInt(outcome.value.id));
    if (!reversal?.carriedToPaymentId) throw notFound();
    return {
      replayed: outcome.replayed,
      value: { reversal: outcome.value, payment: await this.paymentsService.get(reversal.carriedToPaymentId) },
    };
  }

  @Transactional()
  private async carryInTransaction(actor: Actor, id: bigint, dto: CarryForwardDto, claim: IdempotencyClaim): Promise<bigint> {
    const { schoolId, userId } = actor;
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, 'payment_reversal');
    await this.changeContext.setChangeContext(userId, null);
    const source = await this.payments.findById(schoolId, id);
    if (!source) throw notFound();
    const target = BigInt(dto.academicYearId);
    // R236: the source and the child's advances in the target year, locked together in id order.
    const targetAdvances =
      source.advanceForStudentId === null ? [] : await this.payments.advances(schoolId, [source.advanceForStudentId], target);
    await this.payments.lockForUpdate(schoolId, [id, ...targetAdvances.map((a) => a.paymentId)]);
    const row = await this.payments.findById(schoolId, id);
    if (!row) throw notFound();
    // The child as the locked row names it (advance_for_student_id is set once, so it is the same).
    const child = row.advanceForStudentId;
    if (row.status === 'voided') throw paymentVoided({ paymentId: id.toString() });
    if (row.unallocatedAmount === 0 || child === null) throw nothingToCarryForward({ paymentId: id.toString(), unallocated: 0 });
    const amount = dto.amount ?? row.unallocatedAmount;
    if (amount > row.unallocatedAmount) {
      throw nothingToCarryForward({ paymentId: id.toString(), unallocated: row.unallocatedAmount });
    }
    const year = (await this.payments.yearsByIds(schoolId, [target])).get(target);
    if (!year) throw fieldRefused('academicYearId', ErrorCode.REFERENCE_NOT_FOUND, 'No such academic year');
    if (target === row.academicYearId) {
      throw fieldRefused('academicYearId', ErrorCode.INVALID_VALUE, 'The advance is already in that academic year');
    }
    // Main-thread decision (review 2026-10-06): an advance moves forward only, into a later year.
    const from = (await this.payments.yearsByIds(schoolId, [row.academicYearId])).get(row.academicYearId);
    if (!from || year.startsOn <= from.startsOn) {
      throw fieldRefused('academicYearId', ErrorCode.INVALID_VALUE, 'An advance is carried forward into a later academic year only');
    }
    if ((await this.payments.enrolmentsOf(schoolId, [child], target)).length === 0) {
      throw fieldRefused('academicYearId', ErrorCode.INVALID_VALUE, 'The child has no enrolment in that academic year');
    }
    await this.refuseOwnChild(schoolId, userId, row);
    const now = new Date();
    const reversal = await this.reversals.create(
      schoolId,
      {
        paymentId: id,
        academicYearId: row.academicYearId,
        kind: 'carried_forward',
        reversesId: null,
        amount,
        reason: dto.reason,
        requestedBy: userId,
        approvedBy: null,
        refundMethod: null,
        refundReference: null,
      },
      now,
    );
    const carried = await this.payments.create(
      schoolId,
      {
        academicYearId: target,
        payerGuardianId: row.payerGuardianId,
        payerName: row.payerName,
        method: 'carried_forward',
        amount,
        receivedOn: await this.clock.today(schoolId),
        reference: null,
        carriedFromReversalId: reversal.id,
        recordedBy: userId,
        advanceForStudentId: child,
      },
      now,
    );
    await this.reversals.linkCarriedTo(schoolId, reversal.id, carried.id);
    const applied = await this.advances.applyTo(schoolId, target, [child]);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'payment.carried_forward',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: {
        reversalId: reversal.id.toString(),
        carriedToPaymentId: carried.id.toString(),
        amount,
        fromAcademicYearId: row.academicYearId.toString(),
        toAcademicYearId: target.toString(),
        studentId: child.toString(),
        applied: applied.amount,
      },
    });
    await recordSubject(reversal.id);
    return reversal.id;
  }

  /**
   * Phase close G1: a carry-forward undone, while the carried payment in the target year is still
   * live and wholly unallocated (nothing paid from it, nothing refunded or carried on). A
   * carry_forward_reversal row on the source payment names the carry-forward; the triggers raise
   * the source's advance back and void the carried payment (rule 4: nothing is edited or
   * deleted). The restored advance then pays the child's open charges in its year (A5), as the
   * carry-forward does in the target. Same gate, key and own-child rule as the carry-forward.
   */
  async undoCarryForward(id: bigint, dto: UndoCarryForwardDto, rawKey: string | undefined): Promise<ReversalOutcome<ReversalDto>> {
    return this.keyed(id, dto, rawKey, (actor, claim) => this.undoCarryInTransaction(actor, id, dto, claim));
  }

  @Transactional()
  private async undoCarryInTransaction(actor: Actor, id: bigint, dto: UndoCarryForwardDto, claim: IdempotencyClaim): Promise<bigint> {
    const { schoolId, userId } = actor;
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, 'payment_reversal');
    await this.changeContext.setChangeContext(userId, null);
    const carry = (await this.reversals.ofPayments(schoolId, [id])).find((r) => r.id === BigInt(dto.reversalId));
    if (!carry || carry.kind !== 'carried_forward' || carry.carriedToPaymentId === null) {
      throw fieldRefused('reversalId', ErrorCode.REFERENCE_NOT_FOUND, 'No such carry-forward of this payment');
    }
    const carriedId = carry.carriedToPaymentId;
    // R236: the source and the carried payment, in id order.
    await this.payments.lockForUpdate(schoolId, [id, carriedId]);
    const row = await this.payments.findById(schoolId, id);
    if (!row) throw notFound();
    if (row.status === 'voided') throw paymentVoided({ paymentId: id.toString() });
    const standing = await this.reversals.ofPayments(schoolId, [id, carriedId]);
    if (standing.some((r) => r.reversesId === carry.id)) throw illegalTransition('This carry-forward has already been undone.');
    const carried = await this.payments.findById(schoolId, carriedId);
    const carriedReversed = netReversed(standing.filter((r) => r.paymentId === carriedId));
    if (!carried || carried.status === 'voided' || carried.unallocatedAmount !== carried.amount || carriedReversed > 0) {
      throw carriedSpent(carriedId);
    }
    if (row.advanceForStudentId === null) throw notFound();
    await this.refuseOwnChild(schoolId, userId, row);
    const reversal = await this.reversals.create(
      schoolId,
      {
        paymentId: id,
        academicYearId: row.academicYearId,
        kind: 'carry_forward_reversal',
        reversesId: carry.id,
        amount: carry.amount,
        reason: dto.reason,
        requestedBy: userId,
        approvedBy: null,
        refundMethod: null,
        refundReference: null,
      },
      new Date(),
    );
    const applied = await this.advances.applyTo(schoolId, row.academicYearId, [row.advanceForStudentId]);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'payment.carry_forward_reversed',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: {
        reversalId: reversal.id.toString(),
        carryForwardId: carry.id.toString(),
        carriedPaymentId: carriedId.toString(),
        amount: carry.amount,
        fromAcademicYearId: carried.academicYearId.toString(),
        toAcademicYearId: row.academicYearId.toString(),
        studentId: row.advanceForStudentId.toString(),
        applied: applied.amount,
      },
    });
    await recordSubject(reversal.id);
    return reversal.id;
  }

  // ------------------------------------------------------------------------------ helpers

  /** A keyed reversal (endpoint payment_reversals, path id the payment): the row as its DTO. */
  private async keyed(
    paymentId: bigint,
    dto: object,
    rawKey: string | undefined,
    run: (actor: Actor, claim: IdempotencyClaim) => Promise<bigint>,
  ): Promise<ReversalOutcome<ReversalDto>> {
    const actor = this.context.actor();
    if (!(await this.payments.findById(actor.schoolId, paymentId))) throw notFound();
    const outcome = await this.idempotency.withIdempotencyKey(actor, ENDPOINT, paymentId, dto, rawKey, (claim) =>
      onceMore(() => run(actor, claim)),
    );
    const id = outcome.replayed ? outcome.subjectId : outcome.value;
    return { replayed: outcome.replayed, value: await this.reversalDto(actor.schoolId, id) };
  }

  private async reversalDto(schoolId: SchoolId, id: bigint): Promise<ReversalDto> {
    const row = await this.reversals.findById(schoolId, id);
    if (!row) throw notFound();
    const names = await this.payments.userNames(schoolId, [row.requestedBy]);
    const all = await this.reversals.ofPayments(schoolId, [row.paymentId]);
    return toReversalDto(row, names.get(row.requestedBy) ?? '', all.some((r) => r.reversesId === row.id));
  }

  /** The payment under its row lock (the first lock of R236), read after it; 404 when absent. */
  private async locked(schoolId: SchoolId, id: bigint): Promise<PaymentRecord> {
    if ((await this.payments.lockForUpdate(schoolId, [id])).length === 0) throw notFound();
    const row = await this.payments.findById(schoolId, id);
    if (!row) throw notFound();
    return row;
  }

  /**
   * R232 with no exception: the actor is a guardian of a child this payment paid for or holds an
   * advance for (the payment_reversals_own_child trigger refuses the same).
   */
  private async refuseOwnChild(schoolId: SchoolId, userId: bigint, row: PaymentRecord): Promise<void> {
    const children = new Set((await this.allocations.ofPayments(schoolId, [row.id])).map((a) => a.studentId));
    if (row.advanceForStudentId !== null) children.add(row.advanceForStudentId);
    if (row.payerGuardianId !== null && (await this.payments.userIsGuardian(schoolId, userId, row.payerGuardianId))) {
      throw ownChild();
    }
    for (const studentId of children) {
      if (await this.permissions.actorIsGuardianOf(schoolId, userId, studentId)) throw ownChild();
    }
  }
}

/** Refunds and carry-forwards standing on a payment, net of their reversals. */
const netReversed = (rows: readonly ReversalRecord[]): number =>
  rows.reduce(
    (sum, r) =>
      r.kind === 'refund' || r.kind === 'carried_forward'
        ? sum + r.amount
        : r.kind === 'refund_reversal' || r.kind === 'carry_forward_reversal'
          ? sum - r.amount
          : sum,
    0,
  );

/** Phase close G1: the carried payment paid something, or was refunded or carried on. */
const carriedSpent = (carriedPaymentId: bigint) =>
  new ApiException(
    409,
    ErrorCode.ILLEGAL_STATUS_TRANSITION,
    'The carried advance has already been used or refunded in the new year, so this carry-forward cannot be undone.',
    { reason: 'carried_spent', carriedPaymentId: carriedPaymentId.toString() },
  );
