import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional } from 'class-validator';
import {
  COUNTER_PAYMENT_METHODS,
  EXPENSE_CATEGORIES,
  EXPENSE_STATUSES,
  MAX_RUPEES,
  RECORDABLE_EXPENSE_CATEGORIES,
  type CounterPaymentMethod,
  type ExpenseCategory,
  type ExpenseStatus,
  type RecordableExpenseCategory,
} from '@asms/shared';
import { IfPresent, IfPresentNotNull, IsCalendarDate, NameField, QueryBoolean, Reason, Rupees } from '../../common/fields';
import { IsIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';

// phase-3-financial.md slice 23 (R206-R208, R244); contracts/slice-23.md.

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;
const NULLABLE_ID = { ...ID, nullable: true } as const;
const DATE = { type: String, format: 'date', example: '2026-10-06' } as const;
const NULLABLE_DATE_TIME = { type: String, format: 'date-time', nullable: true } as const;
const NULLABLE_TEXT = { type: String, nullable: true } as const;


const CATEGORY = { enum: EXPENSE_CATEGORIES, enumName: 'ExpenseCategory' } as const;
const RECORDABLE = { enum: RECORDABLE_EXPENSE_CATEGORIES, enumName: 'RecordableExpenseCategory' } as const;
const METHOD = { enum: COUNTER_PAYMENT_METHODS, enumName: 'CounterPaymentMethod' } as const;
const STATUS = { enum: EXPENSE_STATUSES, enumName: 'ExpenseStatus' } as const;

export class ExpenseDto {
  @ApiProperty(ID)
  id: string;

  /** The school's sequence, from 1. */
  @ApiProperty()
  expenseNo: number;

  @ApiProperty(CATEGORY)
  category: ExpenseCategory;

  @ApiProperty({ type: Number, minimum: 1, maximum: MAX_RUPEES, description: 'Whole rupees' })
  amount: number;

  @ApiProperty(DATE)
  spentOn: string;

  @ApiProperty()
  description: string;

  @ApiProperty(NULLABLE_TEXT)
  payee: string | null;

  @ApiProperty(METHOD)
  method: CounterPaymentMethod;

  @ApiProperty(NULLABLE_TEXT)
  reference: string | null;

  @ApiProperty()
  hasReceipt: boolean;

  /** image/jpeg, image/png or application/pdf; a PDF has no thumbnail. */
  @ApiProperty(NULLABLE_TEXT)
  receiptMime: string | null;

  @ApiProperty(STATUS)
  status: ExpenseStatus;

  /** A principal's own expense above the threshold, approved as recorded (R206). */
  @ApiProperty()
  selfApproved: boolean;

  @ApiProperty(ID)
  recordedByUserId: string;

  @ApiProperty()
  recordedByName: string;

  @ApiProperty({ type: String, format: 'date-time' })
  recordedAt: Date;

  @ApiProperty(NULLABLE_ID)
  decidedByUserId: string | null;

  @ApiProperty(NULLABLE_DATE_TIME)
  decidedAt: Date | null;

  @ApiProperty(NULLABLE_TEXT)
  decisionReason: string | null;

  @ApiProperty(NULLABLE_DATE_TIME)
  voidedAt: Date | null;

  @ApiProperty(NULLABLE_TEXT)
  voidReason: string | null;

  /** The row's version: a decision sends it back as `expectedUpdatedAt` (compare-and-set). */
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export const EXPENSE_SORTS = ['-spentOn', 'spentOn'] as const;
export type ExpenseSort = (typeof EXPENSE_SORTS)[number];

export class ListExpensesQueryDto extends PageQueryDto {
  @ApiPropertyOptional(DATE)
  @IsOptional()
  @IsCalendarDate()
  spentFrom?: string;

  @ApiPropertyOptional(DATE)
  @IsOptional()
  @IsCalendarDate()
  spentTo?: string;

  /** Decided (approved or rejected; a self-approved one when recorded) on or after this day, school time (slice 27). */
  @ApiPropertyOptional({ ...DATE, description: 'Decided on or after this day (school time)' })
  @IsOptional()
  @IsCalendarDate()
  decidedFrom?: string;

  @ApiPropertyOptional({ ...DATE, description: 'Decided on or before this day (school time)' })
  @IsOptional()
  @IsCalendarDate()
  decidedTo?: string;

  @ApiPropertyOptional(CATEGORY)
  @IsOptional()
  @IsIn(EXPENSE_CATEGORIES)
  category?: ExpenseCategory;

  @ApiPropertyOptional(STATUS)
  @IsOptional()
  @IsIn(EXPENSE_STATUSES)
  status?: ExpenseStatus;

  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  recordedByUserId?: string;

  /** The principal's own above-threshold expenses (R206): the dashboard's "self-approved this month" tile (slice 27). */
  @QueryBoolean({ description: "True lists only self-approved expenses, false only the others" })
  selfApproved?: boolean;

  @ApiPropertyOptional({ enum: EXPENSE_SORTS, enumName: 'ExpenseSort', default: '-spentOn' })
  @IsOptional()
  @IsIn(EXPENSE_SORTS)
  sort?: ExpenseSort;
}

/**
 * Text that reaches the expenses table: trimmed, no control characters, no identity number
 * (CHECKs expenses_*_no_id_check, R208).
 */
export class CreateExpenseDto {
  @ApiProperty(RECORDABLE)
  @IsIn(RECORDABLE_EXPENSE_CATEGORIES)
  category: RecordableExpenseCategory;

  @ApiProperty({ type: Number, minimum: 1, maximum: MAX_RUPEES, description: 'Whole rupees' })
  @Rupees(1)
  amount: number;

  /** No later than today in the school's time zone. */
  @ApiProperty(DATE)
  @IsCalendarDate()
  spentOn: string;

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @NameField(1, 500)
  description: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @IfPresent()
  @NameField(1, 100)
  payee?: string;

  @ApiProperty(METHOD)
  @IsIn(COUNTER_PAYMENT_METHODS)
  method: CounterPaymentMethod;

  /** A cheque, transfer or bill number. */
  @ApiPropertyOptional({ minLength: 1, maxLength: 60 })
  @IfPresent()
  @NameField(1, 60)
  reference?: string;

  /** The receipt image or PDF (POST /uploads); the phone sends it later through PATCH .../receipt. */
  @ApiPropertyOptional(ID)
  @IfPresent()
  @IsIdString()
  stagedUploadId?: string;
}

/** The recorder's edit while the expense is open; `null` clears payee or reference. */
export class UpdateExpenseDto {
  @ApiPropertyOptional(RECORDABLE)
  @IfPresent()
  @IsIn(RECORDABLE_EXPENSE_CATEGORIES)
  category?: RecordableExpenseCategory;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: MAX_RUPEES, description: 'Whole rupees' })
  @IfPresent()
  @Rupees(1)
  amount?: number;

  @ApiPropertyOptional(DATE)
  @IfPresent()
  @IsCalendarDate()
  spentOn?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 500 })
  @IfPresent()
  @NameField(1, 500)
  description?: string;

  @ApiPropertyOptional({ ...NULLABLE_TEXT, minLength: 1, maxLength: 100 })
  @IfPresentNotNull()
  @NameField(1, 100)
  payee?: string | null;

  @ApiPropertyOptional(METHOD)
  @IfPresent()
  @IsIn(COUNTER_PAYMENT_METHODS)
  method?: CounterPaymentMethod;

  @ApiPropertyOptional({ ...NULLABLE_TEXT, minLength: 1, maxLength: 60 })
  @IfPresentNotNull()
  @NameField(1, 60)
  reference?: string | null;
}

export class ExpenseReceiptDto {
  @ApiProperty({ ...ID, description: 'A staged upload of the caller (POST /uploads)' })
  @IsIdString()
  stagedUploadId: string;
}

const EXPECTED_UPDATED_AT = {
  type: String,
  format: 'date-time',
  description:
    "The expense's updatedAt as the approver read it: the decision applies only to that version, else 409 CONCURRENT_UPDATE",
} as const;

/** Approval may say why; it applies only to the version the approver saw. */
export class ApproveExpenseDto {
  @ApiProperty(EXPECTED_UPDATED_AT)
  @IsISO8601({ strict: true })
  expectedUpdatedAt: string;

  @ApiPropertyOptional({ minLength: 3, maxLength: 500 })
  @IfPresent()
  @Reason()
  reason?: string;
}

/** A rejection says why; it applies only to the version the approver saw. */
export class RejectExpenseDto {
  @ApiProperty(EXPECTED_UPDATED_AT)
  @IsISO8601({ strict: true })
  expectedUpdatedAt: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;
}
