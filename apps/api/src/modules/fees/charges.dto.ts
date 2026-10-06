import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, ValidateBy } from 'class-validator';
import {
  CHARGE_KINDS,
  CHARGE_RUN_KINDS,
  CHARGE_RUN_STATUSES,
  CHARGE_STATUSES,
  CONCESSION_KINDS,
  CONCESSION_STATUSES,
  MAX_RUPEES,
  type ChargeKind,
  type ChargeRunKind,
  type ChargeRunStatus,
  type ChargeStatus,
  type ConcessionKind,
  type ConcessionStatus,
} from '@asms/shared';
import { IfPresent, IsCalendarDate, IsYearMonth, Reason, Rupees, TextField } from '../../common/fields';
import { isIdString, IsIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';

// phase-3-financial.md slice 19 (R179-R186, R205, R239-R242).

/** Every element an id string (IsIdString for an array). */
export const EachIdString = (): PropertyDecorator =>
  ValidateBy(
    {
      name: 'isIdString',
      validator: { validate: isIdString, defaultMessage: () => 'each value in $property must be an id' },
    },
    { each: true },
  );

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;
const NULLABLE_ID = { ...ID, nullable: true } as const;
const MONTH = { type: String, pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$', example: '2026-04' } as const;
const DATE = { type: String, format: 'date' } as const;
const DATE_TIME = { type: String, format: 'date-time' } as const;
const RUPEES = { type: Number, minimum: 0, maximum: MAX_RUPEES, description: 'Whole rupees' } as const;

// ----------------------------------------------------------------------------------- charges

export class ChargeDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(ID) studentId: string;
  @ApiProperty() studentName: string;
  @ApiProperty() admissionNo: string;
  @ApiProperty(ID) enrolmentId: string;
  @ApiProperty() className: string;
  @ApiProperty() sectionName: string;
  @ApiProperty(ID) academicYearId: string;
  @ApiProperty(ID) feeHeadId: string;
  @ApiProperty() feeHeadName: string;
  @ApiProperty({ enum: CHARGE_KINDS, enumName: 'ChargeKind' }) kind: ChargeKind;
  @ApiProperty({ ...MONTH, nullable: true }) period: string | null;
  @ApiProperty(NULLABLE_ID) campaignId: string | null;
  @ApiProperty(NULLABLE_ID) lateFeeForChargeId: string | null;
  @ApiProperty(NULLABLE_ID) adjustsChargeId: string | null;
  @ApiProperty(NULLABLE_ID) concessionId: string | null;
  @ApiProperty(RUPEES) grossAmount: number;
  @ApiProperty(RUPEES) concessionAmount: number;
  /** gross − concession: what the charge asks for. */
  @ApiProperty(RUPEES) amount: number;
  @ApiProperty(RUPEES) allocatedAmount: number;
  @ApiProperty(RUPEES) creditedAmount: number;
  /** amount − allocated − credited (rule 0.22). */
  @ApiProperty(RUPEES) outstanding: number;
  @ApiProperty() description: string;
  /** Rule 25: the charge-due date. */
  @ApiProperty(DATE) dueOn: string;
  @ApiProperty({ enum: CHARGE_STATUSES, enumName: 'ChargeStatus' }) status: ChargeStatus;
  @ApiProperty({ ...DATE_TIME, nullable: true }) settledAt: Date | null;
  @ApiProperty({ ...DATE_TIME, nullable: true }) voidedAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) voidReason: string | null;
  @ApiProperty({ ...DATE_TIME, nullable: true }) waivedAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) waiveReason: string | null;
  /** Null when the job wrote it. */
  @ApiProperty(NULLABLE_ID) createdByUserId: string | null;
  @ApiProperty(DATE_TIME) createdAt: Date;
}

export const CHARGE_SORTS = ['-dueOn', 'dueOn', 'studentName'] as const;
export type ChargeSortDto = (typeof CHARGE_SORTS)[number];

export class ListChargesQueryDto extends PageQueryDto {
  @ApiPropertyOptional(ID) @IsOptional() @IsIdString() studentId?: string;
  @ApiPropertyOptional(ID) @IsOptional() @IsIdString() academicYearId?: string;
  @ApiPropertyOptional(ID) @IsOptional() @IsIdString() classId?: string;
  @ApiPropertyOptional(ID) @IsOptional() @IsIdString() sectionId?: string;
  @ApiPropertyOptional(ID) @IsOptional() @IsIdString() feeHeadId?: string;
  @ApiPropertyOptional(MONTH) @IsOptional() @IsYearMonth() period?: string;

  @ApiPropertyOptional({ enum: CHARGE_STATUSES, enumName: 'ChargeStatus' })
  @IsOptional()
  @IsIn(CHARGE_STATUSES)
  status?: ChargeStatus;

  @ApiPropertyOptional({ enum: CHARGE_KINDS, enumName: 'ChargeKind' })
  @IsOptional()
  @IsIn(CHARGE_KINDS)
  kind?: ChargeKind;

  @ApiPropertyOptional(DATE) @IsOptional() @IsCalendarDate() dueFrom?: string;
  @ApiPropertyOptional(DATE) @IsOptional() @IsCalendarDate() dueTo?: string;

  @ApiPropertyOptional({ ...DATE, description: 'Voided on or after this day (school time)' })
  @IsOptional()
  @IsCalendarDate()
  voidedFrom?: string;

  @ApiPropertyOptional({ enum: CHARGE_SORTS, enumName: 'ChargeSort', default: '-dueOn' })
  @IsOptional()
  @IsIn(CHARGE_SORTS)
  sort?: ChargeSortDto;
}

/** A manual charge (R186: `charge.create` voids it). */
export class CreateChargeDto {
  @ApiProperty(ID) @IsIdString() enrolmentId: string;
  @ApiProperty(ID) @IsIdString() feeHeadId: string;

  @ApiProperty({ ...RUPEES, minimum: 1 })
  @Rupees(1)
  amount: number;

  @ApiProperty({ ...DATE, description: 'Today or later' })
  @IsCalendarDate()
  dueOn: string;

  @ApiProperty({ minLength: 1, maxLength: 200 })
  @TextField(1, 200)
  description: string;

  @ApiPropertyOptional({ description: "Apply the student's approved concession on this head (R182)", default: false })
  @IfPresent()
  @IsBoolean()
  applyConcession?: boolean;
}

/** A credit (R186): its own settled row raising the original's credited amount. */
export class AdjustChargeDto {
  @ApiProperty({ ...RUPEES, minimum: 1 })
  @Rupees(1)
  amount: number;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;
}

// ------------------------------------------------------------------------------- charge runs

export class SkippedClassDto {
  @ApiProperty(ID) classId: string;
  @ApiProperty() className: string;
  /** `no_structure`: a head priced elsewhere in the year has no amount for this class. */
  @ApiProperty() reason: string;
}

export class ChargeRunDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(ID) academicYearId: string;
  @ApiProperty(MONTH) period: string;
  @ApiProperty({ enum: CHARGE_RUN_KINDS, enumName: 'ChargeRunKind' }) kind: ChargeRunKind;
  @ApiProperty(NULLABLE_ID) campaignId: string | null;
  @ApiProperty({ enum: CHARGE_RUN_STATUSES, enumName: 'ChargeRunStatus' }) status: ChargeRunStatus;
  @ApiProperty() regenerateVoided: boolean;
  /** Null when the schedule started it. */
  @ApiProperty(NULLABLE_ID) triggeredBy: string | null;
  @ApiProperty(DATE_TIME) queuedAt: Date;
  @ApiProperty({ ...DATE_TIME, nullable: true }) startedAt: Date | null;
  @ApiProperty({ ...DATE_TIME, nullable: true }) finishedAt: Date | null;
  @ApiProperty({ type: Number, minimum: 0 }) studentsCharged: number;
  @ApiProperty({ type: Number, minimum: 0 }) chargesInserted: number;
  @ApiProperty({ type: Number, minimum: 0 }) chargesSkipped: number;
  @ApiProperty({ type: () => SkippedClassDto, isArray: true }) skippedClasses: SkippedClassDto[];
  /** `stale` when the sweep failed it (R252). */
  @ApiProperty({ type: String, nullable: true }) errorCode: string | null;
}

export class GenerateMonthDto {
  @ApiProperty(ID) @IsIdString() academicYearId: string;
  @ApiProperty(MONTH) @IsYearMonth() period: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Recreate a generated charge that was voided (needs concession.grant and the principal)',
  })
  @IfPresent()
  @IsBoolean()
  regenerateVoided?: boolean;
}

export class ListChargeRunsQueryDto extends PageQueryDto {
  @ApiPropertyOptional(ID) @IsOptional() @IsIdString() academicYearId?: string;
  @ApiPropertyOptional(MONTH) @IsOptional() @IsYearMonth() period?: string;

  @ApiPropertyOptional({ enum: ['-queuedAt'], default: '-queuedAt' })
  @IsOptional()
  @IsIn(['-queuedAt'])
  sort?: '-queuedAt';
}

// ------------------------------------------------------------------------------- concessions

export class ConcessionHeadDto {
  @ApiProperty(ID) feeHeadId: string;
  @ApiProperty() name: string;
}

export class ConcessionDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(ID) studentId: string;
  @ApiProperty() studentName: string;
  @ApiProperty(ID) academicYearId: string;
  @ApiProperty(ID) enrolmentId: string;
  @ApiProperty() className: string;
  @ApiProperty({ enum: CONCESSION_KINDS, enumName: 'ConcessionKind' }) kind: ConcessionKind;
  /** 1-100 for a percentage; whole rupees per charge of each named head for a fixed amount. */
  @ApiProperty({ type: Number, minimum: 1 }) value: number;
  @ApiProperty({ type: () => ConcessionHeadDto, isArray: true }) heads: ConcessionHeadDto[];
  @ApiProperty(MONTH) effectiveFrom: string;
  @ApiProperty() reason: string;
  @ApiProperty({ enum: CONCESSION_STATUSES, enumName: 'ConcessionStatus' }) status: ConcessionStatus;
  @ApiProperty(ID) requestedByUserId: string;
  @ApiProperty({ type: String, nullable: true }) requestedByName: string | null;
  @ApiProperty(DATE_TIME) requestedAt: Date;
  @ApiProperty(NULLABLE_ID) decidedByUserId: string | null;
  @ApiProperty({ ...DATE_TIME, nullable: true }) decidedAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) decisionReason: string | null;
  /** The sole principal's own child (R253). */
  @ApiProperty() selfApproved: boolean;
  @ApiProperty({ ...DATE_TIME, nullable: true }) endedAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) endReason: string | null;
}

export const CONCESSION_SORTS = ['-requestedAt', 'requestedAt'] as const;

export class ListConcessionsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: CONCESSION_STATUSES, enumName: 'ConcessionStatus' })
  @IsOptional()
  @IsIn(CONCESSION_STATUSES)
  status?: ConcessionStatus;

  @ApiPropertyOptional(ID) @IsOptional() @IsIdString() studentId?: string;
  @ApiPropertyOptional(ID) @IsOptional() @IsIdString() academicYearId?: string;

  @ApiPropertyOptional({ enum: CONCESSION_SORTS, enumName: 'ConcessionSort', default: '-requestedAt' })
  @IsOptional()
  @IsIn(CONCESSION_SORTS)
  sort?: (typeof CONCESSION_SORTS)[number];
}

export class CreateConcessionDto {
  @ApiProperty(ID) @IsIdString() studentId: string;
  @ApiProperty(ID) @IsIdString() academicYearId: string;

  @ApiProperty({ enum: CONCESSION_KINDS, enumName: 'ConcessionKind' })
  @IsIn(CONCESSION_KINDS)
  kind: ConcessionKind;

  @ApiProperty({ type: Number, minimum: 1, maximum: MAX_RUPEES, description: '1-100 for a percentage' })
  @Rupees(1)
  value: number;

  @ApiProperty({ type: [String], minItems: 1, maxItems: 10 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @EachIdString()
  feeHeadIds: string[];

  @ApiProperty(MONTH) @IsYearMonth() effectiveFrom: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;
}

export class ApproveConcessionDto {
  @ApiPropertyOptional({ minLength: 3, maxLength: 500 })
  @IfPresent()
  @Reason()
  reason?: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Credit the open charges of the named heads from effectiveFrom (A6): one adjustment each',
  })
  @IfPresent()
  @IsBoolean()
  applyToOpenCharges?: boolean;
}

export class ConcessionDecisionDto {
  @ApiProperty({ type: () => ConcessionDto }) concession: ConcessionDto;
  @ApiProperty({ type: () => ChargeDto, isArray: true }) adjustments: ChargeDto[];
}

// --------------------------------------------------------------------------------- statement

export class StatementQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ ...ID, description: "Default: the year of the student's latest enrolment" })
  @IsOptional()
  @IsIdString()
  academicYearId?: string;
}

export class StatementPaymentDto {
  @ApiProperty(ID) paymentId: string;
  /** Null for a carried-forward payment, which has no receipt (R251). */
  @ApiProperty({ type: String, nullable: true }) receiptLabel: string | null;
  @ApiProperty(DATE) receivedOn: string;
  @ApiProperty(DATE_TIME) verifiedAt: Date;
  @ApiProperty(RUPEES) amount: number;
  @ApiProperty(RUPEES) allocated: number;
  @ApiProperty() method: string;
}

export class StatementTotalsDto {
  /** Σ gross of live charges. */
  @ApiProperty(RUPEES) charged: number;
  @ApiProperty(RUPEES) concession: number;
  /** Σ credits (adjustments) on live charges. */
  @ApiProperty(RUPEES) adjustments: number;
  @ApiProperty(RUPEES) paid: number;
  /** charged − concession − adjustments − paid. */
  @ApiProperty(RUPEES) outstanding: number;
  /** The child's unallocated advance in the year (slice 20). */
  @ApiProperty(RUPEES) advance: number;
}

export class StatementChargesPageDto {
  @ApiProperty({ type: () => ChargeDto, isArray: true }) data: ChargeDto[];
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
  @ApiProperty() total: number;
}

export class StatementDto {
  @ApiProperty(ID) studentId: string;
  @ApiProperty(NULLABLE_ID) academicYearId: string | null;
  @ApiProperty({ type: () => StatementChargesPageDto }) charges: StatementChargesPageDto;
  /** The payments that paid this child's charges of the year or hold their advance (slice 20). */
  @ApiProperty({ type: () => StatementPaymentDto, isArray: true }) payments: StatementPaymentDto[];
  @ApiProperty({ type: () => ChargeDto, isArray: true }) adjustments: ChargeDto[];
  @ApiProperty({ type: () => ConcessionDto, isArray: true }) concessions: ConcessionDto[];
  @ApiProperty({ type: () => StatementTotalsDto }) totals: StatementTotalsDto;
}
