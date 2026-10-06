import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { ClaimStatus, PaymentMethod } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

// Deposit claims (tenant table payment_claims, phase-3-financial.md §4 "Claims", slice 21,
// R196-R200, R243, R249; migration 20261006170000_slice21_payment_claims). Never deleted; what the
// guardian stated is frozen; the image is set once while pending; the decision moves pending →
// verified | rejected | withdrawn | expired, and back to pending only under a void of its payment
// (the reversal trigger). A claim is never a payment (rule 10). Finance keys are school-wide (rule
// 0.24); the guardian side is checked against the capacity scope by the service before any read.
// No raw SQL: the claim's row lock is a compare-and-set UPDATE (lockIfUnchanged).

export interface ClaimImage {
  objectKey: string;
  mime: string;
  sizeBytes: number;
}

export interface ClaimRecord {
  id: bigint;
  studentId: bigint;
  guardianId: bigint;
  method: PaymentMethod;
  claimedAmount: number;
  paidOn: Date;
  reference: string | null;
  note: string | null;
  imageObjectKey: string | null;
  imageMime: string | null;
  imageSizeBytes: number | null;
  status: ClaimStatus;
  decidedBy: bigint | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  verifiedAmount: number | null;
  verifiedPaidOn: Date | null;
  paymentId: bigint | null;
  reopenedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  studentId: true,
  guardianId: true,
  method: true,
  claimedAmount: true,
  paidOn: true,
  reference: true,
  note: true,
  imageObjectKey: true,
  imageMime: true,
  imageSizeBytes: true,
  status: true,
  decidedBy: true,
  decidedAt: true,
  decisionReason: true,
  verifiedAmount: true,
  verifiedPaidOn: true,
  paymentId: true,
  reopenedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PaymentClaimSelect;

export interface NewClaim {
  studentId: bigint;
  guardianId: bigint;
  method: PaymentMethod;
  claimedAmount: number;
  paidOn: Date;
  reference: string | null;
  note: string | null;
  image: ClaimImage | null;
}

export interface ClaimListQuery {
  status?: ClaimStatus;
  /** True: only claims with an image; false: only image-less ones; absent: both. */
  hasImage?: boolean;
  studentId?: bigint;
  createdFrom?: Date;
  createdTo?: Date;
  sort: 'createdAt' | '-createdAt';
  skip: number;
  take: number;
}

/** A decision from pending (verify, reject, withdraw); the trigger checks the rest. */
export type ClaimDecision =
  | {
      status: 'verified';
      decidedBy: bigint;
      decisionReason: string | null;
      verifiedAmount: number;
      verifiedPaidOn: Date | null;
      paymentId: bigint;
    }
  | { status: 'rejected'; decidedBy: bigint; decisionReason: string }
  | { status: 'withdrawn'; decidedBy: bigint; decisionReason: string | null };

const imageColumns = (image: ClaimImage | null) => ({
  imageObjectKey: image?.objectKey ?? null,
  imageMime: image?.mime ?? null,
  imageSizeBytes: image?.sizeBytes ?? null,
});

@Injectable()
export class PaymentClaimRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  create(schoolId: SchoolId, data: NewClaim): Promise<ClaimRecord> {
    const { image, ...claim } = data;
    return this.txHost.tx.paymentClaim.create({
      data: { schoolId, ...claim, ...imageColumns(image) },
      select: SELECT,
    });
  }

  findById(schoolId: SchoolId, id: bigint): Promise<ClaimRecord | null> {
    return this.txHost.tx.paymentClaim.findFirst({ where: { schoolId, id }, select: SELECT });
  }

  /** The claim only when it is this student's (the guardian routes carry both ids). */
  findOfStudent(schoolId: SchoolId, studentId: bigint, id: bigint): Promise<ClaimRecord | null> {
    return this.txHost.tx.paymentClaim.findFirst({ where: { schoolId, studentId, id }, select: SELECT });
  }

  async list(schoolId: SchoolId, query: ClaimListQuery): Promise<{ rows: ClaimRecord[]; total: number }> {
    const where: Prisma.PaymentClaimWhereInput = {
      schoolId,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.hasImage === undefined ? {} : { imageObjectKey: query.hasImage ? { not: null } : null }),
      ...(query.studentId === undefined ? {} : { studentId: query.studentId }),
      ...(query.createdFrom === undefined && query.createdTo === undefined
        ? {}
        : {
            createdAt: {
              ...(query.createdFrom === undefined ? {} : { gte: query.createdFrom }),
              ...(query.createdTo === undefined ? {} : { lt: query.createdTo }),
            },
          }),
    };
    const direction = query.sort === 'createdAt' ? 'asc' : 'desc';
    const rows = await this.txHost.tx.paymentClaim.findMany({
      where,
      select: SELECT,
      orderBy: [{ createdAt: direction }, { id: direction }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.paymentClaim.count({ where });
    return { rows, total };
  }

  /**
   * Row lock on the claim when it still holds what was read (a compare-and-set UPDATE that keeps
   * the lock to the end of the transaction; common/locking.ts readLocked). The first lock of a
   * verification (contract slice-21 §1.4): the payment's locks follow it.
   */
  async lockIfUnchanged(schoolId: SchoolId, row: Pick<ClaimRecord, 'id' | 'updatedAt'>): Promise<boolean> {
    const { count } = await this.txHost.tx.paymentClaim.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  /** R243: the image, once, while pending; 0 when it already has one or was decided meanwhile. */
  async setImage(schoolId: SchoolId, id: bigint, image: ClaimImage): Promise<number> {
    const { count } = await this.txHost.tx.paymentClaim.updateMany({
      where: { schoolId, id, status: 'pending', imageObjectKey: null },
      data: imageColumns(image),
    });
    return count;
  }

  /** A decision of a pending claim; 0 when it is no longer pending. */
  async decide(schoolId: SchoolId, id: bigint, decision: ClaimDecision, now: Date): Promise<number> {
    const { count } = await this.txHost.tx.paymentClaim.updateMany({
      where: { schoolId, id, status: 'pending' },
      data: { ...decision, decidedAt: now },
    });
    return count;
  }

  /** R200: pending claims with no image created before `before` expire (the system decides). */
  async expireImageless(schoolId: SchoolId, before: Date, now: Date): Promise<number> {
    const { count } = await this.txHost.tx.paymentClaim.updateMany({
      where: { schoolId, status: 'pending', imageObjectKey: null, createdAt: { lt: before } },
      data: { status: 'expired', decidedAt: now },
    });
    return count;
  }

  /** R199: how many claims the guardian made since `since`, whatever became of them. */
  countSince(schoolId: SchoolId, guardianId: bigint, since: Date): Promise<number> {
    return this.txHost.tx.paymentClaim.count({ where: { schoolId, guardianId, createdAt: { gte: since } } });
  }

  /** The claims of one child, newest first (every live login link of the child reads them, R198). */
  async listOfStudent(
    schoolId: SchoolId,
    studentId: bigint,
    page: { skip: number; take: number },
  ): Promise<{ rows: ClaimRecord[]; total: number }> {
    const where = { schoolId, studentId };
    const rows = await this.txHost.tx.paymentClaim.findMany({
      where,
      select: SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: page.skip,
      take: page.take,
    });
    const total = await this.txHost.tx.paymentClaim.count({ where });
    return { rows, total };
  }

  /**
   * R249: the earliest other pending or verified claim with the same method, reference and paid
   * date (one slip claimed twice). A warning, never a refusal.
   */
  async sameSlip(
    schoolId: SchoolId,
    slip: { method: PaymentMethod; reference: string; paidOn: Date; excludeId: bigint },
  ): Promise<bigint | null> {
    const row = await this.txHost.tx.paymentClaim.findFirst({
      where: {
        schoolId,
        method: slip.method,
        reference: slip.reference,
        paidOn: slip.paidOn,
        status: { in: ['pending', 'verified'] },
        id: { not: slip.excludeId },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return row?.id ?? null;
  }

  /**
   * The year a verification books the payment in by default: the student's active enrolment's,
   * else their latest enrolment's (a child who has left still pays last year's dues).
   */
  async defaultYearOf(schoolId: SchoolId, studentId: bigint): Promise<bigint | null> {
    const active = await this.txHost.tx.enrolment.findFirst({
      where: { schoolId, studentId, status: 'active' },
      select: { academicYearId: true },
      orderBy: [{ startedOn: 'desc' }, { id: 'desc' }],
    });
    if (active) return active.academicYearId;
    const latest = await this.txHost.tx.enrolment.findFirst({
      where: { schoolId, studentId },
      select: { academicYearId: true },
      orderBy: [{ startedOn: 'desc' }, { id: 'desc' }],
    });
    return latest?.academicYearId ?? null;
  }
}
