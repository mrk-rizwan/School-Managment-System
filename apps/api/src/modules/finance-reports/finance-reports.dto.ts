import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { CONTACT_CAPABILITIES, MAX_RUPEES, type ContactCapability } from '@asms/shared';
import { IfPresent, IsCalendarDate, IsYearMonth, QueryBoolean } from '../../common/fields';
import { IsIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';
import { ChargeDto, EachIdString } from '../fees/charges.dto';

// phase-3-financial.md slice 22 (R201-R205, R228, R250; contracts/slice-22.md §1). Every report
// is under finance.report.view and the `finance-reports` throttle; date ranges are at most 92
// days, payroll at most 24 months. Amounts are whole rupees.

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;
const MONTH = { type: String, pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$', example: '2026-04' } as const;
const DATE = { type: String, format: 'date' } as const;
const DATE_TIME = { type: String, format: 'date-time' } as const;
const RUPEES = { type: Number, minimum: 0, maximum: MAX_RUPEES, description: 'Whole rupees' } as const;
const SIGNED_RUPEES = { type: Number, description: 'Whole rupees; may be negative' } as const;

/** A query-string whole-rupee amount (`minOutstanding`): plain digits only, else 422. */
const QueryRupees = (): PropertyDecorator =>
  applyDecorators(
    Transform(({ value }: { value: unknown }) => (typeof value === 'string' && /^[0-9]{1,9}$/.test(value) ? Number(value) : value)),
    IsInt(),
    Min(0),
    Max(MAX_RUPEES),
  );

// --------------------------------------------------------------------------------- shared

export class AmountCountDto {
  @ApiProperty(RUPEES) amount: number;
  @ApiProperty({ type: Number, minimum: 0 }) count: number;
}

/** One group of a grouped report: the key (an id, a code, a day), its label, the sum, the rows in it. */
export class ReportRowDto {
  @ApiProperty() key: string;
  @ApiProperty() label: string;
  @ApiProperty(RUPEES) amount: number;
  @ApiProperty({ type: Number, minimum: 0 }) count: number;
}

// ------------------------------------------------------------------------------ defaulters

export const DEFAULTER_SORTS = ['-outstanding', 'studentName', 'className', 'oldestDueOn', '-oldestDueOn'] as const;
export type DefaulterSortDto = (typeof DEFAULTER_SORTS)[number];

export class DefaultersQueryDto extends PageQueryDto {
  @ApiPropertyOptional(ID) @IsOptional() @IsIdString() classId?: string;
  @ApiPropertyOptional(ID) @IsOptional() @IsIdString() sectionId?: string;

  @ApiPropertyOptional({ ...RUPEES, description: 'Only students owing at least this much' })
  @IsOptional()
  @QueryRupees()
  minOutstanding?: number;

  @QueryBoolean({ description: 'Only students with something past its due date', default: false })
  overdueOnly?: boolean;

  @ApiPropertyOptional({
    enum: DEFAULTER_SORTS,
    enumName: 'DefaulterSort',
    default: '-outstanding',
    description: '`oldestDueOn`: the longest-owed first',
  })
  @IsOptional()
  @IsIn(DEFAULTER_SORTS)
  sort?: DefaulterSortDto;
}

export class FeePayerDto {
  @ApiProperty() name: string;
  @ApiProperty({ enum: CONTACT_CAPABILITIES, enumName: 'ContactCapability' }) contactCapability: ContactCapability;
}

export class DefaulterDto {
  @ApiProperty(ID) studentId: string;
  @ApiProperty() studentName: string;
  @ApiProperty() admissionNo: string;
  /** The student's latest enrolment (a left student keeps their last class). */
  @ApiProperty({ type: String, nullable: true }) className: string | null;
  @ApiProperty({ type: String, nullable: true }) sectionName: string | null;
  /** Σ amount − allocated − credited over every open charge, every year (R203). */
  @ApiProperty(RUPEES) outstanding: number;
  /** The part of it past its due date. */
  @ApiProperty(RUPEES) overdue: number;
  @ApiProperty(DATE) oldestDueOn: string;
  @ApiProperty({ type: Number, minimum: 1 }) openCharges: number;
  @ApiProperty({ type: () => FeePayerDto, nullable: true }) feePayer: FeePayerDto | null;
  @ApiProperty({ ...DATE, nullable: true }) lastPaymentOn: string | null;
  @ApiProperty({ ...DATE_TIME, nullable: true }) lastReminderAt: Date | null;
  @ApiProperty() pendingClaim: boolean;
}

// ----------------------------------------------------------------------------- collections

export const COLLECTION_GROUPS = ['day', 'method', 'feeHead', 'class', 'collector'] as const;
export const COLLECTION_BASES = ['received', 'verified'] as const;

export class CollectionsQueryDto {
  @ApiProperty({ ...DATE, description: 'Inclusive; at most 92 days before receivedTo' })
  @IsCalendarDate()
  receivedFrom: string;

  @ApiProperty({ ...DATE, description: 'Inclusive' })
  @IsCalendarDate()
  receivedTo: string;

  @ApiProperty({ enum: COLLECTION_GROUPS, enumName: 'CollectionGroup' })
  @IsIn(COLLECTION_GROUPS)
  groupBy: (typeof COLLECTION_GROUPS)[number];

  @ApiPropertyOptional({
    enum: COLLECTION_BASES,
    enumName: 'CollectionBasis',
    default: 'verified',
    description: 'Rule 25: the day a payment was received, or the day it was verified (credited)',
  })
  @IsOptional()
  @IsIn(COLLECTION_BASES)
  basis?: (typeof COLLECTION_BASES)[number];
}

export class CollectionsReportDto {
  @ApiProperty({ enum: COLLECTION_BASES, enumName: 'CollectionBasis' }) basis: (typeof COLLECTION_BASES)[number];
  @ApiProperty({ type: () => ReportRowDto, isArray: true }) rows: ReportRowDto[];
  /** Non-voided receipts of the window (claims and carried-forward payments are never here). */
  @ApiProperty(RUPEES) total: number;
  @ApiProperty({ type: Number, minimum: 0 }) count: number;
  /** Refunds made in the window, their own line (§0.20). */
  @ApiProperty({ type: () => AmountCountDto }) refunds: AmountCountDto;
  /** Refunds undone in the window. */
  @ApiProperty({ type: () => AmountCountDto }) refundReversals: AmountCountDto;
  /** total − refunds + refundReversals. */
  @ApiProperty(SIGNED_RUPEES) net: number;
  /** Receipts of the window since voided: not in total. */
  @ApiProperty({ type: () => AmountCountDto }) voided: AmountCountDto;
  /** Advances moved to another year in the window: no money moved, never collections. */
  @ApiProperty({ type: () => AmountCountDto }) carriedForward: AmountCountDto;
  /** Carry-forwards undone in the window (the advance back in its source year): never collections. */
  @ApiProperty({ type: () => AmountCountDto }) carryForwardReversals: AmountCountDto;
}

// ----------------------------------------------------------------------------- outstanding

export const OUTSTANDING_GROUPS = ['class', 'feeHead', 'period'] as const;

export class OutstandingQueryDto {
  @ApiProperty(ID) @IsIdString() academicYearId: string;

  @ApiPropertyOptional({ enum: OUTSTANDING_GROUPS, enumName: 'OutstandingGroup', default: 'class' })
  @IsOptional()
  @IsIn(OUTSTANDING_GROUPS)
  groupBy?: (typeof OUTSTANDING_GROUPS)[number];
}

export class OutstandingReportDto {
  /** Today's figures; there is no as-of date. */
  @ApiProperty(DATE) asOf: string;
  @ApiProperty({ type: () => ReportRowDto, isArray: true }) rows: ReportRowDto[];
  /** Σ amount − allocated − credited over the year's open charges. */
  @ApiProperty(RUPEES) total: number;
  /** The year's credits (adjustment rows), their own line. */
  @ApiProperty({ type: () => AmountCountDto }) adjustments: AmountCountDto;
}

// ------------------------------------------------------------------------------ daily cash

export class DailyCashQueryDto {
  @ApiProperty(DATE) @IsCalendarDate() date: string;
}

export class CollectorCashDto {
  @ApiProperty(ID) collectorUserId: string;
  @ApiProperty() collector: string;
  @ApiProperty(RUPEES) amount: number;
  /** When the oldest of these payments was recorded. */
  @ApiProperty(DATE_TIME) since: Date;
}

export class HandedOverDto {
  @ApiProperty(ID) handoverId: string;
  @ApiProperty({ enum: ['open', 'confirmed'] }) status: string;
  @ApiProperty() collector: string;
  @ApiProperty({ type: String, nullable: true }) confirmedBy: string | null;
  /** The whole handover's figures (it may gather several days' cash). */
  @ApiProperty(RUPEES) expected: number;
  @ApiProperty({ ...RUPEES, nullable: true }) counted: number | null;
  @ApiProperty({ ...RUPEES, nullable: true }) shortfall: number | null;
  @ApiProperty({ ...RUPEES, nullable: true }) surplus: number | null;
  @ApiProperty({ enum: ['recovered', 'written_off', 'explained_by_void'], nullable: true }) shortfallResolution: string | null;
  /** The part of this day's cash payments in it. */
  @ApiProperty(RUPEES) fromDay: number;
}

export class DailyCashReportDto {
  @ApiProperty(DATE) date: string;
  /** Cash payments received that day (voided ones included). */
  @ApiProperty(RUPEES) cashReceived: number;
  /** Of those, voided while still with their collector. */
  @ApiProperty(RUPEES) voidedBeforeHandover: number;
  @ApiProperty({ type: () => CollectorCashDto, isArray: true }) withCollectors: CollectorCashDto[];
  @ApiProperty({ type: () => HandedOverDto, isArray: true }) handedOver: HandedOverDto[];
  /** Of the handed-over ones, voided after the handover (they stay in its expected amount). */
  @ApiProperty(RUPEES) voidedAfterHandover: number;
  /** Refunds paid in cash that day, net of their reversals. */
  @ApiProperty(SIGNED_RUPEES) refundsPaidCash: number;
  /** Recorded and approved cash expenses of the day, written-off shortfalls included. */
  @ApiProperty(RUPEES) cashExpenses: number;
  /** The written-off shortfalls among cashExpenses. */
  @ApiProperty(RUPEES) shortfallWrittenOff: number;
  @ApiProperty(RUPEES) salariesPaidCash: number;
}

// ----------------------------------------------------------------------------- concessions

export const CONCESSION_GROUPS = ['feeHead', 'class'] as const;

export class ConcessionsQueryDto {
  @ApiProperty(ID) @IsIdString() academicYearId: string;

  @ApiPropertyOptional({ enum: CONCESSION_GROUPS, enumName: 'ConcessionGroup', default: 'feeHead' })
  @IsOptional()
  @IsIn(CONCESSION_GROUPS)
  groupBy?: (typeof CONCESSION_GROUPS)[number];
}

export class ConcessionRowDto {
  @ApiProperty() key: string;
  @ApiProperty() label: string;
  @ApiProperty({ type: Number, minimum: 0 }) students: number;
  /** Concessions at birth plus a concession's credits on open charges. */
  @ApiProperty(RUPEES) reduction: number;
}

export class ConcessionsReportDto {
  @ApiProperty({ type: () => ConcessionRowDto, isArray: true }) rows: ConcessionRowDto[];
  @ApiProperty(RUPEES) total: number;
}

// -------------------------------------------------------------------------------- expenses

export const EXPENSE_GROUPS = ['category', 'day', 'method', 'recorder'] as const;

export class ExpensesQueryDto {
  @ApiProperty({ ...DATE, description: 'Inclusive; at most 92 days before spentTo' })
  @IsCalendarDate()
  spentFrom: string;

  @ApiProperty(DATE) @IsCalendarDate() spentTo: string;

  @ApiPropertyOptional({ enum: EXPENSE_GROUPS, enumName: 'ExpenseGroup', default: 'category' })
  @IsOptional()
  @IsIn(EXPENSE_GROUPS)
  groupBy?: (typeof EXPENSE_GROUPS)[number];
}

export class RecorderTotalDto {
  @ApiProperty(ID) recorderUserId: string;
  @ApiProperty() recorder: string;
  @ApiProperty(RUPEES) amount: number;
  @ApiProperty({ type: Number, minimum: 0 }) count: number;
}

export class ExpensesReportDto {
  /** Recorded and approved expenses only. */
  @ApiProperty({ type: () => ReportRowDto, isArray: true }) rows: ReportRowDto[];
  @ApiProperty(RUPEES) total: number;
  @ApiProperty({ type: () => AmountCountDto }) pendingApproval: AmountCountDto;
  /** R208: expenses recorded at or below the approval threshold, per recorder. */
  @ApiProperty({ type: () => RecorderTotalDto, isArray: true }) subThresholdByRecorder: RecorderTotalDto[];
}

// --------------------------------------------------------------------------------- payroll

export class PayrollQueryDto {
  @ApiProperty(MONTH) @IsYearMonth() from: string;
  @ApiProperty({ ...MONTH, description: 'At most 24 months from `from`, inclusive' }) @IsYearMonth() to: string;
}

export class PayrollMonthDto {
  @ApiProperty(MONTH) yearMonth: string;
  @ApiProperty({ type: Number, minimum: 0 }) staffCount: number;
  /** Σ basic + allowances. */
  @ApiProperty(RUPEES) gross: number;
  /** Σ named deductions + absence + advance recoveries. */
  @ApiProperty(RUPEES) deductions: number;
  /** Σ signed adjustments. */
  @ApiProperty(SIGNED_RUPEES) adjustments: number;
  /** gross − deductions + adjustments. */
  @ApiProperty(RUPEES) net: number;
  @ApiProperty(RUPEES) paid: number;
  @ApiProperty(RUPEES) unpaid: number;
}

export class PayrollReportDto {
  /** Finalised runs only. */
  @ApiProperty({ type: () => PayrollMonthDto, isArray: true }) rows: PayrollMonthDto[];
  @ApiProperty({ type: () => PayrollMonthDto }) total: PayrollMonthDto;
}

// ------------------------------------------------------------------------------- reminders

export const REMINDER_KINDS = ['due', 'overdue'] as const;

export class SendRemindersDto {
  @ApiProperty({ enum: REMINDER_KINDS, enumName: 'ReminderKind' })
  @IsIn(REMINDER_KINDS)
  kind: (typeof REMINDER_KINDS)[number];

  @ApiPropertyOptional({ ...ID, description: 'At most one of classId, sectionId and studentIds; none = every family' })
  @IfPresent()
  @IsIdString()
  classId?: string;

  @ApiPropertyOptional(ID) @IfPresent() @IsIdString() sectionId?: string;

  @ApiPropertyOptional({ ...ID, isArray: true, minItems: 1, maxItems: 50, description: "These students' families" })
  @IfPresent()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @EachIdString()
  studentIds?: string[];
}

export class RemindersSentDto {
  /** Families reminded now (one message each). */
  @ApiProperty({ type: Number, minimum: 0 }) families: number;
  /** SMS units the always-SMS legs will spend. */
  @ApiProperty({ type: Number, minimum: 0 }) smsUnits: number;
  /** Reminders with a WhatsApp, SMS or push leg queued. */
  @ApiProperty({ type: Number, minimum: 0 }) enqueued: number;
  /** Families sent without their SMS leg because the month's allowance would be exceeded (R250). */
  @ApiProperty({ type: Number, minimum: 0 }) capped: number;
}

// -------------------------------------------------------------------------- dues clearance

export class ClearanceOverrideDto {
  @ApiProperty(ID) byUserId: string;
  @ApiProperty() byName: string;
  @ApiProperty(DATE_TIME) at: Date;
  @ApiProperty() reason: string;
}

export class DuesClearanceDto {
  @ApiProperty(ID) studentId: string;
  /** Across every enrolment, every year (A7). */
  @ApiProperty(RUPEES) outstanding: number;
  /** The oldest due first; at most 100. */
  @ApiProperty({ type: () => ChargeDto, isArray: true }) openCharges: ChargeDto[];
  /** Unspent advance held for the child (refundable, rule 20). */
  @ApiProperty(RUPEES) advance: number;
  /** Nothing owed, or a principal's override dated after the newest open charge. */
  @ApiProperty() cleared: boolean;
  @ApiProperty({ type: () => ClearanceOverrideDto, nullable: true }) override: ClearanceOverrideDto | null;
}
