import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, Max, Min, ValidateIf } from 'class-validator';
import {
  BILLING_SKIP_REASONS,
  INVOICE_STATUSES,
  MAX_RUPEES,
  PLAN_STATUSES,
  type BillingSkipReason,
  type InvoiceStatus,
  type PlanStatus,
} from '@asms/shared';
import {
  IfPresent,
  IsCalendarDate,
  IsYearMonth,
  NameField,
  QueryBoolean,
  Reason,
  Rupees,
} from '../../../common/fields';
import { IsIdString } from '../../../common/ids';
import { PageQueryDto } from '../../../common/pagination';

// contracts/slice-26.md §1 (phase-3-financial.md slice 26, R219-R224). Platform routes only.

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;
/** schools.sms_monthly_cap is 0-100000 (CHECK); a plan's allowance becomes that cap. */
const SMS_ALLOWANCE_MAX = 100_000;
/** A band edge: far beyond any school, inside a Postgres integer. */
const STUDENTS_MAX = 1_000_000;

// ------------------------------------------------------------------------------------- plans

export class PlanDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty()
  name: string;

  /** Inclusive lower edge of the band. Frozen. */
  @ApiProperty({ type: 'integer', minimum: 0 })
  minStudents: number;

  /** Inclusive upper edge; null = unbounded. Frozen. */
  @ApiProperty({ type: 'integer', nullable: true })
  maxStudents: number | null;

  @ApiProperty({ type: 'integer', minimum: 0, description: 'Whole rupees a month' })
  monthlyPrice: number;

  @ApiProperty({ type: 'integer', minimum: 0, description: 'SMS segments a month' })
  smsAllowance: number;

  @ApiProperty({ enum: PLAN_STATUSES, enumName: 'PlanStatus' })
  status: PlanStatus;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  archivedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class ListPlansQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: PLAN_STATUSES, enumName: 'PlanStatus' })
  @IsOptional()
  @IsIn(PLAN_STATUSES)
  status?: PlanStatus;
}

export class CreatePlanDto {
  @ApiProperty({ minLength: 2, maxLength: 60 })
  @NameField(2, 60)
  name: string;

  @ApiProperty({ type: 'integer', minimum: 0, maximum: STUDENTS_MAX })
  @IsInt()
  @Min(0)
  @Max(STUDENTS_MAX)
  minStudents: number;

  /** Omitted or null: no upper bound. */
  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: STUDENTS_MAX, nullable: true })
  @ValidateIf((_o, value) => value !== undefined && value !== null)
  @IsInt()
  @Min(0)
  @Max(STUDENTS_MAX)
  maxStudents?: number | null;

  @ApiProperty({ type: 'integer', minimum: 0, maximum: MAX_RUPEES })
  @Rupees()
  monthlyPrice: number;

  @ApiProperty({ type: 'integer', minimum: 0, maximum: SMS_ALLOWANCE_MAX })
  @IsInt()
  @Min(0)
  @Max(SMS_ALLOWANCE_MAX)
  smsAllowance: number;
}

/** Bands are frozen: minStudents and maxStudents are not accepted (422 as unknown fields). */
export class UpdatePlanDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 60 })
  @IfPresent()
  @NameField(2, 60)
  name?: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: MAX_RUPEES })
  @IfPresent()
  @Rupees()
  monthlyPrice?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: SMS_ALLOWANCE_MAX })
  @IfPresent()
  @IsInt()
  @Min(0)
  @Max(SMS_ALLOWANCE_MAX)
  smsAllowance?: number;
}

// ----------------------------------------------------------------------------- subscriptions

export class SubscriptionDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(ID)
  schoolId: string;

  @ApiProperty(ID)
  planId: string;

  @ApiProperty()
  planName: string;

  @ApiProperty({ type: String, format: 'date' })
  startedOn: string;

  /** Inclusive; null while live. */
  @ApiProperty({ type: String, format: 'date', nullable: true })
  endedOn: string | null;

  /** A manual override: billed on this plan whatever the student count, until unpinned. */
  @ApiProperty()
  pinned: boolean;

  /** False when the monthly run derived it from the student count. */
  @ApiProperty()
  assignedByPlatform: boolean;

  @ApiProperty({ type: String, nullable: true })
  reason: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

export class AssignPlanDto {
  @ApiProperty(ID)
  @IsIdString()
  planId: string;

  /** The new subscription's first day; on or after the current one's start. */
  @ApiProperty({ type: String, format: 'date' })
  @IsCalendarDate()
  startedOn: string;

  /** Required: an assignment pins the school (CHECK platform_subscriptions_pinned_check). */
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;
}

export class MetricsDto {
  @ApiProperty({ type: String, format: 'date' })
  day: string;

  @ApiProperty({ type: 'integer', minimum: 0 })
  activeStudents: number;
}

export class SmsCapDto {
  @ApiProperty({ type: 'integer', minimum: 0 })
  value: number;

  @ApiProperty()
  overridden: boolean;
}

// ---------------------------------------------------------------------------------- invoices

export class InvoiceDto {
  @ApiProperty(ID)
  id: string;

  /** `INV-YYYY-NNNNN`. */
  @ApiProperty()
  invoiceNo: string;

  @ApiProperty(ID)
  schoolId: string;

  @ApiProperty()
  schoolName: string;

  /** The month billed, `YYYY-MM`. */
  @ApiProperty()
  yearMonth: string;

  @ApiProperty()
  planName: string;

  @ApiProperty({ type: 'integer', minimum: 0 })
  studentCount: number;

  @ApiProperty({ type: 'integer', minimum: 0, description: 'Whole rupees' })
  amount: number;

  @ApiProperty({ type: String, format: 'date' })
  dueOn: string;

  @ApiProperty({ enum: INVOICE_STATUSES, enumName: 'InvoiceStatus' })
  status: InvoiceStatus;

  @ApiProperty({ type: String, format: 'date-time' })
  issuedAt: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  overdueAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  suspensionEligibleAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  paidAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  voidedAt: Date | null;
}

export const INVOICE_SORTS = ['-issuedAt', 'dueOn'] as const;
export type InvoiceSortParam = (typeof INVOICE_SORTS)[number];

export class ListInvoicesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: INVOICE_STATUSES, enumName: 'InvoiceStatus' })
  @IsOptional()
  @IsIn(INVOICE_STATUSES)
  status?: InvoiceStatus;

  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  schoolId?: string;

  @ApiPropertyOptional({ pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' })
  @IsOptional()
  @IsYearMonth()
  yearMonth?: string;

  /** R221: stamped eligible and still unpaid. */
  @QueryBoolean({ description: 'Only (true) or never (false) the invoices eligible for suspension' })
  suspensionEligible?: boolean;

  @ApiPropertyOptional({ enum: INVOICE_SORTS, default: '-issuedAt' })
  @IsOptional()
  @IsIn(INVOICE_SORTS)
  sort?: InvoiceSortParam;
}

export class RecordPlatformPaymentDto {
  /** The invoice amount: full payment only (A11). */
  @ApiProperty({ type: 'integer', minimum: 1, maximum: MAX_RUPEES })
  @Rupees(1)
  amount: number;

  /** Not in the future. */
  @ApiProperty({ type: String, format: 'date' })
  @IsCalendarDate()
  receivedOn: string;

  /** The bank or transfer reference. */
  @ApiProperty({ minLength: 1, maxLength: 60 })
  @NameField(1, 60)
  reference: string;
}

export class IssueMonthDto {
  /** Not later than the current month. */
  @ApiProperty({ pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' })
  @IsYearMonth()
  yearMonth: string;
}

export class BillingSkipDto {
  @ApiProperty(ID)
  schoolId: string;

  @ApiProperty({ enum: BILLING_SKIP_REASONS, enumName: 'BillingSkipReason' })
  reason: BillingSkipReason;
}

export class IssueMonthResultDto {
  /** Invoices this run wrote. */
  @ApiProperty({ type: 'integer' })
  issued: number;

  /** Schools that already had a non-void invoice for the month (the run is idempotent). */
  @ApiProperty({ type: 'integer' })
  existing: number;

  @ApiProperty({ type: [BillingSkipDto] })
  skipped: BillingSkipDto[];

  /** Schools whose issue failed for another reason (logged); running the month again retries them. */
  @ApiProperty({ type: 'integer' })
  failed: number;
}

export class SchoolBillingDto {
  @ApiProperty({ type: SubscriptionDto, nullable: true })
  subscription: SubscriptionDto | null;

  /** The latest daily student count of any age; billing uses one at most 7 days old. */
  @ApiProperty({ type: MetricsDto, nullable: true })
  metrics: MetricsDto | null;

  /** The last 12, newest month first. */
  @ApiProperty({ type: [InvoiceDto] })
  invoices: InvoiceDto[];

  @ApiProperty({ type: SmsCapDto })
  smsCap: SmsCapDto;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  terminatedAt: Date | null;

  /** 12 months after termination (rule 23); no purge exists (R224). */
  @ApiProperty({ type: String, format: 'date', nullable: true })
  retentionEndsOn: string | null;
}
