import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import {
  CHARGE_KINDS,
  CHARGE_STATUSES,
  CLAIM_STATUSES,
  MAX_RUPEES,
  PAYMENT_METHODS,
  type ChargeKind,
  type ChargeStatus,
  type ClaimStatus,
  type PaymentMethod,
} from '@asms/shared';
import { IfPresent, IsCalendarDate, NoPhoneNumber, QueryBoolean, Reason, Rupees, TextField } from '../../common/fields';
import { IsIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';
import { PaymentDto } from './payments.dto';

// phase-3-financial.md slice 21 (R196-R200, R243, R249; contracts/slice-21.md): the guardian's
// dues, receipts and deposit claims (/me/*: their own DTO classes, no actor, no collector, no
// identity number, nothing of another family, R165 extended), and the office's claim queue.

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;
const NULLABLE_ID = { ...ID, nullable: true } as const;
const MONTH = { type: String, pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$', example: '2026-04' } as const;
const DATE = { type: String, format: 'date' } as const;
const DATE_TIME = { type: String, format: 'date-time' } as const;
const RUPEES = { type: Number, minimum: 0, maximum: MAX_RUPEES, description: 'Whole rupees' } as const;

/** Rule 21: a claim is a bank or wallet deposit; cash is paid at the counter (CHECK payment_claims_method_check). */
export const DEPOSIT_METHODS = ['bank_transfer', 'jazzcash', 'easypaisa'] as const satisfies readonly PaymentMethod[];
export type DepositMethod = (typeof DEPOSIT_METHODS)[number];
const DEPOSIT_METHOD = { enum: DEPOSIT_METHODS, enumName: 'DepositMethod' } as const;
const CLAIM_STATUS = { enum: CLAIM_STATUSES, enumName: 'ClaimStatus' } as const;

// ------------------------------------------------------------------------------- dues (R198)

/** A charge as a guardian sees it: what is owed and why; no actor, no void or waive reason. */
export class MyChargeDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(ID) academicYearId: string;
  @ApiProperty() feeHeadName: string;
  @ApiProperty({ enum: CHARGE_KINDS, enumName: 'ChargeKind' }) kind: ChargeKind;
  @ApiProperty({ ...MONTH, nullable: true }) period: string | null;
  @ApiProperty() description: string;
  @ApiProperty(DATE) dueOn: string;
  @ApiProperty(RUPEES) grossAmount: number;
  @ApiProperty(RUPEES) concessionAmount: number;
  @ApiProperty(RUPEES) amount: number;
  /** Paid so far (live allocations). */
  @ApiProperty(RUPEES) paidAmount: number;
  /** Credited by an adjustment. */
  @ApiProperty(RUPEES) creditedAmount: number;
  @ApiProperty(RUPEES) outstanding: number;
  @ApiProperty({ enum: CHARGE_STATUSES, enumName: 'ChargeStatus' }) status: ChargeStatus;
}

export class MyDuesDto {
  @ApiProperty(ID) studentId: string;
  /** The year asked for; null = every year (dues survive the year, R242). */
  @ApiProperty(NULLABLE_ID) academicYearId: string | null;
  /** Σ outstanding over every open charge (not only the ones listed). */
  @ApiProperty(RUPEES) outstanding: number;
  /** The child's unallocated advance, applied to their next charges by itself (R189). */
  @ApiProperty(RUPEES) advance: number;
  /** The earliest due date of an open charge, today or later; null when none. */
  @ApiProperty({ ...DATE, nullable: true }) nextDueOn: string | null;
  /** Open charges, oldest due first; bounded: the oldest 50. */
  @ApiProperty({ type: () => MyChargeDto, isArray: true }) charges: MyChargeDto[];
  /** True when the school accepts deposit slips (an active payment account, R196). */
  @ApiProperty() claimsAccepted: boolean;
}

export class MyDuesQueryDto {
  @ApiPropertyOptional(ID) @IsOptional() @IsIdString() academicYearId?: string;
}

// ----------------------------------------------------------------------------- receipts (R198)

export class MyReceiptLineDto {
  @ApiProperty(ID) studentId: string;
  @ApiProperty() studentName: string;
  /** Null for the advance line ("kept for later fees"). */
  @ApiProperty({ type: String, nullable: true }) feeHeadName: string | null;
  @ApiProperty({ ...MONTH, nullable: true }) period: string | null;
  @ApiProperty(RUPEES) amount: number;
}

/** A receipt as a guardian sees it: their own linked children's lines only; no collector. */
export class MyReceiptDto {
  @ApiProperty(ID) id: string;
  /** `<n>/<year name>`. */
  @ApiProperty() receiptLabel: string;
  @ApiProperty(ID) academicYearId: string;
  @ApiProperty() academicYearName: string;
  @ApiProperty(RUPEES) amount: number;
  @ApiProperty({ ...DATE, description: 'When the money was paid' }) paidOn: string;
  @ApiProperty({ enum: PAYMENT_METHODS, enumName: 'PaymentMethod' }) method: PaymentMethod;
  @ApiProperty({ type: () => MyReceiptLineDto, isArray: true }) lines: MyReceiptLineDto[];
  /** What the receipt paid for children who are not the caller's (siblings with another guardian). */
  @ApiProperty(RUPEES) otherChildrenAmount: number;
  @ApiProperty(DATE_TIME) issuedAt: Date;
  @ApiProperty({ ...DATE_TIME, nullable: true }) voidedAt: Date | null;
}

export class MyReceiptsQueryDto extends PageQueryDto {
  @ApiPropertyOptional(ID) @IsOptional() @IsIdString() studentId?: string;

  @ApiPropertyOptional({ enum: ['-issuedAt'], default: '-issuedAt' })
  @IsOptional()
  @IsIn(['-issuedAt'])
  sort?: '-issuedAt';
}

// ------------------------------------------------------------------------- the guardian's claims

export class MyClaimDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(ID) studentId: string;
  @ApiProperty(DEPOSIT_METHOD) method: DepositMethod;
  @ApiProperty(RUPEES) claimedAmount: number;
  @ApiProperty(DATE) paidOn: string;
  @ApiProperty({ type: String, nullable: true }) reference: string | null;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @ApiProperty() hasImage: boolean;
  /** True for the guardian who made it: only they see the slip and may withdraw (R198). */
  @ApiProperty() submittedByMe: boolean;
  @ApiProperty(CLAIM_STATUS) status: ClaimStatus;
  @ApiProperty({ ...DATE_TIME, nullable: true }) decidedAt: Date | null;
  /** Why it was rejected, or why the office verified less or another date. */
  @ApiProperty({ type: String, nullable: true }) decisionReason: string | null;
  @ApiProperty({ ...RUPEES, nullable: true }) verifiedAmount: number | null;
  /** The office's corrected paid date; null = the guardian's. */
  @ApiProperty({ ...DATE, nullable: true }) verifiedPaidOn: string | null;
  @ApiProperty(NULLABLE_ID) receiptId: string | null;
  @ApiProperty(DATE_TIME) createdAt: Date;
}

export class CreateClaimDto {
  @ApiProperty(DEPOSIT_METHOD)
  @IsIn(DEPOSIT_METHODS)
  method: DepositMethod;

  @ApiProperty({ ...RUPEES, minimum: 1 })
  @Rupees(1)
  claimedAmount: number;

  @ApiProperty({ ...DATE, description: 'Today or earlier (school time)' })
  @IsCalendarDate()
  paidOn: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 60, description: 'The slip or transaction reference' })
  @IfPresent()
  @TextField(1, 60)
  reference?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 300 })
  @IfPresent()
  @TextField(1, 300)
  note?: string;

  @ApiPropertyOptional({ ...ID, description: 'The slip (POST /me/uploads); or send it later with PATCH' })
  @IfPresent()
  @IsIdString()
  stagedUploadId?: string;
}

export class ClaimImageDto {
  @ApiProperty({ ...ID, description: 'The slip (POST /me/uploads), by its uploader' })
  @IsIdString()
  stagedUploadId: string;
}

export class WithdrawClaimDto {
  @ApiPropertyOptional({ minLength: 3, maxLength: 500 })
  @IfPresent()
  @Reason()
  reason?: string;
}

// ------------------------------------------------------------------------------ the office queue

export class ClaimDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(ID) studentId: string;
  @ApiProperty() studentName: string;
  /** The class of the child's latest enrolment. */
  @ApiProperty() className: string;
  @ApiProperty(ID) guardianId: string;
  @ApiProperty() guardianName: string;
  @ApiProperty(DEPOSIT_METHOD) method: DepositMethod;
  @ApiProperty(RUPEES) claimedAmount: number;
  @ApiProperty(DATE) paidOn: string;
  @ApiProperty({ type: String, nullable: true }) reference: string | null;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @ApiProperty() hasImage: boolean;
  @ApiProperty({ type: String, nullable: true }) imageMime: string | null;
  @ApiProperty(CLAIM_STATUS) status: ClaimStatus;
  @ApiProperty(NULLABLE_ID) decidedByUserId: string | null;
  @ApiProperty({ type: String, nullable: true }) decidedByName: string | null;
  @ApiProperty({ ...DATE_TIME, nullable: true }) decidedAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) decisionReason: string | null;
  @ApiProperty({ ...RUPEES, nullable: true }) verifiedAmount: number | null;
  @ApiProperty({ ...DATE, nullable: true }) verifiedPaidOn: string | null;
  /** The live payment (cleared when it is voided; the payment keeps claimId). */
  @ApiProperty(NULLABLE_ID) paymentId: string | null;
  @ApiProperty(NULLABLE_ID) receiptId: string | null;
  /** The last time a void of its payment returned it to the queue. */
  @ApiProperty({ ...DATE_TIME, nullable: true }) reopenedAt: Date | null;
  @ApiProperty(DATE_TIME) createdAt: Date;
  /** R249: another pending or verified claim has the same method, reference and paid date. A warning only. */
  @ApiProperty() possibleDuplicate: boolean;
  @ApiProperty(NULLABLE_ID) duplicateOfClaimId: string | null;
}

export class ListClaimsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ ...CLAIM_STATUS, default: 'pending' })
  @IsOptional()
  @IsIn(CLAIM_STATUSES)
  status?: ClaimStatus;

  @QueryBoolean({ default: true, description: 'False lists the claims still waiting for their slip (R243)' })
  hasImage?: boolean;

  @ApiPropertyOptional(ID) @IsOptional() @IsIdString() studentId?: string;
  @ApiPropertyOptional(DATE) @IsOptional() @IsCalendarDate() createdFrom?: string;
  @ApiPropertyOptional(DATE) @IsOptional() @IsCalendarDate() createdTo?: string;

  @ApiPropertyOptional({ enum: ['createdAt', '-createdAt'], default: 'createdAt' })
  @IsOptional()
  @IsIn(['createdAt', '-createdAt'])
  sort?: 'createdAt' | '-createdAt';
}

export class VerifyClaimDto {
  @ApiPropertyOptional({ ...RUPEES, minimum: 1, description: 'At most the amount claimed; default the amount claimed' })
  @IfPresent()
  @Rupees(1)
  verifiedAmount?: number;

  @ApiPropertyOptional({
    ...DATE,
    description: "The paid date the slip shows, when it differs from the guardian's: today or earlier, and not after the claim was made",
  })
  @IfPresent()
  @IsCalendarDate()
  paidOn?: string;

  @ApiPropertyOptional({ ...ID, description: "Default: the year of the child's active enrolment" })
  @IfPresent()
  @IsIdString()
  academicYearId?: string;

  @ApiPropertyOptional({ minLength: 3, maxLength: 500, description: 'Required when the amount is lower or the date differs; the guardian sees it' })
  @IfPresent()
  @Reason()
  reason?: string;

  @ApiPropertyOptional({ ...ID, description: 'Record what is left over as an advance for the child (the claim names one child)' })
  @IfPresent()
  @IsIdString()
  advanceForStudentId?: string;
}

export class VerifiedClaimDto extends ClaimDto {
  @ApiProperty({ type: () => PaymentDto }) payment: PaymentDto;
}

export class RejectClaimDto {
  @ApiProperty({ minLength: 3, maxLength: 500, description: 'The guardian is told, by WhatsApp or SMS too: no phone number' })
  @Reason()
  @NoPhoneNumber()
  reason: string;
}
