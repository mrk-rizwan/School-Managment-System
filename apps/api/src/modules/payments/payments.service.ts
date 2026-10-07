import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { allocate, ErrorCode, outstanding, type ExistingAdvance, type PaymentMethod } from '@asms/shared';
import { fieldRefused, notFound, ownChild } from '../../common/errors/api-exception';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { toPage, type Page } from '../../common/pagination';
import { SchoolClock } from '../../common/school-clock';
import { SchoolContext, type Actor } from '../../common/school-context';
import { NotificationService } from '../../messaging/notification.service';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ChangeContextRepository } from '../../repositories/change-context.repository';
import { ChargeRepository, type ChargeRecord } from '../../repositories/charge.repository';
import { PaymentAllocationRepository, type NewAllocation } from '../../repositories/payment-allocation.repository';
import { PaymentReversalRepository } from '../../repositories/payment-reversal.repository';
import { PaymentRepository, type PaymentRecord } from '../../repositories/payment.repository';
import { ReceiptRepository, type NewReceiptLine, type ReceiptRecord } from '../../repositories/receipt.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { PermissionsService } from '../access/permissions.service';
import { fromDateString, toDateString } from '../academics/academics.shared';
import type { StatementPaymentDto } from '../fees/charges.dto';
import { toChargeDto } from '../fees/charges.shared';
import { Advances, openCharge } from './advances';
import type {
  CreatePaymentDto,
  GuardianDuesDto,
  ListPaymentsQueryDto,
  PaymentDto,
  PaymentIntentDto,
  PaymentPreviewDto,
  ReceiptDto,
} from './payments.dto';
import {
  onceMore,
  paymentNothingDue,
  paymentSpansYears,
  receiptLabel,
  toReceiptDto,
  toReversalDto,
} from './payments.shared';

const ENDPOINT = 'payments';
const SUBJECT = 'payment';
/** The counter's family is bounded (GuardianDuesDto): ten children, fifty charges each. */
const FAMILY_CHILDREN = 10;
const CHILD_CHARGES = 50;

export interface PaymentCreateOutcome {
  replayed: boolean;
  payment: PaymentDto;
}

/** A checked PaymentIntentDto: the year, the children (in the order named) and the payer. */
interface Intent {
  academicYearId: bigint;
  yearName: string;
  studentIds: bigint[];
  payerGuardianId: bigint | null;
  payerName: string | null;
}

/**
 * Payments at the counter (phase-3-financial.md slice 20, §3.2, R187-R190, R236, R242, R249):
 * the family's dues, the preview, the record (payment, allocations over exactly the named
 * children with their advances spent first, the receipt with its number taken last, all in one
 * transaction in R236's lock order; receipt_issued after commit), the lists, and the receipt and
 * its print view. Finance keys are school-wide (rule 0.24); nobody records money for their own
 * child, with no exception (R232).
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly payments: PaymentRepository,
    private readonly allocations: PaymentAllocationRepository,
    private readonly receipts: ReceiptRepository,
    private readonly reversals: PaymentReversalRepository,
    private readonly charges: ChargeRepository,
    private readonly permissions: PermissionsService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditLogRepository,
    private readonly idempotency: IdempotentRequests,
    private readonly clock: SchoolClock,
    private readonly changeContext: ChangeContextRepository,
    private readonly advances: Advances,
  ) {}

  // -------------------------------------------------------------------------- the family

  /** GET /guardians/:id/dues: the counter's first screen, a family's dues grouped by year. */
  async guardianDues(guardianId: bigint): Promise<GuardianDuesDto> {
    const schoolId = this.context.schoolId;
    const guardian = await this.payments.findGuardian(schoolId, guardianId);
    if (!guardian) throw notFound();
    const children = await this.payments.liveChildren(schoolId, guardianId, FAMILY_CHILDREN);
    const ids = children.map((c) => c.studentId);
    const enrolments = await this.payments.enrolmentsOf(schoolId, ids);
    const open = await this.charges.openOfStudents(schoolId, ids);
    const advances = await this.payments.advances(schoolId, ids);
    const years = await this.payments.yearsByIds(schoolId, enrolments.map((e) => e.academicYearId));
    const latestYear = new Map<bigint, bigint>();
    for (const e of enrolments) {
      const seen = latestYear.get(e.studentId);
      const seenStart = seen === undefined ? undefined : years.get(seen)?.startsOn;
      if (seenStart === undefined || e.startsOn > seenStart) latestYear.set(e.studentId, e.academicYearId);
    }
    const name = new Map(children.map((c) => [c.studentId, c.fullName]));
    const rows = enrolments.flatMap((e) => {
      const charges = open.filter((c) => c.studentId === e.studentId && c.academicYearId === e.academicYearId);
      const owed = charges.reduce((sum, c) => sum + outstanding(c), 0);
      const advance = advances
        .filter((a) => a.studentId === e.studentId && a.academicYearId === e.academicYearId)
        .reduce((sum, a) => sum + a.unallocated, 0);
      if (owed === 0 && advance === 0 && latestYear.get(e.studentId) !== e.academicYearId) return [];
      return [
        {
          studentId: e.studentId.toString(),
          fullName: name.get(e.studentId) ?? '',
          className: e.className,
          enrolmentId: e.id.toString(),
          academicYearId: e.academicYearId.toString(),
          academicYearName: e.yearName,
          academicYearClosed: years.get(e.academicYearId)?.status === 'closed',
          outstanding: owed,
          advance,
          openCharges: charges.slice(0, CHILD_CHARGES).map(toChargeDto),
        },
      ];
    });
    return { guardianId: guardian.id.toString(), fullName: guardian.fullName, children: rows };
  }

  // ------------------------------------------------------------------------------ preview

  /** POST /payments/preview: allocate() over exactly the named children; writes nothing (R188). */
  async preview(dto: PaymentIntentDto): Promise<PaymentPreviewDto> {
    const actor = this.context.actor();
    const intent = await this.checkIntent(actor, dto);
    const open = await this.charges.openOfStudents(actor.schoolId, intent.studentIds, intent.academicYearId);
    const advances = await this.payments.advances(actor.schoolId, intent.studentIds, intent.academicYearId);
    const result = allocate(dto.amount, intent.studentIds, open.map(openCharge), advances);
    const byId = new Map(open.map((c) => [c.id, c]));
    return {
      allocations: result.allocations.map((a) => {
        const charge = byId.get(a.chargeId);
        return {
          chargeId: a.chargeId.toString(),
          studentId: a.studentId.toString(),
          studentName: charge?.enrolment.student.fullName ?? '',
          feeHeadName: charge?.feeHead.name ?? '',
          period: charge?.period ?? null,
          dueOn: charge ? toDateString(charge.dueOn) : '',
          amount: a.amount,
          fromAdvance: a.paymentId !== null,
        };
      }),
      remainder: result.remainder,
      outstanding: open.reduce((sum, c) => sum + outstanding(c), 0),
      advanceUsed: result.allocations.reduce((sum, a) => sum + (a.paymentId === null ? 0 : a.amount), 0),
    };
  }

  // ------------------------------------------------------------------------------- record

  /** POST /payments, keyed (endpoint payments, path id the payer guardian, else the student). */
  async record(dto: CreatePaymentDto, rawKey: string | undefined): Promise<PaymentCreateOutcome> {
    const actor = this.context.actor();
    const pathId = BigInt(dto.payerGuardianId ?? dto.studentIds[0] ?? '0');
    const outcome = await this.idempotency.withIdempotencyKey(actor, ENDPOINT, pathId, dto, rawKey, (claim) =>
      onceMore(() => this.recordInTransaction(actor, dto, claim)),
    );
    const id = outcome.replayed ? outcome.subjectId : outcome.value;
    return { replayed: outcome.replayed, payment: await this.get(id) };
  }

  @Transactional()
  private async recordInTransaction(actor: Actor, dto: CreatePaymentDto, claim: IdempotencyClaim): Promise<bigint> {
    const { schoolId, userId } = actor;
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, SUBJECT);
    // The allocation triggers check the acting user against every child (R232, no exception).
    await this.changeContext.setChangeContext(userId, null);
    const intent = await this.checkIntent(actor, dto);
    const reference = dto.reference ?? null;
    if (dto.method !== 'cash' && reference === null) {
      throw fieldRefused('reference', ErrorCode.INVALID_VALUE, 'A bank or wallet payment needs the slip reference');
    }
    const receivedOn = fromDateString(dto.receivedOn);
    if (receivedOn > (await this.clock.today(schoolId))) {
      throw fieldRefused('receivedOn', ErrorCode.INVALID_VALUE, 'receivedOn must be today or earlier');
    }
    const advanceFor = dto.advanceForStudentId === undefined ? null : BigInt(dto.advanceForStudentId);
    if (advanceFor !== null && !intent.studentIds.includes(advanceFor)) {
      throw fieldRefused('advanceForStudentId', ErrorCode.INVALID_VALUE, 'The advance must be for one of the named children');
    }
    const payment = await this.write(actor, intent, {
      method: dto.method,
      amount: dto.amount,
      receivedOn,
      reference,
      advanceFor,
      claimId: null,
    });
    await recordSubject(payment.id);
    return payment.id;
  }

  /**
   * Slice 21 (R196): a verified deposit claim recorded exactly as the counter records a payment —
   * the same checks (the payer guardian live-linked, the child enrolled in the year, never the
   * actor's own child), the same locks, allocation, receipt and receipt_issued — with the claim's
   * id on the payment. Runs in the caller's transaction, after it has locked the claim (contract
   * slice-21 §1.4). `beforeAllocate` runs under the charge locks, before allocation (the in-grace
   * late-fee waiver).
   */
  async recordForClaim(
    actor: Actor,
    input: {
      academicYearId: bigint;
      payerGuardianId: bigint;
      studentId: bigint;
      method: PaymentMethod;
      amount: number;
      receivedOn: Date;
      reference: string;
      advanceFor: bigint | null;
      claimId: bigint;
      beforeAllocate: (open: readonly ChargeRecord[], advances: readonly ExistingAdvance[]) => Promise<void>;
    },
  ): Promise<PaymentRecord> {
    await this.changeContext.setChangeContext(actor.userId, null);
    const intent = await this.checkIntent(actor, {
      academicYearId: input.academicYearId.toString(),
      payerGuardianId: input.payerGuardianId.toString(),
      studentIds: [input.studentId.toString()],
      amount: input.amount,
    });
    return this.write(actor, intent, input);
  }

  /**
   * The payment, its allocations and its receipt in R236's lock order (the advances' payments,
   * then the open charges by id, the receipt counter last), audited, with receipt_issued (§1.1).
   */
  private async write(
    actor: Actor,
    intent: Intent,
    input: {
      method: PaymentMethod;
      amount: number;
      receivedOn: Date;
      reference: string | null;
      advanceFor: bigint | null;
      claimId: bigint | null;
      beforeAllocate?: (open: readonly ChargeRecord[], advances: readonly ExistingAdvance[]) => Promise<void>;
    },
  ): Promise<PaymentRecord> {
    const { schoolId, userId } = actor;
    const advanceFor = input.advanceFor;
    // R236: the advances' payments, then the charges by id; the counter last.
    const advances = await this.payments.lockAdvances(schoolId, intent.studentIds, intent.academicYearId);
    await this.charges.lockForUpdate(
      schoolId,
      await this.charges.openIdsOfStudents(schoolId, intent.studentIds, intent.academicYearId),
    );
    if (input.beforeAllocate) {
      await input.beforeAllocate(await this.charges.openOfStudents(schoolId, intent.studentIds, intent.academicYearId), advances);
    }
    const open = await this.charges.openOfStudents(schoolId, intent.studentIds, intent.academicYearId);
    const result = allocate(input.amount, intent.studentIds, open.map(openCharge), advances);
    const owed = open.reduce((sum, c) => sum + outstanding(c), 0);
    const advanceUsed = result.allocations.reduce((sum, a) => sum + (a.paymentId === null ? 0 : a.amount), 0);
    if (owed - advanceUsed === 0 && advanceFor === null) {
      throw paymentNothingDue({ outstanding: owed, advanceUsed });
    }
    let advanceForStudentId: bigint | null = null;
    if (result.remainder > 0) {
      advanceForStudentId = advanceFor ?? (intent.studentIds.length === 1 ? (intent.studentIds[0] ?? null) : null);
      if (advanceForStudentId === null) {
        throw fieldRefused(
          'advanceForStudentId',
          ErrorCode.INVALID_VALUE,
          'This payment leaves an advance; name the child it is for',
        );
      }
    }

    const now = new Date();
    const payment = await this.payments.create(
      schoolId,
      {
        academicYearId: intent.academicYearId,
        payerGuardianId: intent.payerGuardianId,
        payerName: intent.payerName,
        method: input.method,
        amount: input.amount,
        receivedOn: input.receivedOn,
        reference: input.reference,
        carriedFromReversalId: null,
        recordedBy: userId,
        advanceForStudentId,
        claimId: input.claimId,
      },
      now,
    );
    const rows: NewAllocation[] = result.allocations.map((a) => ({
      paymentId: a.paymentId ?? payment.id,
      chargeId: a.chargeId,
      studentId: a.studentId,
      academicYearId: intent.academicYearId,
      amount: a.amount,
    }));
    await this.advances.insertMerged(schoolId, rows, now);

    const byId = new Map(open.map((c) => [c.id, c]));
    const lines: NewReceiptLine[] = result.allocations
      .filter((a) => a.paymentId === null)
      .map((a) => {
        const charge = byId.get(a.chargeId);
        return {
          studentId: a.studentId,
          chargeId: a.chargeId,
          feeHeadName: charge?.feeHead.name ?? '',
          period: charge?.period ?? null,
          amount: a.amount,
        };
      });
    if (result.remainder > 0 && advanceForStudentId !== null) {
      lines.push({ studentId: advanceForStudentId, chargeId: null, feeHeadName: null, period: null, amount: result.remainder });
    }
    // R190, R236: the year's counter, taken last.
    const receiptNo = await this.receipts.nextNumber(schoolId, intent.academicYearId);
    const receipt = await this.receipts.create(
      schoolId,
      { paymentId: payment.id, academicYearId: intent.academicYearId, receiptNo, amount: input.amount, issuedBy: userId, lines },
      now,
    );
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'payment.recorded',
      subjectType: SUBJECT,
      subjectId: payment.id,
      metadata: {
        amount: input.amount,
        method: input.method,
        academicYearId: intent.academicYearId.toString(),
        payerGuardianId: intent.payerGuardianId?.toString() ?? null,
        studentIds: intent.studentIds.join(','),
        allocated: rows.filter((r) => r.paymentId === payment.id).reduce((sum, r) => sum + r.amount, 0),
        advanceUsed,
        remainder: result.remainder,
        receiptNo,
        ...(input.claimId === null ? {} : { claimId: input.claimId.toString() }),
      },
    });
    // Every child who received money (from this payment or their advance) or holds its advance.
    const reached = new Set([...result.allocations.map((a) => a.studentId), ...(advanceForStudentId === null ? [] : [advanceForStudentId])]);
    await this.tellFamily(schoolId, intent, receipt, reached, owed - result.allocations.reduce((sum, a) => sum + a.amount, 0));
    return payment;
  }

  /** receipt_issued (R190, §1.1 "Receipt channel"), written in the payment's transaction. */
  private async tellFamily(
    schoolId: SchoolId,
    intent: Intent,
    receipt: ReceiptRecord,
    reached: ReadonlySet<bigint>,
    balance: number,
  ): Promise<void> {
    const paid = intent.studentIds.filter((id) => reached.has(id));
    const guardians = await this.payments.receiptRecipients(schoolId, paid);
    if (guardians.length === 0) return;
    const names = await this.payments.students(schoolId, paid);
    await this.notifications.send(schoolId, {
      type: 'receipt_issued',
      subject: { type: 'receipt', id: receipt.id },
      recipients: guardians.map((guardianId) => ({ guardianId })),
      vars: {
        receiptLabel: receiptLabel(receipt.receiptNo, intent.yearName),
        amount: receipt.amount,
        children: paid.map((id) => names.get(id)?.fullName ?? ''),
        yearName: intent.yearName,
        balance,
      },
    });
  }

  /**
   * The checks a preview and a record share (R187): the year, one payer, the named children each
   * enrolled in the year (else PAYMENT_SPANS_YEARS), live-linked to a paying guardian, one child
   * for a walk-in, and never the actor's own child (R232, no sole-principal exception for cash).
   */
  private async checkIntent(actor: Actor, dto: PaymentIntentDto): Promise<Intent> {
    const { schoolId, userId } = actor;
    const academicYearId = BigInt(dto.academicYearId);
    const year = (await this.payments.yearsByIds(schoolId, [academicYearId])).get(academicYearId);
    if (!year) throw fieldRefused('academicYearId', ErrorCode.REFERENCE_NOT_FOUND, 'No such academic year');
    if ((dto.payerGuardianId === undefined) === (dto.payerName === undefined)) {
      throw fieldRefused('payerGuardianId', ErrorCode.INVALID_VALUE, 'Name the paying guardian or a walk-in payer, not both');
    }
    const studentIds = dto.studentIds.map((id) => BigInt(id));
    studentIds.forEach((id, index) => {
      if (studentIds.indexOf(id) !== index) {
        throw fieldRefused(`studentIds[${index}]`, ErrorCode.INVALID_VALUE, 'This child is named twice');
      }
    });
    const students = await this.payments.students(schoolId, studentIds);
    studentIds.forEach((id, index) => {
      if (!students.has(id)) throw fieldRefused(`studentIds[${index}]`, ErrorCode.REFERENCE_NOT_FOUND, 'No such student');
    });
    let payerGuardianId: bigint | null = null;
    if (dto.payerGuardianId === undefined) {
      if (studentIds.length !== 1) {
        throw fieldRefused('studentIds', ErrorCode.INVALID_VALUE, 'A walk-in payer pays for one child only');
      }
    } else {
      payerGuardianId = BigInt(dto.payerGuardianId);
      const guardian = await this.payments.findGuardian(schoolId, payerGuardianId);
      if (!guardian) throw fieldRefused('payerGuardianId', ErrorCode.REFERENCE_NOT_FOUND, 'No such guardian');
      if (guardian.mergedIntoId !== null) {
        throw fieldRefused('payerGuardianId', ErrorCode.GUARDIAN_MERGED, 'This guardian was merged; use the surviving record');
      }
      const linked = await this.payments.linkedTo(schoolId, payerGuardianId, studentIds);
      studentIds.forEach((id, index) => {
        if (!linked.has(id)) {
          throw fieldRefused(`studentIds[${index}]`, ErrorCode.INVALID_VALUE, 'This child is not linked to the paying guardian');
        }
      });
    }
    const enrolled = new Set((await this.payments.enrolmentsOf(schoolId, studentIds, academicYearId)).map((e) => e.studentId));
    for (const id of studentIds) {
      if (!enrolled.has(id)) throw paymentSpansYears({ studentId: id.toString(), academicYearId: academicYearId.toString() });
    }
    for (const id of studentIds) {
      if (await this.permissions.actorIsGuardianOf(schoolId, userId, id)) throw ownChild();
    }
    return { academicYearId, yearName: year.name, studentIds, payerGuardianId, payerName: dto.payerName ?? null };
  }

  // -------------------------------------------------------------------------------- reads

  async list(query: ListPaymentsQueryDto): Promise<Page<PaymentDto>> {
    const schoolId = this.context.schoolId;
    const { rows, total } = await this.payments.list(schoolId, {
      ...(query.receivedFrom === undefined ? {} : { receivedFrom: fromDateString(query.receivedFrom) }),
      ...(query.receivedTo === undefined ? {} : { receivedTo: fromDateString(query.receivedTo) }),
      ...(query.method === undefined ? {} : { method: query.method }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.recordedByUserId === undefined ? {} : { recordedBy: BigInt(query.recordedByUserId) }),
      ...(query.studentId === undefined ? {} : { studentId: BigInt(query.studentId) }),
      ...(query.academicYearId === undefined ? {} : { academicYearId: BigInt(query.academicYearId) }),
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(await this.toDtos(schoolId, rows), query, total);
  }

  async get(id: bigint): Promise<PaymentDto> {
    const schoolId = this.context.schoolId;
    const row = await this.payments.findById(schoolId, id);
    if (!row) throw notFound();
    const [dto] = await this.toDtos(schoolId, [row]);
    if (!dto) throw notFound();
    return dto;
  }

  /** The payments of one handover (GET /cash-handovers/:id/payments). */
  async ofHandover(handoverId: bigint, query: { page: number; limit: number }): Promise<Page<PaymentDto>> {
    const schoolId = this.context.schoolId;
    const { rows, total } = await this.payments.list(schoolId, {
      handoverId,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(await this.toDtos(schoolId, rows), query, total);
  }

  async receipt(id: bigint): Promise<ReceiptDto> {
    const schoolId = this.context.schoolId;
    const row = await this.receipts.findById(schoolId, id);
    if (!row) throw notFound();
    return this.receiptDto(schoolId, row);
  }

  /** The receipt with what its print view shows besides it: the payment's payer and method. */
  async receiptForPrint(id: bigint): Promise<{ receipt: ReceiptDto; payment: PaymentDto }> {
    const receipt = await this.receipt(id);
    return { receipt, payment: await this.get(BigInt(receipt.paymentId)) };
  }

  /**
   * R205 for the statement (slice 19's StatementDto): the payments that paid this child's charges
   * of the year or hold their advance, with what each allocated to the child; and the advance.
   */
  async forStatement(studentId: bigint, academicYearId: bigint): Promise<{ payments: StatementPaymentDto[]; advance: number }> {
    const schoolId = this.context.schoolId;
    const live = await this.allocations.liveOfStudentYear(schoolId, studentId, academicYearId);
    const advances = await this.payments.advances(schoolId, [studentId], academicYearId);
    const ids = [...new Set([...live.map((a) => a.paymentId), ...advances.map((a) => a.paymentId)])];
    const rows = (await this.payments.findByIds(schoolId, ids)).filter((p) => p.status === 'verified');
    const receipts = new Map((await this.receipts.ofPayments(schoolId, ids)).map((r) => [r.paymentId, r]));
    const years = await this.payments.yearsByIds(schoolId, rows.map((p) => p.academicYearId));
    const payments = rows
      .sort((a, b) => a.receivedOn.getTime() - b.receivedOn.getTime() || (a.id < b.id ? -1 : 1))
      .map((p) => {
        const r = receipts.get(p.id);
        return {
          paymentId: p.id.toString(),
          receiptLabel: r ? receiptLabel(r.receiptNo, years.get(p.academicYearId)?.name ?? '') : null,
          receivedOn: toDateString(p.receivedOn),
          verifiedAt: p.verifiedAt,
          amount: p.amount,
          allocated: live.filter((a) => a.paymentId === p.id).reduce((sum, a) => sum + a.amount, 0),
          method: p.method,
        };
      });
    return { payments, advance: advances.reduce((sum, a) => sum + a.unallocated, 0) };
  }

  async receiptDto(schoolId: SchoolId, row: ReceiptRecord): Promise<ReceiptDto> {
    const year = (await this.payments.yearsByIds(schoolId, [row.academicYearId])).get(row.academicYearId);
    const users = await this.payments.userNames(schoolId, [row.issuedBy]);
    const students = await this.payments.students(schoolId, row.lines.map((l) => l.studentId));
    return toReceiptDto(row, {
      year: year?.name ?? '',
      issuedBy: users.get(row.issuedBy) ?? '',
      student: (id) => students.get(id)?.fullName ?? '',
    });
  }

  /** PaymentDto for a page of rows: every related read batched. */
  async toDtos(schoolId: SchoolId, rows: readonly PaymentRecord[]): Promise<PaymentDto[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const allocations = await this.allocations.ofPayments(schoolId, ids);
    const receipts = await this.receipts.ofPayments(schoolId, ids);
    const reversals = await this.reversals.ofPayments(schoolId, ids);
    const years = await this.payments.yearsByIds(schoolId, rows.map((r) => r.academicYearId));
    const users = await this.payments.userNames(schoolId, [
      ...rows.map((r) => r.recordedBy),
      ...receipts.map((r) => r.issuedBy),
      ...reversals.map((r) => r.requestedBy),
    ]);
    const guardians = await this.payments.guardianNames(
      schoolId,
      rows.flatMap((r) => (r.payerGuardianId === null ? [] : [r.payerGuardianId])),
    );
    const students = await this.payments.students(schoolId, [
      ...receipts.flatMap((r) => r.lines.map((l) => l.studentId)),
      ...rows.flatMap((r) => (r.advanceForStudentId === null ? [] : [r.advanceForStudentId])),
    ]);
    const studentName = (id: bigint) => students.get(id)?.fullName ?? '';
    const out: PaymentDto[] = [];
    for (const row of rows) {
      const receipt = receipts.find((r) => r.paymentId === row.id) ?? null;
      const own = reversals.filter((r) => r.paymentId === row.id);
      const perStudent = new Map<bigint, number>();
      for (const line of receipt?.lines ?? []) perStudent.set(line.studentId, (perStudent.get(line.studentId) ?? 0) + line.amount);
      if (receipt === null && row.advanceForStudentId !== null) perStudent.set(row.advanceForStudentId, row.amount);
      const duplicate =
        row.reference === null || row.method === 'cash' || row.method === 'carried_forward'
          ? null
          : await this.payments.sameSlip(schoolId, {
              method: row.method,
              reference: row.reference,
              receivedOn: row.receivedOn,
              excludeId: row.id,
            });
      out.push({
        id: row.id.toString(),
        academicYearId: row.academicYearId.toString(),
        payerGuardianId: row.payerGuardianId?.toString() ?? null,
        payerName: row.payerName ?? (row.payerGuardianId === null ? '' : (guardians.get(row.payerGuardianId) ?? '')),
        students: [...perStudent].map(([studentId, amount]) => ({
          studentId: studentId.toString(),
          fullName: studentName(studentId),
          amount,
        })),
        method: row.method,
        amount: row.amount,
        allocatedAmount: allocations
          .filter((a) => a.paymentId === row.id && a.reversedAt === null)
          .reduce((sum, a) => sum + a.amount, 0),
        unallocatedAmount: row.unallocatedAmount,
        advanceForStudentId: row.advanceForStudentId?.toString() ?? null,
        receivedOn: toDateString(row.receivedOn),
        verifiedAt: row.verifiedAt,
        reference: row.reference,
        recordedByUserId: row.recordedBy.toString(),
        recordedByName: users.get(row.recordedBy) ?? '',
        handoverId: row.handoverId?.toString() ?? null,
        claimId: row.claimId?.toString() ?? null,
        status: row.status,
        voidedAt: row.voidedAt,
        receipt:
          receipt === null
            ? null
            : toReceiptDto(receipt, {
                year: years.get(receipt.academicYearId)?.name ?? '',
                issuedBy: users.get(receipt.issuedBy) ?? '',
                student: studentName,
              }),
        reversals: own.map((r) =>
          toReversalDto(r, users.get(r.requestedBy) ?? '', own.some((o) => o.reversesId === r.id)),
        ),
        possibleDuplicate: duplicate !== null,
        duplicateOfPaymentId: duplicate?.toString() ?? null,
      });
    }
    return out;
  }
}

