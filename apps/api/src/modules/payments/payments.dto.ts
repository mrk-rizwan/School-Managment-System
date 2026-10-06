import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional } from 'class-validator';
import {
  COUNTER_PAYMENT_METHODS,
  HANDOVER_STATUSES,
  MAX_RUPEES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  REVERSAL_KINDS,
  SHORTFALL_RESOLUTIONS,
  type CounterPaymentMethod,
  type HandoverStatus,
  type PaymentMethod,
  type PaymentStatus,
  type ReversalKind,
  type ShortfallResolution,
} from '@asms/shared';
import { IfPresent, IsCalendarDate, NameField, QueryBoolean, Reason, Rupees, TextField } from '../../common/fields';
import { IsIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';
import { ChargeDto, EachIdString } from '../fees/charges.dto';

// phase-3-financial.md slice 20 (R187-R195, R236, R242, R249, R251; contracts/slice-20.md §1).

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;
const NULLABLE_ID = { ...ID, nullable: true } as const;
const MONTH = { type: String, pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$', example: '2026-04' } as const;
const DATE = { type: String, format: 'date' } as const;
const DATE_TIME = { type: String, format: 'date-time' } as const;
const RUPEES = { type: Number, minimum: 0, maximum: MAX_RUPEES, description: 'Whole rupees' } as const;
const COUNTER_METHOD = { enum: COUNTER_PAYMENT_METHODS, enumName: 'CounterPaymentMethod' } as const;
const METHOD = { enum: PAYMENT_METHODS, enumName: 'PaymentMethod' } as const;

// ---------------------------------------------------------------------------------- record

/** What the counter is about to record (the preview's body; R188). */
export class PaymentIntentDto {
  @ApiProperty(ID) @IsIdString() academicYearId: string;

  @ApiPropertyOptional({ ...ID, description: 'The paying guardian; exactly one of payerGuardianId and payerName' })
  @IfPresent()
  @IsIdString()
  payerGuardianId?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 100, description: 'A walk-in payer (names one student only)' })
  @IfPresent()
  @NameField(1, 100)
  payerName?: string;

  @ApiProperty({ ...ID, isArray: true, minItems: 1, maxItems: 10, description: 'Allocation spans exactly these children' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @EachIdString()
  studentIds: string[];

  @ApiProperty({ ...RUPEES, minimum: 1 })
  @Rupees(1)
  amount: number;
}

export class CreatePaymentDto extends PaymentIntentDto {
  @ApiProperty(COUNTER_METHOD)
  @IsIn(COUNTER_PAYMENT_METHODS)
  method: CounterPaymentMethod;

  @ApiProperty({ ...DATE, description: 'Today or earlier (school time)' })
  @IsCalendarDate()
  receivedOn: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 60, description: 'The slip reference; required for a non-cash method' })
  @IfPresent()
  @TextField(1, 60)
  reference?: string;

  @ApiPropertyOptional({
    ...ID,
    description: 'The child a remainder is an advance for (one of studentIds); required when it is ambiguous',
  })
  @IfPresent()
  @IsIdString()
  advanceForStudentId?: string;
}

export class PreviewAllocationDto {
  @ApiProperty(ID) chargeId: string;
  @ApiProperty(ID) studentId: string;
  @ApiProperty() studentName: string;
  @ApiProperty() feeHeadName: string;
  @ApiProperty({ ...MONTH, nullable: true }) period: string | null;
  @ApiProperty(DATE) dueOn: string;
  @ApiProperty(RUPEES) amount: number;
  /** Paid from the child's existing advance, not from this payment's money. */
  @ApiProperty() fromAdvance: boolean;
}

export class PaymentPreviewDto {
  @ApiProperty({ type: () => PreviewAllocationDto, isArray: true }) allocations: PreviewAllocationDto[];
  /** New money left over: the advance this payment would leave. */
  @ApiProperty(RUPEES) remainder: number;
  /** What the named children owed in the year before this payment. */
  @ApiProperty(RUPEES) outstanding: number;
  /** Their existing advances spent first. */
  @ApiProperty(RUPEES) advanceUsed: number;
}

// --------------------------------------------------------------------------------- receipts

export class ReceiptLineDto {
  @ApiProperty(ID) studentId: string;
  @ApiProperty() studentName: string;
  /** Null for the advance line. */
  @ApiProperty(NULLABLE_ID) chargeId: string | null;
  @ApiProperty({ type: String, nullable: true }) feeHeadName: string | null;
  @ApiProperty({ ...MONTH, nullable: true }) period: string | null;
  @ApiProperty(RUPEES) amount: number;
}

export class ReceiptDto {
  @ApiProperty(ID) id: string;
  @ApiProperty() receiptNo: number;
  /** `<n>/<year name>`. */
  @ApiProperty() receiptLabel: string;
  @ApiProperty(ID) academicYearId: string;
  @ApiProperty(ID) paymentId: string;
  @ApiProperty(RUPEES) amount: number;
  @ApiProperty({ type: () => ReceiptLineDto, isArray: true }) lines: ReceiptLineDto[];
  @ApiProperty(DATE_TIME) issuedAt: Date;
  @ApiProperty() issuedByName: string;
  @ApiProperty({ ...DATE_TIME, nullable: true }) voidedAt: Date | null;
}

// ------------------------------------------------------------------------------- reversals

export class ReversalDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(ID) paymentId: string;
  @ApiProperty(ID) academicYearId: string;
  @ApiProperty({ enum: REVERSAL_KINDS, enumName: 'ReversalKind' }) kind: ReversalKind;
  @ApiProperty(NULLABLE_ID) reversesId: string | null;
  /** A carry-forward's new payment in the target year. */
  @ApiProperty(NULLABLE_ID) carriedToPaymentId: string | null;
  @ApiProperty(RUPEES) amount: number;
  @ApiProperty() reason: string;
  @ApiProperty(ID) requestedByUserId: string;
  @ApiProperty() requestedByName: string;
  @ApiProperty(NULLABLE_ID) approvedByUserId: string | null;
  @ApiProperty({ ...METHOD, nullable: true }) refundMethod: PaymentMethod | null;
  @ApiProperty({ type: String, nullable: true }) refundReference: string | null;
  /** True once a refund reversal undid this refund. */
  @ApiProperty() reversed: boolean;
  @ApiProperty(DATE_TIME) createdAt: Date;
}

// -------------------------------------------------------------------------------- payments

export class PaymentStudentDto {
  @ApiProperty(ID) studentId: string;
  @ApiProperty() fullName: string;
  /** What this payment's receipt shows for the child, the advance included. */
  @ApiProperty(RUPEES) amount: number;
}

export class PaymentDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(ID) academicYearId: string;
  @ApiProperty(NULLABLE_ID) payerGuardianId: string | null;
  /** The walk-in payer, or the paying guardian's name. */
  @ApiProperty() payerName: string;
  @ApiProperty({ type: () => PaymentStudentDto, isArray: true }) students: PaymentStudentDto[];
  @ApiProperty(METHOD) method: PaymentMethod;
  @ApiProperty(RUPEES) amount: number;
  /** Σ live allocations. */
  @ApiProperty(RUPEES) allocatedAmount: number;
  @ApiProperty(RUPEES) unallocatedAmount: number;
  @ApiProperty(NULLABLE_ID) advanceForStudentId: string | null;
  @ApiProperty(DATE) receivedOn: string;
  /** Rule 25: when the money was verified (at recording, on the office path). */
  @ApiProperty(DATE_TIME) verifiedAt: Date;
  @ApiProperty({ type: String, nullable: true }) reference: string | null;
  @ApiProperty(ID) recordedByUserId: string;
  @ApiProperty() recordedByName: string;
  @ApiProperty(NULLABLE_ID) handoverId: string | null;
  /** The deposit claim this payment verified (slice 21); null at the counter. */
  @ApiProperty(NULLABLE_ID) claimId: string | null;
  @ApiProperty({ enum: PAYMENT_STATUSES, enumName: 'PaymentStatus' }) status: PaymentStatus;
  @ApiProperty({ ...DATE_TIME, nullable: true }) voidedAt: Date | null;
  /** Null only for a carried-forward payment (no money was received, R251). */
  @ApiProperty({ type: () => ReceiptDto, nullable: true }) receipt: ReceiptDto | null;
  @ApiProperty({ type: () => ReversalDto, isArray: true }) reversals: ReversalDto[];
  /** R249: another live payment has the same method, reference and day. A warning, never a refusal. */
  @ApiProperty() possibleDuplicate: boolean;
  @ApiProperty(NULLABLE_ID) duplicateOfPaymentId: string | null;
}

export class ListPaymentsQueryDto extends PageQueryDto {
  @ApiPropertyOptional(DATE) @IsOptional() @IsCalendarDate() receivedFrom?: string;
  @ApiPropertyOptional(DATE) @IsOptional() @IsCalendarDate() receivedTo?: string;

  @ApiPropertyOptional(METHOD)
  @IsOptional()
  @IsIn(PAYMENT_METHODS)
  method?: PaymentMethod;

  @ApiPropertyOptional({ enum: PAYMENT_STATUSES, enumName: 'PaymentStatus' })
  @IsOptional()
  @IsIn(PAYMENT_STATUSES)
  status?: PaymentStatus;

  @ApiPropertyOptional(ID) @IsOptional() @IsIdString() recordedByUserId?: string;
  @ApiPropertyOptional(ID) @IsOptional() @IsIdString() studentId?: string;
  @ApiPropertyOptional(ID) @IsOptional() @IsIdString() academicYearId?: string;

  @ApiPropertyOptional({ enum: ['-receivedOn'], default: '-receivedOn' })
  @IsOptional()
  @IsIn(['-receivedOn'])
  sort?: '-receivedOn';
}

export class RefundDto {
  @ApiProperty({ ...RUPEES, minimum: 1, description: 'At most the unallocated amount (an advance)' })
  @Rupees(1)
  amount: number;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;

  @ApiProperty({ ...COUNTER_METHOD, description: 'How the money went back' })
  @IsIn(COUNTER_PAYMENT_METHODS)
  method: CounterPaymentMethod;

  @ApiPropertyOptional({ minLength: 1, maxLength: 60 })
  @IfPresent()
  @TextField(1, 60)
  reference?: string;
}

export class ReverseRefundDto {
  @ApiProperty({ ...ID, description: 'The refund of this payment to undo' })
  @IsIdString()
  reversalId: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;
}

/** R251: an advance moved to another academic year (a reversal plus a new payment there). */
export class CarryForwardDto {
  @ApiProperty({ ...ID, description: 'The target year; the child needs an enrolment in it' })
  @IsIdString()
  academicYearId: string;

  @ApiPropertyOptional({ ...RUPEES, minimum: 1, description: 'Default: the whole unallocated amount' })
  @IfPresent()
  @Rupees(1)
  amount?: number;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;
}

export class CarryForwardResultDto {
  @ApiProperty({ type: () => ReversalDto }) reversal: ReversalDto;
  @ApiProperty({ type: () => PaymentDto }) payment: PaymentDto;
}

// ------------------------------------------------------------------------------ family dues

export class GuardianChildDuesDto {
  @ApiProperty(ID) studentId: string;
  @ApiProperty() fullName: string;
  @ApiProperty() className: string;
  @ApiProperty(ID) enrolmentId: string;
  @ApiProperty(ID) academicYearId: string;
  @ApiProperty() academicYearName: string;
  @ApiProperty() academicYearClosed: boolean;
  @ApiProperty(RUPEES) outstanding: number;
  /** The child's unallocated advance in this year. */
  @ApiProperty(RUPEES) advance: number;
  /** Bounded: the oldest 50. */
  @ApiProperty({ type: () => ChargeDto, isArray: true }) openCharges: ChargeDto[];
}

export class GuardianDuesDto {
  @ApiProperty(ID) guardianId: string;
  @ApiProperty() fullName: string;
  /** One row per child per academic year with something owed, an advance or a live enrolment (≤ 10 children). */
  @ApiProperty({ type: () => GuardianChildDuesDto, isArray: true }) children: GuardianChildDuesDto[];
}

// ------------------------------------------------------------------------------- custody

export class CustodyDto {
  @ApiProperty(RUPEES) cashInHand: number;
  @ApiProperty() paymentCount: number;
  /** The oldest custody payment's recording time; null with nothing in hand. */
  @ApiProperty({ ...DATE_TIME, nullable: true }) since: Date | null;
}

export class HandoverCollectorDto {
  @ApiProperty(ID) userId: string;
  @ApiProperty(ID) staffId: string;
  @ApiProperty() name: string;
}

export class HandoverDto {
  @ApiProperty(ID) id: string;
  @ApiProperty({ type: () => HandoverCollectorDto }) collector: HandoverCollectorDto;
  @ApiProperty(ID) openedByUserId: string;
  @ApiProperty() openedByName: string;
  @ApiProperty() onBehalf: boolean;
  @ApiProperty(RUPEES) expectedAmount: number;
  @ApiProperty() paymentCount: number;
  @ApiProperty(DATE_TIME) openedAt: Date;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @ApiProperty({ enum: HANDOVER_STATUSES, enumName: 'HandoverStatus' }) status: HandoverStatus;
  @ApiProperty(NULLABLE_ID) confirmedByUserId: string | null;
  @ApiProperty({ type: String, nullable: true }) confirmedByName: string | null;
  @ApiProperty({ ...DATE_TIME, nullable: true }) confirmedAt: Date | null;
  @ApiProperty({ ...RUPEES, nullable: true }) countedAmount: number | null;
  @ApiProperty({ ...RUPEES, nullable: true }) shortfallAmount: number | null;
  @ApiProperty({ ...RUPEES, nullable: true }) surplusAmount: number | null;
  @ApiProperty({ type: String, nullable: true }) confirmNote: string | null;
  @ApiProperty({ enum: SHORTFALL_RESOLUTIONS, enumName: 'ShortfallResolution', nullable: true })
  shortfallResolution: ShortfallResolution | null;
  @ApiProperty({ ...DATE_TIME, nullable: true }) shortfallResolvedAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) shortfallResolutionReason: string | null;
  @ApiProperty(NULLABLE_ID) shortfallExpenseId: string | null;
  @ApiProperty(NULLABLE_ID) shortfallReversalId: string | null;
}

export class OpenHandoverDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 500 })
  @IfPresent()
  @TextField(1, 500)
  note?: string;
}

/** On behalf of a collector who has left or is suspended (A13). */
export class OpenHandoverOnBehalfDto extends OpenHandoverDto {
  @ApiProperty(ID) @IsIdString() collectorUserId: string;
}

export class ConfirmHandoverDto {
  @ApiProperty({ ...RUPEES, description: 'The cash counted' })
  @Rupees(0)
  countedAmount: number;

  @ApiPropertyOptional({ minLength: 1, maxLength: 500 })
  @IfPresent()
  @TextField(1, 500)
  note?: string;
}

export class ResolveShortfallDto {
  @ApiProperty({ enum: SHORTFALL_RESOLUTIONS, enumName: 'ShortfallResolution' })
  @IsIn(SHORTFALL_RESOLUTIONS)
  resolution: ShortfallResolution;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;

  @ApiPropertyOptional({ ...ID, description: 'explained_by_void only: the void of a payment in this handover' })
  @IfPresent()
  @IsIdString()
  reversalId?: string;
}

export class ListHandoversQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: HANDOVER_STATUSES, enumName: 'HandoverStatus' })
  @IsOptional()
  @IsIn(HANDOVER_STATUSES)
  status?: HandoverStatus;

  @ApiPropertyOptional(ID) @IsOptional() @IsIdString() collectorUserId?: string;

  @QueryBoolean({ description: 'Confirmed with a shortfall nobody has resolved yet' })
  unresolvedShortfall?: boolean;
}
