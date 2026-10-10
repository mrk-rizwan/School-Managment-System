import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min, ValidateNested } from 'class-validator';
import {
  LEAVE_CODES,
  LEAVE_STATUSES,
  LEAVE_TYPE_STATUSES,
  type LeaveCode,
  type LeaveStatus,
  type LeaveTypeStatus,
} from '@asms/shared';
import { IfPresent, IsCalendarDate, NameField, Reason } from '../../common/fields';
import { IsIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';

// phase-3-financial.md slice 24 (R209-R212, R248, R253); contracts/slice-24.md.

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;
const DATE = { type: String, format: 'date', example: '2026-10-06' } as const;
const CODE = { enum: LEAVE_CODES, enumName: 'LeaveCode' } as const;
const STATUS = { enum: LEAVE_STATUSES, enumName: 'LeaveStatus' } as const;

// ------------------------------------------------------------------------------- leave types

export class LeaveTypeDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty(CODE)
  code: LeaveCode;

  /** Null: no yearly limit. */
  @ApiProperty({ type: Number, nullable: true, minimum: 1, maximum: 366 })
  daysPerYear: number | null;

  @ApiProperty()
  paid: boolean;

  @ApiProperty({ enum: LEAVE_TYPE_STATUSES, enumName: 'LeaveTypeStatus' })
  status: LeaveTypeStatus;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  archivedAt: Date | null;

  /** One of the three the school started with. */
  @ApiProperty()
  seeded: boolean;
}

export class ListLeaveTypesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: LEAVE_TYPE_STATUSES, enumName: 'LeaveTypeStatus' })
  @IsOptional()
  @IsIn(LEAVE_TYPE_STATUSES)
  status?: LeaveTypeStatus;
}

/** An `unpaid` type is never paid (422). Left out, `daysPerYear` means no yearly limit. */
export class CreateLeaveTypeDto {
  @ApiProperty({ minLength: 1, maxLength: 40 })
  @NameField(1, 40)
  name: string;

  @ApiProperty(CODE)
  @IsIn(LEAVE_CODES)
  code: LeaveCode;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 366 })
  @IfPresent()
  @IsInt()
  @Min(1)
  @Max(366)
  daysPerYear?: number;

  @ApiProperty()
  @IsBoolean()
  paid: boolean;
}

// ---------------------------------------------------------------------------- leave balance

export class LeaveBalanceQueryDto {
  @ApiPropertyOptional({ type: Number, minimum: 2000, maximum: 2100, description: 'Calendar year; default this year' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^[0-9]{4}$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;
}

export class LeaveBalanceTypeDto {
  @ApiProperty(ID)
  leaveTypeId: string;

  @ApiProperty()
  name: string;

  @ApiProperty(CODE)
  code: LeaveCode;

  @ApiProperty()
  paid: boolean;

  /** Pro-rated by the months employed (R209); null: no limit. */
  @ApiProperty({ type: Number, nullable: true })
  entitlement: number | null;

  /** Working days of approved (and ended-early, as taken) leave in the year. */
  @ApiProperty({ type: Number })
  used: number;

  /** Working days of pending requests in the year. */
  @ApiProperty({ type: Number })
  pending: number;

  /** entitlement − used; null: no limit. */
  @ApiProperty({ type: Number, nullable: true })
  balance: number | null;
}

/** Bounded: one row per live leave type. */
export class LeaveBalanceDto {
  @ApiProperty({ type: Number })
  year: number;

  @ApiProperty({ type: () => LeaveBalanceTypeDto, isArray: true })
  types: LeaveBalanceTypeDto[];
}

// --------------------------------------------------------------------------- leave requests

export class LeaveRequestTypeDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty(CODE)
  code: LeaveCode;

  @ApiProperty()
  paid: boolean;
}

export class SectionNeedingCoverDto {
  @ApiProperty(ID)
  sectionId: string;

  @ApiProperty(ID)
  classId: string;

  /** `<class> <section>`. */
  @ApiProperty()
  name: string;
}

/** Phase 5 R307 (contracts/slice-37.md §3.4): one timetabled period of the leave. */
export class PeriodNeedingCoverDto {
  @ApiProperty(DATE)
  date: string;

  @ApiProperty({ type: Number, minimum: 1, maximum: 12 })
  period: number;

  @ApiProperty(ID)
  sectionId: string;

  /** `<class> <section>`. */
  @ApiProperty()
  sectionName: string;

  @ApiProperty()
  subjectName: string;
}

export class LeaveRequestDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(ID)
  staffId: string;

  @ApiProperty()
  staffName: string;

  @ApiProperty({ type: () => LeaveRequestTypeDto })
  leaveType: LeaveRequestTypeDto;

  @ApiProperty(DATE)
  startsOn: string;

  @ApiProperty(DATE)
  endsOn: string;

  /** The last day taken, when ended early (R248). */
  @ApiProperty({ ...DATE, nullable: true })
  endedEarlyOn: string | null;

  /** Frozen at request (R209). */
  @ApiProperty({ type: Number })
  workingDays: number;

  @ApiProperty()
  reason: string;

  @ApiProperty(STATUS)
  status: LeaveStatus;

  @ApiProperty(ID)
  requestedByUserId: string;

  @ApiProperty({ type: String, format: 'date-time' })
  requestedAt: Date;

  /** Recorded by an approver for the staff member (R210). */
  @ApiProperty()
  onBehalf: boolean;

  @ApiProperty({ ...ID, nullable: true })
  decidedByUserId: string | null;

  @ApiProperty({ type: String, nullable: true })
  decidedByName: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;

  @ApiProperty({ type: String, nullable: true })
  decisionReason: string | null;

  /** The sole principal's own leave, approved by themselves (R253). */
  @ApiProperty()
  selfApproved: boolean;

  /** The cover created on approval (R212). */
  @ApiProperty({ ...ID, nullable: true })
  coverAssignmentId: string | null;

  /**
   * The cover's last day once the request was cancelled or ended early (R248); null when there
   * was no cover or it was voided before it began. An end early dated in the past ends the cover
   * yesterday, not on that date (slice 10 refuses a past last day), so this can differ from
   * endedEarlyOn.
   */
  @ApiProperty({ ...DATE, nullable: true })
  coverEndedOn: string | null;

  /**
   * The sections the staff member is class teacher of during the leave that no cover from this
   * request covers; empty once the request is no longer pending or approved.
   */
  @ApiProperty({ type: () => SectionNeedingCoverDto, isArray: true })
  sectionsNeedingCover: SectionNeedingCoverDto[];

  /**
   * Phase 5 R307: the staff member's timetabled periods on each teaching day of the leave (to the
   * day ended early), from the version live that day, less those a live substitution already
   * takes; date then period order. Empty once the request is no longer pending or approved.
   */
  @ApiProperty({ type: () => PeriodNeedingCoverDto, isArray: true })
  periodsNeedingCover: PeriodNeedingCoverDto[];

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;

  @ApiProperty({ type: String, nullable: true })
  cancelReason: string | null;
}

/** GET /staff/:id/leave-requests (staff.view): without the reasons, which can be medical. */
export class StaffLeaveRequestDto extends OmitType(LeaveRequestDto, ['reason', 'decisionReason'] as const) {}

export const LEAVE_REQUEST_SORTS = ['-requestedAt', 'startsOn'] as const;
export type LeaveRequestSortValue = (typeof LEAVE_REQUEST_SORTS)[number];

export class ListMyLeaveRequestsQueryDto extends PageQueryDto {
  @ApiPropertyOptional(STATUS)
  @IsOptional()
  @IsIn(LEAVE_STATUSES)
  status?: LeaveStatus;
}

export class ListLeaveRequestsQueryDto extends ListMyLeaveRequestsQueryDto {
  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  staffId?: string;

  @ApiPropertyOptional(DATE)
  @IsOptional()
  @IsCalendarDate()
  startsFrom?: string;

  @ApiPropertyOptional(DATE)
  @IsOptional()
  @IsCalendarDate()
  startsTo?: string;

  @ApiPropertyOptional({ enum: LEAVE_REQUEST_SORTS, enumName: 'LeaveRequestSort', default: '-requestedAt' })
  @IsOptional()
  @IsIn(LEAVE_REQUEST_SORTS)
  sort?: LeaveRequestSortValue;
}

/** startsOn ≥ today − 7; endsOn on or after startsOn, at most 60 days in all. */
export class CreateMyLeaveRequestDto {
  @ApiProperty(ID)
  @IsIdString()
  leaveTypeId: string;

  @ApiProperty(DATE)
  @IsCalendarDate()
  startsOn: string;

  @ApiProperty(DATE)
  @IsCalendarDate()
  endsOn: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;
}

/** Recorded by an approver for another staff member; still `pending` (R210). */
export class CreateLeaveRequestDto extends CreateMyLeaveRequestDto {
  @ApiProperty(ID)
  @IsIdString()
  staffId: string;
}

export class LeaveCoverDto {
  /** A section the staff member is class teacher of during the leave (`sectionsNeedingCover`). */
  @ApiProperty(ID)
  @IsIdString()
  sectionId: string;

  @ApiProperty(ID)
  @IsIdString()
  coverStaffId: string;
}

export class ApproveLeaveRequestDto {
  @ApiPropertyOptional({ minLength: 3, maxLength: 500 })
  @IfPresent()
  @Reason()
  reason?: string;

  /** Creates the slice-10 cover assignment in the same transaction (R212, R132). */
  @ApiPropertyOptional({ type: () => LeaveCoverDto })
  @IfPresent()
  @ValidateNested()
  @Type(() => LeaveCoverDto)
  cover?: LeaveCoverDto;
}

export class EndLeaveEarlyDto {
  /** The last day of leave taken: on or after startsOn, before endsOn. */
  @ApiProperty(DATE)
  @IsCalendarDate()
  endedOn: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;
}
