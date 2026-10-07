import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { allocate, Capability, ErrorCode, outstanding, type DepositMethod, type ExistingAdvance, type PaymentMethod } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, fieldRefused, notFound, ownChild } from '../../common/errors/api-exception';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { readLocked } from '../../common/locking';
import { toPage, type Page } from '../../common/pagination';
import { addDays, dayStart, SchoolClock, todayIn } from '../../common/school-clock';
import { SchoolContext, type Actor } from '../../common/school-context';
import { NotificationService } from '../../messaging/notification.service';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ChargeRepository, type ChargeRecord } from '../../repositories/charge.repository';
import { PaymentAccountRepository } from '../../repositories/payment-account.repository';
import { PaymentClaimRepository, type ClaimImage, type ClaimRecord } from '../../repositories/payment-claim.repository';
import { PaymentRepository } from '../../repositories/payment.repository';
import { ReceiptRepository } from '../../repositories/receipt.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import { StagedUploadRepository, type StagedUploadRecord } from '../../repositories/staged-upload.repository';
import { UserRepository } from '../../repositories/user.repository';
import { AfterCommit } from '../../tenancy/after-commit';
import type { SchoolId } from '../../tenancy/school-id';
import { fromDateString, toDateString } from '../academics/academics.shared';
import { PermissionsService } from '../access/permissions.service';
import { AttachmentFiles, type AttachedFile } from '../documents/attachment-files.service';
import { stagedUploadUnusable } from '../documents/documents.service';
import { openCharge } from './advances';
import type {
  ClaimDto,
  ClaimImageDto,
  CreateClaimDto,
  ListClaimsQueryDto,
  MyClaimDto,
  RejectClaimDto,
  VerifiedClaimDto,
  VerifyClaimDto,
  WithdrawClaimDto,
} from './claims.dto';
import { requireMyChild } from './my-fees.service';
import { onceMore } from './payments.shared';
import { PaymentsService } from './payments.service';

// phase-3-financial.md slice 21, §3.1, §3.2, §3.9 (R196-R200, R243, R249); contracts/slice-21.md.
// A claim is never a payment (rule 10): only a verification records one, through the counter's own
// path (PaymentsService.recordForClaim). The database holds the same rules as triggers (migration
// 20261006170000_slice21_payment_claims); the service refuses first, with the contract's codes.

const ENDPOINT = 'payment_claims';
const SUBJECT = 'payment_claim';
/** R199: at most this many claims per guardian per school day, image-less ones included. */
export const DAILY_CLAIMS = 10;
/** R200: an image-less claim expires after this long. */
export const IMAGELESS_CLAIM_TTL_MS = 24 * 60 * 60_000;
/** The waiver reason the plan names (slice 19: a claim verified inside the grace waives the late fee). */
export const IN_GRACE_WAIVE_REASON = 'paid_on_time_verified_late';
/** The school_settings default, for a school that has no settings row yet. */
const DEFAULT_GRACE_DAYS = 7;
/** A merge chain is at most five steps (asms_guardian_merge_family). */
const MERGE_STEPS = 5;

const claimRefusal = (code: ErrorCode, message: string) => (claimId: bigint, extra: Record<string, unknown> = {}) =>
  new ApiException(409, code, message, { claimId: claimId.toString(), ...extra });

export const claimNotPending = claimRefusal(ErrorCode.CLAIM_NOT_PENDING, 'This claim has already been decided.');
export const claimImageMissing = claimRefusal(ErrorCode.CLAIM_IMAGE_MISSING, 'This claim has no slip yet.');
export const claimImageExists = claimRefusal(ErrorCode.CLAIM_IMAGE_EXISTS, 'This claim already has its slip.');

export const claimsNotAccepted = (): ApiException =>
  new ApiException(
    409,
    ErrorCode.CLAIMS_NOT_ACCEPTED,
    'The school does not take deposit slips: it has no bank or wallet account. Pay at the office.',
  );

const claimLimitReached = (): ApiException =>
  new ApiException(409, ErrorCode.CLAIM_LIMIT_REACHED, `At most ${DAILY_CLAIMS} deposit slips a day. Try again tomorrow.`, {
    limit: DAILY_CLAIMS,
  });

export interface ClaimCreateOutcome {
  replayed: boolean;
  claim: MyClaimDto;
}

/** A claim's method is a deposit (CHECK payment_claims_method_check). */
function depositMethod(method: PaymentMethod): DepositMethod {
  if (method === 'bank_transfer' || method === 'jazzcash' || method === 'easypaisa') return method;
  throw new Error('a claim is a bank or wallet deposit');
}

/** Whose claim: the session's guardian record (the guardian capacity requires one). */
function myGuardianId(session: SchoolSessionContext): bigint {
  const id = session.access.guardianId;
  if (id === null) throw notFound();
  return id;
}

@Injectable()
export class ClaimsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly claims: PaymentClaimRepository,
    private readonly payments: PaymentRepository,
    private readonly paymentsService: PaymentsService,
    private readonly receipts: ReceiptRepository,
    private readonly charges: ChargeRepository,
    private readonly accounts: PaymentAccountRepository,
    private readonly staged: StagedUploadRepository,
    private readonly attachments: AttachmentFiles,
    private readonly afterCommit: AfterCommit,
    private readonly users: UserRepository,
    private readonly settings: SchoolSettingsRepository,
    private readonly permissions: PermissionsService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditLogRepository,
    private readonly idempotency: IdempotentRequests,
    private readonly clock: SchoolClock,
  ) {}

  // ================================================================== the guardian (/me/children/:id)

  /** POST /me/children/:id/payment-claims, keyed (endpoint payment_claims, path id the student). */
  async create(
    session: SchoolSessionContext,
    studentId: bigint,
    dto: CreateClaimDto,
    rawKey: string | undefined,
  ): Promise<ClaimCreateOutcome> {
    requireMyChild(session, studentId);
    const actor = this.context.actor();
    const outcome = await this.idempotency.withIdempotencyKey(actor, ENDPOINT, studentId, dto, rawKey, (claim) =>
      this.createInTransaction(session, actor, studentId, dto, claim),
    );
    const id = outcome.replayed ? outcome.subjectId : outcome.value;
    return { replayed: outcome.replayed, claim: await this.getMine(session, studentId, id) };
  }

  @Transactional()
  private async createInTransaction(
    session: SchoolSessionContext,
    actor: Actor,
    studentId: bigint,
    dto: CreateClaimDto,
    claim: IdempotencyClaim,
  ): Promise<bigint> {
    // The first statement: a racing same-key request now waits on the unique index.
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, SUBJECT);
    const { schoolId } = actor;
    const guardianId = myGuardianId(session);
    // R196: a claim exists only while the school has an active payment account.
    if (!(await this.accounts.anyActive(schoolId))) throw claimsNotAccepted();
    const timezone = await this.clock.timezone(schoolId);
    const today = todayIn(timezone, this.clock.now());
    const paidOn = fromDateString(dto.paidOn);
    if (paidOn > today) throw fieldRefused('paidOn', ErrorCode.INVALID_VALUE, 'paidOn must be today or earlier');
    // R199: the guardian's claims of the school day, counted under a lock on the guardian.
    if (!(await this.payments.lockGuardian(schoolId, guardianId))) throw notFound();
    if ((await this.claims.countSince(schoolId, guardianId, dayStart(timezone, today))) >= DAILY_CLAIMS) {
      throw claimLimitReached();
    }
    const image = dto.stagedUploadId === undefined ? null : await this.consume(actor, BigInt(dto.stagedUploadId));
    const row = await this.claims.create(schoolId, {
      studentId,
      guardianId,
      method: dto.method,
      claimedAmount: dto.claimedAmount,
      paidOn,
      reference: dto.reference ?? null,
      note: dto.note ?? null,
      image,
    });
    await recordSubject(row.id);
    await this.audit.record(schoolId, {
      actorUserId: actor.userId,
      action: 'payment_claim.submitted',
      subjectType: SUBJECT,
      subjectId: row.id,
      metadata: {
        studentId: studentId.toString(),
        method: row.method,
        claimedAmount: row.claimedAmount,
        paidOn: dto.paidOn,
        hasImage: image !== null,
      },
    });
    // R200: the verifiers hear of it once, when the slip lands.
    if (image !== null) await this.tellVerifiers(schoolId, row);
    return row.id;
  }

  /**
   * PATCH /me/children/:id/payment-claims/:claimId: the slip, once, by the submitter (R243). The
   * same upload sent again answers 200 unchanged; a different one is CLAIM_IMAGE_EXISTS.
   */
  @Transactional()
  async attachImage(
    session: SchoolSessionContext,
    studentId: bigint,
    claimId: bigint,
    dto: ClaimImageDto,
  ): Promise<MyClaimDto> {
    const actor = this.context.actor();
    const { schoolId, userId } = actor;
    const row = await this.mySubmitted(session, studentId, claimId);
    const [staged] = await this.staged.findOwned(schoolId, userId, [BigInt(dto.stagedUploadId)]);
    const sameUpload = (key: string | null) => staged !== undefined && key === staged.objectKey;
    if (row.imageObjectKey !== null) {
      if (sameUpload(row.imageObjectKey)) return this.toMyDto(session, row);
      throw claimImageExists(claimId);
    }
    if (row.status !== 'pending') throw claimNotPending(claimId);
    const image = staged === undefined ? null : await this.tryConsume(actor, staged);
    if (image === null) {
      // A concurrent send of the same upload consumed it first and has committed (the consume
      // waited on its row lock): that is this request's outcome.
      const now = await this.mySubmitted(session, studentId, claimId);
      if (sameUpload(now.imageObjectKey)) return this.toMyDto(session, now);
      throw stagedUploadUnusable('stagedUploadId');
    }
    if ((await this.claims.setImage(schoolId, claimId, image)) !== 1) {
      const now = await this.mySubmitted(session, studentId, claimId);
      throw now.status === 'pending' ? claimImageExists(claimId) : claimNotPending(claimId);
    }
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'payment_claim.image_attached',
      subjectType: SUBJECT,
      subjectId: claimId,
      metadata: { studentId: studentId.toString(), mime: image.mime, sizeBytes: image.sizeBytes },
    });
    await this.tellVerifiers(schoolId, row);
    return this.toMyDto(session, await this.mySubmitted(session, studentId, claimId));
  }

  /** POST /me/children/:id/payment-claims/:claimId/withdraw: the submitter, while pending. */
  @Transactional()
  async withdraw(
    session: SchoolSessionContext,
    studentId: bigint,
    claimId: bigint,
    dto: WithdrawClaimDto,
  ): Promise<MyClaimDto> {
    const { schoolId, userId } = this.context.actor();
    const row = await this.mySubmitted(session, studentId, claimId);
    if (row.status !== 'pending') throw claimNotPending(claimId);
    const reason = dto.reason ?? null;
    const decided = await this.claims.decide(
      schoolId,
      claimId,
      { status: 'withdrawn', decidedBy: userId, decisionReason: reason },
      new Date(),
    );
    if (decided !== 1) throw claimNotPending(claimId);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'payment_claim.withdrawn',
      subjectType: SUBJECT,
      subjectId: claimId,
      ...(reason === null ? {} : { reason }),
      metadata: { studentId: studentId.toString(), claimedAmount: row.claimedAmount },
    });
    return this.toMyDto(session, await this.mySubmitted(session, studentId, claimId));
  }

  /** GET /me/children/:id/payment-claims: every live login link of the child reads them (R198). */
  async listMine(
    session: SchoolSessionContext,
    studentId: bigint,
    query: { page: number; limit: number },
  ): Promise<Page<MyClaimDto>> {
    requireMyChild(session, studentId);
    const schoolId = this.context.schoolId;
    const { rows, total } = await this.claims.listOfStudent(schoolId, studentId, {
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(await this.toMyDtos(session, schoolId, rows), query, total);
  }

  async getMine(session: SchoolSessionContext, studentId: bigint, claimId: bigint): Promise<MyClaimDto> {
    requireMyChild(session, studentId);
    const row = await this.claims.findOfStudent(this.context.schoolId, studentId, claimId);
    if (!row) throw notFound();
    return this.toMyDto(session, row);
  }

  /** The slip or its thumbnail: the submitter's user only; another linked guardian 404 (R198). */
  async myImage(session: SchoolSessionContext, studentId: bigint, claimId: bigint, thumb: boolean): Promise<AttachedFile> {
    return this.openImage(await this.mySubmitted(session, studentId, claimId), thumb);
  }

  // ========================================================================= the office (payment.verify)

  async list(query: ListClaimsQueryDto): Promise<Page<ClaimDto>> {
    const schoolId = this.context.schoolId;
    const timezone = await this.clock.timezone(schoolId);
    const { rows, total } = await this.claims.list(schoolId, {
      status: query.status ?? 'pending',
      // R243: image-less claims are listed only on request.
      hasImage: query.hasImage ?? true,
      ...(query.studentId === undefined ? {} : { studentId: BigInt(query.studentId) }),
      ...(query.createdFrom === undefined ? {} : { createdFrom: dayStart(timezone, fromDateString(query.createdFrom)) }),
      ...(query.createdTo === undefined
        ? {}
        : { createdTo: dayStart(timezone, addDays(fromDateString(query.createdTo), 1)) }),
      sort: query.sort ?? 'createdAt',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(await this.toDtos(schoolId, rows), query, total);
  }

  async get(id: bigint): Promise<ClaimDto> {
    const schoolId = this.context.schoolId;
    const row = await this.claims.findById(schoolId, id);
    if (!row) throw notFound();
    const [dto] = await this.toDtos(schoolId, [row]);
    if (!dto) throw notFound();
    return dto;
  }

  /**
   * The slip or its thumbnail, on tap only (never in a list, R198). Not to a verifier of the
   * child's family (R197): they cannot decide the claim, so they do not read the slip either (404).
   */
  async image(id: bigint, thumb: boolean): Promise<AttachedFile> {
    const { schoolId, userId } = this.context.actor();
    const row = await this.claims.findById(schoolId, id);
    if (!row || (await this.isOwnFamily(schoolId, userId, row))) throw notFound();
    return this.openImage(row, thumb);
  }

  /**
   * POST /payment-claims/:id/verify (R196, R197, A15): records the payment exactly as the counter
   * does, with the receipt and receipt_issued, waives an in-grace late fee, and marks the claim
   * verified — one transaction (contract slice-21 §1.4), retried once on CONCURRENT_UPDATE. Not
   * replayable: a second verify is 409 CLAIM_NOT_PENDING.
   */
  async verify(id: bigint, dto: VerifyClaimDto): Promise<VerifiedClaimDto> {
    const actor = this.context.actor();
    const paymentId = await onceMore(() => this.verifyInTransaction(actor, id, dto));
    return { ...(await this.get(id)), payment: await this.paymentsService.get(paymentId) };
  }

  @Transactional()
  private async verifyInTransaction(actor: Actor, id: bigint, dto: VerifyClaimDto): Promise<bigint> {
    const { schoolId, userId } = actor;
    // The claim first; the payment's locks follow in the counter's order (R236).
    const claim = await readLocked(
      () => this.claims.findById(schoolId, id),
      (row) => this.claims.lockIfUnchanged(schoolId, row),
    );
    if (claim.status !== 'pending') throw claimNotPending(id);
    if (claim.imageObjectKey === null) throw claimImageMissing(id);
    await this.refuseOwnFamily(schoolId, userId, claim);

    const verifiedAmount = dto.verifiedAmount ?? claim.claimedAmount;
    if (verifiedAmount > claim.claimedAmount) {
      throw fieldRefused(
        'verifiedAmount',
        ErrorCode.INVALID_VALUE,
        'At most the amount claimed. For more, the guardian sends a new claim.',
      );
    }
    const timezone = await this.clock.timezone(schoolId);
    let paidOn = claim.paidOn;
    if (dto.paidOn !== undefined) {
      paidOn = fromDateString(dto.paidOn);
      const today = todayIn(timezone, this.clock.now());
      if (paidOn > today || paidOn > todayIn(timezone, claim.createdAt)) {
        throw fieldRefused('paidOn', ErrorCode.INVALID_VALUE, 'paidOn must be today or earlier, and not after the claim was made');
      }
    }
    const corrected = paidOn.getTime() !== claim.paidOn.getTime();
    const lower = verifiedAmount < claim.claimedAmount;
    const reason = dto.reason ?? null;
    if ((corrected || lower) && reason === null) {
      throw fieldRefused('reason', ErrorCode.INVALID_VALUE, 'Say why the amount is lower or the date differs; the guardian sees it');
    }
    const academicYearId =
      dto.academicYearId === undefined ? await this.claims.defaultYearOf(schoolId, claim.studentId) : BigInt(dto.academicYearId);
    if (academicYearId === null) {
      throw fieldRefused('academicYearId', ErrorCode.REFERENCE_NOT_FOUND, 'The child has no enrolment; name the academic year');
    }
    const advanceFor = dto.advanceForStudentId === undefined ? null : BigInt(dto.advanceForStudentId);
    if (advanceFor !== null && advanceFor !== claim.studentId) {
      throw fieldRefused('advanceForStudentId', ErrorCode.INVALID_VALUE, 'A claim pays for its own child only');
    }
    const graceDays = (await this.settings.find(schoolId))?.lateFeeGraceDays ?? DEFAULT_GRACE_DAYS;
    const waived: bigint[] = [];

    const payment = await this.paymentsService.recordForClaim(actor, {
      academicYearId,
      payerGuardianId: await this.survivor(schoolId, claim.guardianId),
      studentId: claim.studentId,
      method: claim.method,
      amount: verifiedAmount,
      receivedOn: paidOn,
      // payments_reference_required_check: a deposit names its reference.
      reference: claim.reference ?? `Claim ${claim.id}`,
      advanceFor,
      claimId: claim.id,
      beforeAllocate: async (open, advances) => {
        waived.push(...(await this.waiveInGrace(actor, claim, verifiedAmount, open, advances, paidOn, graceDays)));
      },
    });
    const decided = await this.claims.decide(
      schoolId,
      id,
      {
        status: 'verified',
        decidedBy: userId,
        decisionReason: reason,
        verifiedAmount,
        verifiedPaidOn: corrected ? paidOn : null,
        paymentId: payment.id,
      },
      new Date(),
    );
    if (decided !== 1) throw claimNotPending(id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'payment_claim.verified',
      subjectType: SUBJECT,
      subjectId: id,
      ...(reason === null ? {} : { reason }),
      metadata: {
        studentId: claim.studentId.toString(),
        paymentId: payment.id.toString(),
        claimedAmount: claim.claimedAmount,
        verifiedAmount,
        paidOn: toDateString(claim.paidOn),
        verifiedPaidOn: corrected ? toDateString(paidOn) : null,
        lateFeesWaived: waived.join(','),
      },
    });
    return payment.id;
  }

  /** POST /payment-claims/:id/reject: the reason goes to the submitter (payment_claim_rejected). */
  @Transactional()
  async reject(id: bigint, dto: RejectClaimDto): Promise<ClaimDto> {
    const { schoolId, userId } = this.context.actor();
    const claim = await readLocked(
      () => this.claims.findById(schoolId, id),
      (row) => this.claims.lockIfUnchanged(schoolId, row),
    );
    if (claim.status !== 'pending') throw claimNotPending(id);
    await this.refuseOwnFamily(schoolId, userId, claim);
    const decided = await this.claims.decide(
      schoolId,
      id,
      { status: 'rejected', decidedBy: userId, decisionReason: dto.reason },
      new Date(),
    );
    if (decided !== 1) throw claimNotPending(id);
    const names = await this.payments.students(schoolId, [claim.studentId]);
    await this.notifications.send(schoolId, {
      type: 'payment_claim_rejected',
      subject: { type: 'payment_claim', id },
      recipients: [{ guardianId: await this.survivor(schoolId, claim.guardianId) }],
      vars: {
        studentName: names.get(claim.studentId)?.fullName ?? '',
        amount: claim.claimedAmount,
        paidOn: claim.paidOn,
        reason: dto.reason,
      },
    });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'payment_claim.rejected',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: { studentId: claim.studentId.toString(), claimedAmount: claim.claimedAmount },
    });
    return this.get(id);
  }

  // ============================================================================ the job (R200)

  /**
   * The claim-image-sweep's body for one school (daily): pending claims still without their slip
   * 24 hours after they were made expire. They still count towards the day's cap (R199). One
   * system-actor audit row per run that expired something (A19).
   */
  @Transactional()
  async expireImageless(schoolId: SchoolId, now: Date): Promise<number> {
    const expired = await this.claims.expireImageless(schoolId, new Date(now.getTime() - IMAGELESS_CLAIM_TTL_MS), now);
    if (expired > 0) {
      await this.audit.recordSystem(schoolId, {
        action: 'payment_claim.expired',
        subjectType: SUBJECT,
        subjectId: null,
        metadata: { job: 'claim-image-sweep', expired },
      });
    }
    return expired;
  }

  // ================================================================================== internals

  /** The claim of this child made by the caller's guardian record; 404 otherwise (R198). */
  private async mySubmitted(session: SchoolSessionContext, studentId: bigint, claimId: bigint): Promise<ClaimRecord> {
    requireMyChild(session, studentId);
    const row = await this.claims.findOfStudent(this.context.schoolId, studentId, claimId);
    if (!row || row.guardianId !== myGuardianId(session)) throw notFound();
    return row;
  }

  /** R197, rule 0.21 (no exception): nobody decides a claim of their own family. */
  private async refuseOwnFamily(schoolId: SchoolId, userId: bigint, claim: ClaimRecord): Promise<void> {
    if (await this.isOwnFamily(schoolId, userId, claim)) throw ownChild();
  }

  /** The user is the claim's submitter or a guardian of its child. */
  private async isOwnFamily(schoolId: SchoolId, userId: bigint, claim: ClaimRecord): Promise<boolean> {
    return (
      (await this.payments.userIsGuardian(schoolId, userId, claim.guardianId)) ||
      (await this.permissions.actorIsGuardianOf(schoolId, userId, claim.studentId))
    );
  }

  /** The guardian record that survives a merge (no merge verb exists yet: usually the same one). */
  private async survivor(schoolId: SchoolId, guardianId: bigint): Promise<bigint> {
    let id = guardianId;
    for (let step = 0; step < MERGE_STEPS; step++) {
      const guardian = await this.payments.findGuardian(schoolId, id);
      if (!guardian || guardian.mergedIntoId === null) return id;
      id = guardian.mergedIntoId;
    }
    return id;
  }

  /**
   * Slice 19's rule, read from the verified date (§1.1 "Verifier corrects the paid date", R185,
   * contract slice-21 §1.5): an open late fee of the child is waived before the money is allocated,
   * so the payment never pays it, only when the paid date is inside its target charge's grace **and
   * this payment settles that charge in full**. Whether it does is a dry run of the allocation the
   * write performs (the child's advances first, then this payment's money, oldest due first) over
   * the same charges the write will see: every open charge except the late fees being waived, so an
   * older late fee that stays open takes its share first (phase close G2). The waived set starts
   * as every in-grace late fee and drops each whose target the dry run leaves short, until it holds
   * (it only shrinks). A token deposit inside the grace waives nothing. Runs under the charge locks
   * of the payment.
   */
  private async waiveInGrace(
    actor: Actor,
    claim: ClaimRecord,
    amount: number,
    open: readonly ChargeRecord[],
    advances: readonly ExistingAdvance[],
    paidOn: Date,
    graceDays: number,
  ): Promise<bigint[]> {
    const { schoolId, userId } = actor;
    const targetOf = (fee: ChargeRecord): ChargeRecord | undefined =>
      // A target that is not open in this payment's year is not settled by this payment.
      open.find((c) => c.id === fee.lateFeeForChargeId && c.kind !== 'late_fee');
    let candidates = open.filter((c) => {
      if (c.kind !== 'late_fee' || c.studentId !== claim.studentId || c.allocatedAmount !== 0 || c.lateFeeForChargeId === null) return false;
      const target = targetOf(c);
      return target !== undefined && paidOn <= addDays(target.dueOn, graceDays);
    });
    // The fixed point: dry-run over what stays open, drop each candidate left short, repeat.
    for (;;) {
      const waiving = new Set(candidates.map((c) => c.id));
      const paid = new Map<bigint, number>();
      const seen = open.filter((c) => !waiving.has(c.id)).map(openCharge);
      for (const a of allocate(amount, [claim.studentId], seen, advances).allocations) {
        paid.set(a.chargeId, (paid.get(a.chargeId) ?? 0) + a.amount);
      }
      const settled = candidates.filter((fee) => {
        const target = targetOf(fee);
        return target !== undefined && outstanding(target) - (paid.get(target.id) ?? 0) === 0;
      });
      if (settled.length === candidates.length) break;
      candidates = settled;
    }
    const waived: bigint[] = [];
    for (const fee of candidates) {
      const target = targetOf(fee);
      if (!target) continue;
      if ((await this.charges.waive(schoolId, fee.id, userId, IN_GRACE_WAIVE_REASON, new Date())) !== 1) continue;
      waived.push(fee.id);
      await this.audit.record(schoolId, {
        actorUserId: userId,
        action: 'charge.waived',
        subjectType: 'charge',
        subjectId: fee.id,
        reason: IN_GRACE_WAIVE_REASON,
        metadata: {
          studentId: fee.studentId.toString(),
          period: fee.period,
          amount: fee.amount,
          lateFeeForChargeId: target.id.toString(),
          claimId: claim.id.toString(),
          paidOn: toDateString(paidOn),
        },
      });
    }
    return waived;
  }

  /**
   * payment_claim_submitted to every confirmed payment.verify holder (candidates by role, grant or
   * custom role, each confirmed through the permission service) who is not of the child's family.
   */
  private async tellVerifiers(schoolId: SchoolId, claim: ClaimRecord): Promise<void> {
    const staffIds: bigint[] = [];
    for (const candidate of await this.users.watcherCandidates(schoolId, Capability.PAYMENT_VERIFY)) {
      const access = await this.permissions.load(schoolId, candidate.userId);
      if (!access?.capacities.staff || !access.capabilities.has(Capability.PAYMENT_VERIFY)) continue;
      if (await this.permissions.actorIsGuardianOf(schoolId, candidate.userId, claim.studentId)) continue;
      staffIds.push(candidate.staffId);
    }
    if (staffIds.length === 0) return;
    const names = await this.payments.students(schoolId, [claim.studentId]);
    await this.notifications.send(schoolId, {
      type: 'payment_claim_submitted',
      subject: { type: 'payment_claim', id: claim.id },
      recipients: staffIds.map((staffId) => ({ staffId })),
      vars: { studentName: names.get(claim.studentId)?.fullName ?? '' },
    });
  }

  private async consume(actor: Actor, stagedUploadId: bigint): Promise<ClaimImage> {
    const [staged] = await this.staged.findOwned(actor.schoolId, actor.userId, [stagedUploadId]);
    const image = staged === undefined ? null : await this.tryConsume(actor, staged);
    if (image === null) throw stagedUploadUnusable('stagedUploadId');
    return image;
  }

  /** Consumes the upload (its uploader, once, unexpired); the thumbnail is made after commit. */
  private async tryConsume(actor: Actor, staged: StagedUploadRecord): Promise<ClaimImage | null> {
    const { schoolId, userId } = actor;
    if (!(await this.staged.consume(schoolId, userId, staged.id, new Date()))) return null;
    const image = { objectKey: staged.objectKey, mime: staged.mime, sizeBytes: staged.sizeBytes };
    this.afterCommit.register(() => this.attachments.storeThumbnail(schoolId, image));
    return image;
  }

  private openImage(row: ClaimRecord, thumb: boolean): Promise<AttachedFile> {
    const { imageObjectKey: objectKey, imageMime: mime, imageSizeBytes: sizeBytes } = row;
    if (objectKey === null || mime === null || sizeBytes === null) throw notFound();
    const schoolId = this.context.schoolId;
    const file = { objectKey, mime, sizeBytes };
    const name = `deposit-slip-${row.id}`;
    // Logged by the claim's id only: never the key, the amount or a name (§7.1).
    const log = { claimId: row.id.toString() };
    return thumb ? this.attachments.thumbnail(schoolId, file, name, log) : this.attachments.open(schoolId, file, name, log);
  }

  private async receiptIds(schoolId: SchoolId, rows: readonly ClaimRecord[]): Promise<Map<bigint, bigint>> {
    const paymentIds = rows.flatMap((r) => (r.paymentId === null ? [] : [r.paymentId]));
    return new Map((await this.receipts.ofPayments(schoolId, paymentIds)).map((r) => [r.paymentId, r.id]));
  }

  private async toMyDto(session: SchoolSessionContext, row: ClaimRecord): Promise<MyClaimDto> {
    const [dto] = await this.toMyDtos(session, this.context.schoolId, [row]);
    if (!dto) throw notFound();
    return dto;
  }

  /** MyClaimDto: status and amounts to every linked guardian; no decider, no other family, the note to its submitter only (R198). */
  private async toMyDtos(session: SchoolSessionContext, schoolId: SchoolId, rows: readonly ClaimRecord[]): Promise<MyClaimDto[]> {
    const receipts = await this.receiptIds(schoolId, rows);
    const mine = session.access.guardianId;
    return rows.map((row) => ({
      id: row.id.toString(),
      studentId: row.studentId.toString(),
      method: depositMethod(row.method),
      claimedAmount: row.claimedAmount,
      paidOn: toDateString(row.paidOn),
      reference: row.reference,
      // The submitter's free text stays theirs: a co-guardian sees the reference, not the note.
      note: row.guardianId === mine ? row.note : null,
      hasImage: row.imageObjectKey !== null,
      submittedByMe: row.guardianId === mine,
      status: row.status,
      decidedAt: row.decidedAt,
      decisionReason: row.decisionReason,
      verifiedAmount: row.verifiedAmount,
      verifiedPaidOn: row.verifiedPaidOn === null ? null : toDateString(row.verifiedPaidOn),
      receiptId: row.paymentId === null ? null : (receipts.get(row.paymentId)?.toString() ?? null),
      createdAt: row.createdAt,
    }));
  }

  /** ClaimDto for a page of rows: every related read batched; the duplicate check per row (R249). */
  private async toDtos(schoolId: SchoolId, rows: readonly ClaimRecord[]): Promise<ClaimDto[]> {
    if (rows.length === 0) return [];
    const studentIds = rows.map((r) => r.studentId);
    const students = await this.payments.students(schoolId, studentIds);
    const classes = new Map<bigint, string>();
    // Newest year first: the first enrolment seen per child is their latest class.
    for (const e of await this.payments.enrolmentsOf(schoolId, studentIds)) {
      if (!classes.has(e.studentId)) classes.set(e.studentId, e.className);
    }
    const guardians = await this.payments.guardianNames(schoolId, rows.map((r) => r.guardianId));
    const users = await this.payments.userNames(
      schoolId,
      rows.flatMap((r) => (r.decidedBy === null ? [] : [r.decidedBy])),
    );
    const receipts = await this.receiptIds(schoolId, rows);
    const out: ClaimDto[] = [];
    for (const row of rows) {
      const duplicate =
        row.reference === null
          ? null
          : await this.claims.sameSlip(schoolId, {
              method: row.method,
              reference: row.reference,
              paidOn: row.paidOn,
              excludeId: row.id,
            });
      out.push({
        id: row.id.toString(),
        studentId: row.studentId.toString(),
        studentName: students.get(row.studentId)?.fullName ?? '',
        className: classes.get(row.studentId) ?? '',
        guardianId: row.guardianId.toString(),
        guardianName: guardians.get(row.guardianId) ?? '',
        method: depositMethod(row.method),
        claimedAmount: row.claimedAmount,
        paidOn: toDateString(row.paidOn),
        reference: row.reference,
        note: row.note,
        hasImage: row.imageObjectKey !== null,
        imageMime: row.imageMime,
        status: row.status,
        decidedByUserId: row.decidedBy?.toString() ?? null,
        decidedByName: row.decidedBy === null ? null : (users.get(row.decidedBy) ?? ''),
        decidedAt: row.decidedAt,
        decisionReason: row.decisionReason,
        verifiedAmount: row.verifiedAmount,
        verifiedPaidOn: row.verifiedPaidOn === null ? null : toDateString(row.verifiedPaidOn),
        paymentId: row.paymentId?.toString() ?? null,
        receiptId: row.paymentId === null ? null : (receipts.get(row.paymentId)?.toString() ?? null),
        reopenedAt: row.reopenedAt,
        createdAt: row.createdAt,
        possibleDuplicate: duplicate !== null,
        duplicateOfClaimId: duplicate?.toString() ?? null,
      });
    }
    return out;
  }
}
