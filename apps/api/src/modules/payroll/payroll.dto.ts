import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, Max, Min, NotEquals, ValidateNested } from 'class-validator';
import {
  ADVANCE_STATUSES,
  COUNTER_PAYMENT_METHODS,
  MAX_RUPEES,
  PAYROLL_RUN_STATUSES,
  PAYSLIP_LINE_KINDS,
  PAYSLIP_STATUSES,
  SALARY_COMPONENT_KINDS,
  SALARY_STRUCTURE_STATUSES,
  type AdvanceStatus,
  type CounterPaymentMethod,
  type PayrollRunStatus,
  type PayslipLineKind,
  type PayslipStatus,
  type SalaryComponentKind,
  type SalaryStructureStatus,
} from '@asms/shared';
import { IfPresent, IsCalendarDate, IsYearMonth, NameField, Reason, Rupees } from '../../common/fields';
import { IsIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';

// phase-3-financial.md slice 25 (R213-R218, R235, R245-R247); contracts/slice-25.md.

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;
const NULLABLE_ID = { ...ID, nullable: true } as const;
const DATE = { type: String, format: 'date', example: '2026-10-06' } as const;
const NULLABLE_DATE = { ...DATE, nullable: true } as const;
const DATE_TIME = { type: String, format: 'date-time' } as const;
const NULLABLE_DATE_TIME = { ...DATE_TIME, nullable: true } as const;
const NULLABLE_TEXT = { type: String, nullable: true } as const;
const MONTH = { type: String, pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$', example: '2026-09' } as const;
const RUPEES = { type: Number, minimum: 0, maximum: MAX_RUPEES, description: 'Whole rupees' } as const;
const METHOD = { enum: COUNTER_PAYMENT_METHODS, enumName: 'CounterPaymentMethod' } as const;

/** At most 20 components (salary_structure_components_position_check: 0-19). */
export const MAX_COMPONENTS = 20;

// ------------------------------------------------------------------------- salary structures

export class SalaryComponentDto {
  @ApiProperty({ enum: SALARY_COMPONENT_KINDS, enumName: 'SalaryComponentKind' })
  @IsIn(SALARY_COMPONENT_KINDS)
  kind: SalaryComponentKind;

  @ApiProperty({ minLength: 1, maxLength: 60 })
  @NameField(1, 60)
  name: string;

  @ApiProperty({ ...RUPEES, minimum: 1 })
  @Rupees(1)
  amount: number;
}

export class SalaryStructureDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(ID)
  staffId: string;

  @ApiProperty(RUPEES)
  basic: number;

  /** Allowances and deductions in their listed order; deductions are taken in this order (§3.3). */
  @ApiProperty({ type: [SalaryComponentDto] })
  components: SalaryComponentDto[];

  @ApiProperty(DATE)
  effectiveFrom: string;

  /** The day before its successor starts; null while open-ended. */
  @ApiProperty(NULLABLE_DATE)
  endedOn: string | null;

  @ApiProperty({ enum: SALARY_STRUCTURE_STATUSES, enumName: 'SalaryStructureStatus' })
  status: SalaryStructureStatus;

  /** The same-day replacement of a superseded row. */
  @ApiProperty(NULLABLE_ID)
  supersededBy: string | null;

  @ApiProperty(ID)
  createdByUserId: string;

  @ApiProperty()
  reason: string;

  /** The sole principal's own structure (R253). */
  @ApiProperty()
  selfApproved: boolean;

  @ApiProperty(DATE_TIME)
  createdAt: Date;
}

/** The caller's own structure in force today, and the next one if a change is recorded. */
export class MySalaryStructureDto {
  @ApiProperty({ type: SalaryStructureDto, nullable: true })
  current: SalaryStructureDto | null;

  @ApiProperty({ type: SalaryStructureDto, nullable: true })
  upcoming: SalaryStructureDto | null;
}

export class CreateSalaryStructureDto {
  @ApiProperty(RUPEES)
  @Rupees(0)
  basic: number;

  @ApiProperty({ type: [SalaryComponentDto], maxItems: MAX_COMPONENTS })
  @IsArray()
  @ArrayMaxSize(MAX_COMPONENTS)
  @ValidateNested({ each: true })
  @Type(() => SalaryComponentDto)
  components: SalaryComponentDto[];

  /** On or after the latest structure's start; the same day replaces it. */
  @ApiProperty(DATE)
  @IsCalendarDate()
  effectiveFrom: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;
}

// -------------------------------------------------------------------------------- advances

export class AdvanceDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(ID)
  staffId: string;

  @ApiProperty()
  staffName: string;

  @ApiProperty({ ...RUPEES, minimum: 1 })
  amount: number;

  @ApiProperty(DATE)
  grantedOn: string;

  /** The first payroll month that recovers. */
  @ApiProperty(MONTH)
  recoverFrom: string;

  @ApiProperty({ ...RUPEES, minimum: 1 })
  instalmentAmount: number;

  @ApiProperty(RUPEES)
  recoveredAmount: number;

  @ApiProperty(RUPEES)
  outstanding: number;

  @ApiProperty(ID)
  approvedByUserId: string;

  @ApiProperty(METHOD)
  paidMethod: CounterPaymentMethod;

  @ApiProperty(NULLABLE_TEXT)
  paidReference: string | null;

  /** The `salary_advance_cash` expense written with it (R215). */
  @ApiProperty(NULLABLE_ID)
  expenseId: string | null;

  @ApiProperty({ enum: ADVANCE_STATUSES, enumName: 'AdvanceStatus' })
  status: AdvanceStatus;

  @ApiProperty(NULLABLE_DATE_TIME)
  writtenOffAt: Date | null;

  @ApiProperty(NULLABLE_TEXT)
  writeOffReason: string | null;
}

export class ListAdvancesQueryDto extends PageQueryDto {
  @ApiPropertyOptional(ID)
  @IfPresent()
  @IsIdString()
  staffId?: string;

  @ApiPropertyOptional({ enum: ADVANCE_STATUSES, enumName: 'AdvanceStatus' })
  @IfPresent()
  @IsIn(ADVANCE_STATUSES)
  status?: AdvanceStatus;
}

export class CreateAdvanceDto {
  @ApiProperty(ID)
  @IsIdString()
  staffId: string;

  @ApiProperty({ ...RUPEES, minimum: 1 })
  @Rupees(1)
  amount: number;

  /** No later than today. */
  @ApiProperty(DATE)
  @IsCalendarDate()
  grantedOn: string;

  /** Default the month after grantedOn; never before grantedOn's month. */
  @ApiPropertyOptional(MONTH)
  @IfPresent()
  @IsYearMonth()
  recoverFrom?: string;

  /** At most `amount`. */
  @ApiProperty({ ...RUPEES, minimum: 1 })
  @Rupees(1)
  instalmentAmount: number;

  @ApiProperty(METHOD)
  @IsIn(COUNTER_PAYMENT_METHODS)
  paidMethod: CounterPaymentMethod;

  @ApiPropertyOptional({ minLength: 1, maxLength: 60 })
  @IfPresent()
  @NameField(1, 60)
  paidReference?: string;

  /** Writes the `salary_advance_cash` expense in the same transaction (R215). */
  @ApiProperty()
  @IsBoolean()
  recordAsExpense: boolean;
}

// ------------------------------------------------------------------------------ payroll runs

export class SkippedStaffDto {
  @ApiProperty(ID)
  staffId: string;

  @ApiProperty()
  name: string;

  /** `suspended`, `no_salary_structure` or `not_employed` (a kept payslip with nothing computed). */
  @ApiProperty()
  reason: string;
}

export class PayrollRunDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(MONTH)
  yearMonth: string;

  @ApiProperty({ type: Number, minimum: 0, maximum: 31 })
  workingDays: number;

  @ApiProperty({ enum: PAYROLL_RUN_STATUSES, enumName: 'PayrollRunStatus' })
  status: PayrollRunStatus;

  @ApiProperty(DATE_TIME)
  preparedAt: Date;

  /** Null when the pay-day job prepared it. */
  @ApiProperty(NULLABLE_ID)
  preparedByUserId: string | null;

  @ApiProperty(NULLABLE_ID)
  finalisedByUserId: string | null;

  @ApiProperty(NULLABLE_DATE_TIME)
  finalisedAt: Date | null;

  @ApiProperty(NULLABLE_TEXT)
  finaliseReason: string | null;

  @ApiProperty()
  staffCount: number;

  @ApiProperty({ type: [SkippedStaffDto] })
  skipped: SkippedStaffDto[];

  @ApiProperty(RUPEES)
  totalNet: number;

  @ApiProperty()
  unmarkedDaysTotal: number;
}

export class PrepareRunDto {
  /** The previous month or earlier; the current month from its last working day. */
  @ApiProperty(MONTH)
  @IsYearMonth()
  yearMonth: string;
}

/** A correction slip for someone the draft does not pay (R216). */
export class AddPayslipDto {
  @ApiProperty(ID)
  @IsIdString()
  staffId: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;
}

export class FinaliseRunDto {
  @ApiPropertyOptional({ minLength: 3, maxLength: 500 })
  @IfPresent()
  @Reason()
  reason?: string;
}

// ---------------------------------------------------------------------------------- payslips

export class PayslipLineDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty({ enum: PAYSLIP_LINE_KINDS, enumName: 'PayslipLineKind' })
  kind: PayslipLineKind;

  @ApiProperty()
  name: string;

  /** Whole rupees; signed only for an adjustment. */
  @ApiProperty({ type: Number, minimum: -MAX_RUPEES, maximum: MAX_RUPEES })
  amount: number;

  /** An adjustment correcting an earlier finalised payslip. */
  @ApiProperty(NULLABLE_ID)
  adjustsPayslipId: string | null;

  /** An adjustment's reason. */
  @ApiProperty(NULLABLE_TEXT)
  reason: string | null;
}

/** A named deduction the pay could not cover this month: listed, never carried (§3.3). */
export class DeductionNotTakenDto {
  @ApiProperty()
  name: string;

  @ApiProperty(RUPEES)
  amount: number;
}

/** The attendance days behind the counts, for a draft run's review. */
export class PayslipDaysDto {
  @ApiProperty({ type: [String], format: 'date' })
  unpaid: string[];

  @ApiProperty({ type: [String], format: 'date' })
  unmarked: string[];

  /** `on_leave` marks with no approved leave: unpaid until leave is approved (R245). */
  @ApiProperty({ type: [String], format: 'date' })
  unapprovedLeave: string[];
}

export class PayslipDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(ID)
  runId: string;

  @ApiProperty(MONTH)
  yearMonth: string;

  @ApiProperty({ enum: PAYROLL_RUN_STATUSES, enumName: 'PayrollRunStatus' })
  runStatus: PayrollRunStatus;

  @ApiProperty(ID)
  staffId: string;

  @ApiProperty()
  staffName: string;

  @ApiProperty(NULLABLE_TEXT)
  designation: string | null;

  @ApiProperty()
  workingDays: number;

  @ApiProperty()
  employedWorkingDays: number;

  /** Pro-rated (R246). */
  @ApiProperty(RUPEES)
  basic: number;

  @ApiProperty({ type: [PayslipLineDto] })
  lines: PayslipLineDto[];

  @ApiProperty(RUPEES)
  allowancesTotal: number;

  @ApiProperty(RUPEES)
  deductionsTotal: number;

  @ApiProperty({ type: [DeductionNotTakenDto] })
  deductionsNotTaken: DeductionNotTakenDto[];

  @ApiProperty()
  unpaidDays: number;

  @ApiProperty()
  unmarkedDays: number;

  @ApiProperty(RUPEES)
  absenceDeduction: number;

  @ApiProperty(RUPEES)
  advanceRecovery: number;

  /** Signed. */
  @ApiProperty({ type: Number, minimum: -MAX_RUPEES, maximum: MAX_RUPEES })
  adjustmentTotal: number;

  @ApiProperty(RUPEES)
  net: number;

  @ApiProperty({ enum: PAYSLIP_STATUSES, enumName: 'PayslipStatus' })
  status: PayslipStatus;

  @ApiProperty(NULLABLE_DATE)
  paidOn: string | null;

  @ApiProperty({ ...METHOD, nullable: true })
  paidMethod: CounterPaymentMethod | null;

  @ApiProperty(NULLABLE_TEXT)
  paidReference: string | null;

  /** A draft run's review only (payroll.view): the days behind the counts. Null otherwise. */
  @ApiProperty({ type: PayslipDaysDto, nullable: true })
  days: PayslipDaysDto | null;
}

export class AdjustPayslipDto {
  /** Signed, never 0. */
  @ApiProperty({ type: Number, minimum: -MAX_RUPEES, maximum: MAX_RUPEES, description: 'Whole rupees, signed, not 0' })
  @IsInt()
  @Min(-MAX_RUPEES)
  @Max(MAX_RUPEES)
  @NotEquals(0)
  amount: number;

  @ApiProperty({ minLength: 1, maxLength: 60 })
  @NameField(1, 60)
  name: string;

  /** An earlier payslip of the same staff member, in a finalised run, that this corrects. */
  @ApiPropertyOptional(ID)
  @IfPresent()
  @IsIdString()
  adjustsPayslipId?: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;
}

export class MarkPayslipPaidDto {
  /** No later than today. */
  @ApiProperty(DATE)
  @IsCalendarDate()
  paidOn: string;

  @ApiProperty(METHOD)
  @IsIn(COUNTER_PAYMENT_METHODS)
  paidMethod: CounterPaymentMethod;

  @ApiPropertyOptional({ minLength: 1, maxLength: 60 })
  @IfPresent()
  @NameField(1, 60)
  paidReference?: string;
}
