import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  LATE_COUNTS_AS,
  LEAVE_COUNTS_AS,
  MAX_FEE_DUE_DAY,
  MESSAGE_TYPES,
  MIN_FEE_DUE_DAY,
  REMARK_VISIBILITIES,
  SMS_ELIGIBLE_TYPES,
  type LateCountsAs,
  type LeaveCountsAs,
  type MessageType,
  type RemarkVisibility,
} from '@asms/shared';
import { IfPresent, IfPresentNotNull } from '../../common/fields';

// contracts/slice-2.md §6 and contracts/slice-9.md §4.

/** `HH:MM`, 24-hour, school-local time. */
export const LOCAL_TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export const PERIODS_PER_DAY = { min: 1, max: 12 } as const;
export const AMEND_WINDOW_DAYS = { min: 0, max: 30 } as const;

const TIME = { type: String, pattern: LOCAL_TIME_PATTERN.source, example: '09:30' } as const;
const LATE = { enum: LATE_COUNTS_AS, enumName: 'LateCountsAs' } as const;
const LEAVE = { enum: LEAVE_COUNTS_AS, enumName: 'LeaveCountsAs' } as const;
const REMARK = { enum: REMARK_VISIBILITIES, enumName: 'RemarkVisibility' } as const;
const SMS_TYPES = { enum: MESSAGE_TYPES, enumName: 'MessageType', isArray: true } as const;
const OFF_DAYS = {
  type: Number,
  isArray: true,
  minimum: 0,
  maximum: 6,
  maxItems: 6,
  description: 'Weekly off days, 0 = Sunday ... 6 = Saturday; distinct, not all seven; ascending.',
} as const;

export class SchoolSettingsDto {
  @ApiProperty({ type: Number, minimum: MIN_FEE_DUE_DAY, maximum: MAX_FEE_DUE_DAY })
  feeDueDay: number;

  @ApiProperty()
  studentLoginEnabled: boolean;

  @ApiProperty({ type: Number, minimum: PERIODS_PER_DAY.min, maximum: PERIODS_PER_DAY.max })
  periodsPerDay: number;

  @ApiProperty(OFF_DAYS)
  weeklyOffDays: number[];

  @ApiProperty({ type: Number, minimum: AMEND_WINDOW_DAYS.min, maximum: AMEND_WINDOW_DAYS.max })
  attendanceAmendWindowDays: number;

  @ApiProperty(TIME)
  registerDeadlineTime: string;

  @ApiProperty(TIME)
  absenceAlertTime: string;

  @ApiProperty()
  lateAdviceEnabled: boolean;

  @ApiProperty(LATE)
  lateCountsAs: LateCountsAs;

  @ApiProperty({ ...TIME, nullable: true })
  lateCutoffTime: string | null;

  @ApiProperty(LEAVE)
  leaveCountsAs: LeaveCountsAs;

  /** Set by the platform; read-only here (owner's item 18). */
  @ApiProperty({ type: Number, minimum: 0, readOnly: true })
  smsMonthlyCap: number;

  /** SMS-eligible types the school allows to reach SMS (register item 22), in table order. */
  @ApiProperty(SMS_TYPES)
  smsAllowedTypes: MessageType[];

  @ApiProperty(REMARK)
  remarkDefaultVisibility: RemarkVisibility;

  @ApiProperty()
  remarkNotifyGuardians: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

/**
 * Absent = unchanged; `null` is 422 on every field but lateCutoffTime (which null clears). An
 * empty body changes nothing. smsMonthlyCap is not declared, so sending it is 422 UNKNOWN_FIELD.
 */
export class UpdateSchoolSettingsDto {
  @ApiPropertyOptional({ type: Number, minimum: MIN_FEE_DUE_DAY, maximum: MAX_FEE_DUE_DAY })
  @IfPresent()
  @IsInt()
  @Min(MIN_FEE_DUE_DAY)
  @Max(MAX_FEE_DUE_DAY)
  feeDueDay?: number;

  @ApiPropertyOptional()
  @IfPresent()
  @IsBoolean()
  studentLoginEnabled?: boolean;

  @ApiPropertyOptional({ type: Number, minimum: PERIODS_PER_DAY.min, maximum: PERIODS_PER_DAY.max })
  @IfPresent()
  @IsInt()
  @Min(PERIODS_PER_DAY.min)
  @Max(PERIODS_PER_DAY.max)
  periodsPerDay?: number;

  @ApiPropertyOptional(OFF_DAYS)
  @IfPresent()
  @IsArray()
  @ArrayMaxSize(6, { message: 'weeklyOffDays cannot hold all seven days' })
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  weeklyOffDays?: number[];

  @ApiPropertyOptional({ type: Number, minimum: AMEND_WINDOW_DAYS.min, maximum: AMEND_WINDOW_DAYS.max })
  @IfPresent()
  @IsInt()
  @Min(AMEND_WINDOW_DAYS.min)
  @Max(AMEND_WINDOW_DAYS.max)
  attendanceAmendWindowDays?: number;

  @ApiPropertyOptional(TIME)
  @IfPresent()
  @IsString()
  @Matches(LOCAL_TIME_PATTERN, { message: 'registerDeadlineTime must be HH:MM' })
  registerDeadlineTime?: string;

  @ApiPropertyOptional(TIME)
  @IfPresent()
  @IsString()
  @Matches(LOCAL_TIME_PATTERN, { message: 'absenceAlertTime must be HH:MM' })
  absenceAlertTime?: string;

  @ApiPropertyOptional()
  @IfPresent()
  @IsBoolean()
  lateAdviceEnabled?: boolean;

  @ApiPropertyOptional(LATE)
  @IfPresent()
  @IsIn(LATE_COUNTS_AS)
  lateCountsAs?: LateCountsAs;

  /** Null clears it; required (non-null) while lateCountsAs is absent_after_cutoff. */
  @ApiPropertyOptional({ ...TIME, nullable: true })
  @IfPresentNotNull()
  @IsString()
  @Matches(LOCAL_TIME_PATTERN, { message: 'lateCutoffTime must be HH:MM' })
  lateCutoffTime?: string | null;

  @ApiPropertyOptional(LEAVE)
  @IfPresent()
  @IsIn(LEAVE_COUNTS_AS)
  leaveCountsAs?: LeaveCountsAs;

  @ApiPropertyOptional({ ...SMS_TYPES, description: 'SMS-eligible types only (contracts/slice-9.md §7.2).' })
  @IfPresent()
  @IsArray()
  @ArrayUnique()
  @IsIn(SMS_ELIGIBLE_TYPES, {
    each: true,
    message: 'smsAllowedTypes may only hold SMS-eligible message types',
  })
  smsAllowedTypes?: MessageType[];

  @ApiPropertyOptional(REMARK)
  @IfPresent()
  @IsIn(REMARK_VISIBILITIES)
  remarkDefaultVisibility?: RemarkVisibility;

  @ApiPropertyOptional()
  @IfPresent()
  @IsBoolean()
  remarkNotifyGuardians?: boolean;
}
