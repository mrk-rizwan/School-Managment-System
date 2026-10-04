import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  ATTENDANCE_ALERT_CANCEL_REASONS,
  ATTENDANCE_ALERT_STATUSES,
  ATTENDANCE_MODES,
  ATTENDANCE_STATUSES,
  DAY_STATUSES,
  MARK_OUTCOMES,
  REGISTER_SOURCES,
  TIME_OF_DAY,
  type AttendanceAlertCancelReason,
  type AttendanceAlertStatus,
  type AttendanceMode,
  type AttendanceStatus,
  type DayStatus,
  type MarkOutcome,
  type RegisterSource,
} from '@asms/shared';
import {
  IfPresent,
  IfPresentNotNull,
  IsCalendarDate,
  NoticeTextField,
  QueryBoolean,
} from '../../common/fields';
import { ID_PATTERN, IsIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';

// contracts/slice-11.md §2, §4, §10. Dates are YYYY-MM-DD calendar dates and times HH:MM, both in
// the school's time zone. Notes appear on staff routes only; StudentAttendanceDto carries none
// (R165).

const ID = { type: String, pattern: ID_PATTERN.source } as const;
const NULLABLE_ID = { ...ID, nullable: true } as const;
const DATE = { type: String, format: 'date' } as const;
const DATE_TIME = { type: String, format: 'date-time' } as const;
const NULLABLE_DATE_TIME = { ...DATE_TIME, nullable: true } as const;
const TIME = { type: String, pattern: TIME_OF_DAY.source, description: 'HH:MM, school time' } as const;
const NULLABLE_TIME = { ...TIME, nullable: true } as const;
const MODE = { enum: ATTENDANCE_MODES, enumName: 'AttendanceMode' } as const;
const STATUS = { enum: ATTENDANCE_STATUSES, enumName: 'AttendanceStatus' } as const;
const DAY_STATUS = { enum: DAY_STATUSES, enumName: 'DayStatus' } as const;
const ALERT_STATUS = { enum: ATTENDANCE_ALERT_STATUSES, enumName: 'AttendanceAlertStatus' } as const;
const CANCEL_REASON = {
  enum: ATTENDANCE_ALERT_CANCEL_REASONS,
  enumName: 'AttendanceAlertCancelReason',
} as const;

/** A query-string integer: plain decimal digits only, else left for IsInt to refuse. */
const QueryInt = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^[0-9]{1,3}$/.test(value) ? Number(value) : value,
  );

/** `HH:MM`, 00:00-23:59. */
const IsTimeOfDay = (): PropertyDecorator =>
  Matches(TIME_OF_DAY, { message: '$property must be a time of day HH:MM' });

// ------------------------------------------------------------------------------------ responses

export class RegisterDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(ID) sectionId: string;
  @ApiProperty() sectionName: string;
  @ApiProperty(ID) classId: string;
  @ApiProperty() className: string;
  @ApiProperty(ID) academicYearId: string;
  @ApiProperty(DATE) date: string;
  @ApiProperty({ minimum: 1, maximum: 12 }) period: number;
  @ApiProperty({ ...MODE, description: 'Copied from the class at first submit, frozen' })
  mode: AttendanceMode;
  @ApiProperty({ description: 'isTeachingDay(date) now: false on a register later covered by a holiday (R167)' })
  teachingDay: boolean;
  @ApiProperty(ID) submittedBy: string;
  @ApiProperty({ type: String, nullable: true }) submittedByName: string | null;
  @ApiProperty(DATE_TIME) submittedAt: Date;
  @ApiProperty(NULLABLE_ID) lastAmendedBy: string | null;
  @ApiProperty({ type: String, nullable: true }) lastAmendedByName: string | null;
  @ApiProperty(NULLABLE_DATE_TIME) lastAmendedAt: Date | null;
  @ApiProperty({ enum: REGISTER_SOURCES, enumName: 'RegisterSource' }) source: RegisterSource;
}

export class AttendanceMarkDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(ID) registerId: string;
  @ApiProperty(ID) enrolmentId: string;
  @ApiProperty(ID) studentId: string;
  @ApiProperty(DATE) date: string;
  @ApiProperty({ minimum: 1, maximum: 12 }) period: number;
  @ApiProperty(STATUS) status: AttendanceStatus;
  @ApiProperty({ ...NULLABLE_TIME, description: 'Only ever set on a late mark' })
  arrivedAt: string | null;
  @ApiProperty({ type: String, nullable: true, maxLength: 200, description: 'Staff routes only' })
  note: string | null;
  @ApiProperty({ description: 'At least one change row exists' }) amended: boolean;
}

export class SubmittedMarkDto extends AttendanceMarkDto {
  @ApiProperty({ enum: MARK_OUTCOMES, enumName: 'MarkOutcome' }) outcome: MarkOutcome;
}

/** The child-day's alert state (§6): one shape for the roster and the reports. */
export class AlertSummaryDto {
  @ApiProperty({ ...ALERT_STATUS, nullable: true, description: 'The latest absence row' })
  absence: AttendanceAlertStatus | null;
  @ApiProperty({ ...CANCEL_REASON, nullable: true }) absenceCancelReason: AttendanceAlertCancelReason | null;
  @ApiProperty({ ...NULLABLE_DATE_TIME, description: 'While pending' }) absenceDueAt: Date | null;
  @ApiProperty({ ...NULLABLE_DATE_TIME, description: 'Once sent or cancelled' })
  absenceResolvedAt: Date | null;
  @ApiProperty({ ...ALERT_STATUS, nullable: true }) lateAdvice: AttendanceAlertStatus | null;
  @ApiProperty({ minimum: 0, maximum: 3 }) corrections: number;
  @ApiProperty({
    description:
      'A fourth absence or corrected notice was due for this child-day and refused (at most three are sent); false while fewer than four were due',
  })
  correctionsCapped: boolean;
}

export class RosterRowDto {
  @ApiProperty(ID) enrolmentId: string;
  @ApiProperty(ID) studentId: string;
  @ApiProperty() studentFullName: string;
  @ApiProperty({ type: Number, nullable: true }) rollNo: number | null;
  @ApiProperty({ description: 'False for a row kept only because it is already marked' })
  onRoster: boolean;
  @ApiProperty({ type: AttendanceMarkDto, nullable: true }) mark: AttendanceMarkDto | null;
  @ApiProperty({ type: AlertSummaryDto, nullable: true }) alert: AlertSummaryDto | null;
}

export class RegisterSectionDto {
  @ApiProperty(ID) id: string;
  @ApiProperty() name: string;
  @ApiProperty(ID) classId: string;
  @ApiProperty() className: string;
  @ApiProperty(ID) academicYearId: string;
  @ApiProperty(MODE) attendanceMode: AttendanceMode;
}

export const CALLER_ROLES = ['all', 'class_teacher', 'cover', 'subject_teacher', 'viewer'] as const;
export type CallerRole = (typeof CALLER_ROLES)[number];

export class RegisterViewDto {
  @ApiProperty({ type: RegisterSectionDto }) section: RegisterSectionDto;
  @ApiProperty(DATE) date: string;
  @ApiProperty({ minimum: 1, maximum: 12 }) period: number;
  @ApiProperty({ description: 'The setting now' }) periodsPerDay: number;
  @ApiProperty({ description: 'Now' }) teachingDay: boolean;
  @ApiProperty({ type: RegisterDto, nullable: true }) register: RegisterDto | null;
  @ApiProperty({ type: RosterRowDto, isArray: true }) roster: RosterRowDto[];
  @ApiProperty({ description: 'The write rule for this caller, ignoring the window' }) canSubmit: boolean;
  @ApiProperty({ description: 'canSubmit, on a teaching day, and (all scope or the window open)' })
  amendable: boolean;
  @ApiProperty({ enum: CALLER_ROLES, enumName: 'RegisterCallerRole' }) callerRole: CallerRole;
}

export class RegisterCountsDto {
  @ApiProperty() roster: number;
  @ApiProperty() marked: number;
  @ApiProperty() present: number;
  @ApiProperty() absent: number;
  @ApiProperty() late: number;
  @ApiProperty() onLeave: number;
}

export class SubmitAlertsDto {
  @ApiProperty() absencePending: number;
  @ApiProperty() absenceBackdated: number;
  @ApiProperty() lateAdvicePending: number;
  @ApiProperty() cancelled: number;
  @ApiProperty() corrections: number;
}

export class RegisterSubmitResultDto {
  @ApiProperty({ description: 'This request created the register' }) created: boolean;
  @ApiProperty({ type: RegisterDto }) register: RegisterDto;
  @ApiProperty({ type: SubmittedMarkDto, isArray: true, description: 'In request order' })
  marks: SubmittedMarkDto[];
  @ApiProperty({ type: RegisterCountsDto }) summary: RegisterCountsDto;
  @ApiProperty({ type: SubmitAlertsDto, description: 'Zeros on a replay' }) alerts: SubmitAlertsDto;
}

export class MarkChangeDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(ID) markId: string;
  @ApiProperty(STATUS) fromStatus: AttendanceStatus;
  @ApiProperty(STATUS) toStatus: AttendanceStatus;
  @ApiProperty() noteChanged: boolean;
  @ApiProperty(NULLABLE_TIME) fromArrivedAt: string | null;
  @ApiProperty(NULLABLE_TIME) toArrivedAt: string | null;
  @ApiProperty(ID) changedBy: string;
  @ApiProperty({ type: String, nullable: true }) changedByName: string | null;
  @ApiProperty(DATE_TIME) changedAt: Date;
  @ApiProperty() reason: string;
}

export class SectionDayDto {
  @ApiProperty(ID) sectionId: string;
  @ApiProperty() sectionName: string;
  @ApiProperty(ID) classId: string;
  @ApiProperty() className: string;
  @ApiProperty(ID) academicYearId: string;
  @ApiProperty(DATE) date: string;
  @ApiProperty({ ...MODE, description: "The class's now" }) mode: AttendanceMode;
  @ApiProperty() rosterCount: number;
  @ApiProperty({ description: '1 in daily mode, else periodsPerDay now' }) registersExpected: number;
  @ApiProperty({ description: 'Live count' }) registersRecorded: number;
  @ApiProperty() recorded: boolean;
  @ApiProperty(NULLABLE_ID) submittedBy: string | null;
  @ApiProperty({ type: String, nullable: true }) submittedByName: string | null;
  @ApiProperty(NULLABLE_DATE_TIME) submittedAt: Date | null;
  @ApiProperty({ ...NULLABLE_ID, description: "The class teacher's staff id (the console's links)" })
  classTeacherStaffId: string | null;
  @ApiProperty({ type: String, nullable: true }) classTeacherName: string | null;
  @ApiProperty({ ...ID, isArray: true, description: 'Every cover active on the date, by assignment' })
  coverStaffIds: string[];
  @ApiProperty({ type: String, nullable: true, description: 'The first cover (by assignment)' })
  coverStaffName: string | null;
  @ApiProperty({ description: 'Recorded on a day later declared a holiday (R167)' })
  declaredHolidayAfter: boolean;
}

export class DailySummaryDto {
  @ApiProperty(ID) sectionId: string;
  @ApiProperty() sectionName: string;
  @ApiProperty(ID) classId: string;
  @ApiProperty() className: string;
  @ApiProperty(DATE) date: string;
  @ApiProperty(MODE) mode: AttendanceMode;
  @ApiProperty({ description: 'Frozen at first computation; 0 until then' }) registersExpected: number;
  @ApiProperty() registersRecorded: number;
  @ApiProperty() rosterCount: number;
  @ApiProperty() present: number;
  @ApiProperty() absent: number;
  @ApiProperty() late: number;
  @ApiProperty() onLeave: number;
  @ApiProperty() partial: number;
  @ApiProperty() unrecorded: number;
  @ApiProperty({ description: 'Now' }) teachingDay: boolean;
  @ApiProperty(NULLABLE_DATE_TIME) computedAt: Date | null;
  @ApiProperty({ description: 'A write is not yet rolled up' }) stale: boolean;
}

export class StudentDayPeriodDto {
  @ApiProperty({ minimum: 1, maximum: 12 }) period: number;
  @ApiProperty(STATUS) status: AttendanceStatus;
  @ApiProperty(NULLABLE_TIME) arrivedAt: string | null;
}

export class StudentDayDto {
  @ApiProperty(DATE) date: string;
  @ApiProperty() teachingDay: boolean;
  @ApiProperty({ description: 'An enrolment was in force' }) enrolled: boolean;
  @ApiProperty({ ...DAY_STATUS, nullable: true }) status: DayStatus | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Null when excluded or unrecorded' })
  value: number | null;
  @ApiProperty({ type: StudentDayPeriodDto, isArray: true }) periods: StudentDayPeriodDto[];
}

/** One shape on the staff route and both /me routes; no note, teacher or alert (R165). */
export class StudentAttendanceDto {
  @ApiProperty(ID) studentId: string;
  @ApiProperty(DATE) dateFrom: string;
  @ApiProperty(DATE) dateTo: string;
  @ApiProperty({ type: Number, nullable: true, description: 'One decimal; null when no recorded days' })
  percentage: number | null;
  @ApiProperty() countedDays: number;
  @ApiProperty() teachingDays: number;
  @ApiProperty() present: number;
  @ApiProperty() absent: number;
  @ApiProperty() late: number;
  @ApiProperty() onLeave: number;
  @ApiProperty() partial: number;
  @ApiProperty() excludedLeaveDays: number;
  @ApiProperty() unrecorded: number;
  @ApiProperty({ type: StudentDayDto, isArray: true }) days: StudentDayDto[];
}

export class AbsenteeRowDto {
  @ApiProperty(ID) studentId: string;
  @ApiProperty() fullName: string;
  @ApiProperty({ type: Number, nullable: true }) rollNo: number | null;
  @ApiProperty(ID) enrolmentId: string;
  @ApiProperty(ID) classId: string;
  @ApiProperty() className: string;
  @ApiProperty(ID) sectionId: string;
  @ApiProperty() sectionName: string;
  @ApiProperty(DAY_STATUS) status: DayStatus;
  @ApiProperty({ ...NULLABLE_TIME, description: "The first late period's" }) arrivedAt: string | null;
  @ApiProperty({ type: AlertSummaryDto, nullable: true }) alert: AlertSummaryDto | null;
}

export class PercentageRowDto {
  @ApiProperty(ID) studentId: string;
  @ApiProperty() fullName: string;
  @ApiProperty({ type: Number, nullable: true }) rollNo: number | null;
  @ApiProperty(NULLABLE_ID) classId: string | null;
  @ApiProperty({ type: String, nullable: true }) className: string | null;
  @ApiProperty(NULLABLE_ID) sectionId: string | null;
  @ApiProperty({ type: String, nullable: true }) sectionName: string | null;
  @ApiProperty({ type: Number, nullable: true }) percentage: number | null;
  @ApiProperty() countedDays: number;
  @ApiProperty() teachingDays: number;
}

// ------------------------------------------------------------------------------------- requests

export class RegisterQueryDto {
  @ApiProperty(DATE)
  @IsCalendarDate()
  date: string;

  @ApiProperty({ type: Number, minimum: 1, maximum: 12 })
  @QueryInt()
  @IsInt()
  @Min(1)
  @Max(12)
  period: number;
}

export class SubmitMarkDto {
  @ApiProperty(ID)
  @IsIdString()
  enrolmentId: string;

  @ApiProperty(STATUS)
  @IsIn(ATTENDANCE_STATUSES)
  status: AttendanceStatus;

  @ApiPropertyOptional({ minLength: 1, maxLength: 200, description: 'Absent: the mark has no note' })
  @IfPresent()
  @NoticeTextField(1, 200)
  note?: string;

  @ApiPropertyOptional({ ...TIME, description: 'Only with status late' })
  @IfPresent()
  @IsTimeOfDay()
  arrivedAt?: string;
}

export class SubmitRegisterDto {
  @ApiProperty(DATE)
  @IsCalendarDate()
  date: string;

  @ApiProperty({ type: Number, minimum: 1, maximum: 12 })
  @IsInt()
  @Min(1)
  @Max(12)
  period: number;

  @ApiPropertyOptional({ minLength: 3, maxLength: 500, description: 'Required when any mark is an amendment' })
  @IfPresent()
  @NoticeTextField(3, 500)
  reason?: string;

  @ApiProperty({ type: SubmitMarkDto, isArray: true, minItems: 1, maxItems: 200 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SubmitMarkDto)
  marks: SubmitMarkDto[];
}

/** PATCH semantics: note and arrivedAt absent = unchanged, null clears. */
export class AmendMarkDto {
  @ApiProperty({ ...STATUS, description: 'The status the client last saw' })
  @IsIn(ATTENDANCE_STATUSES)
  fromStatus: AttendanceStatus;

  @ApiProperty(STATUS)
  @IsIn(ATTENDANCE_STATUSES)
  status: AttendanceStatus;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @NoticeTextField(3, 500)
  reason: string;

  @ApiPropertyOptional({ type: String, nullable: true, minLength: 1, maxLength: 200 })
  @IfPresentNotNull()
  @NoticeTextField(1, 200)
  note?: string | null;

  @ApiPropertyOptional({ ...NULLABLE_TIME, description: 'A value requires status late' })
  @IfPresentNotNull()
  @IsTimeOfDay()
  arrivedAt?: string | null;
}

export class RecordArrivalDto {
  @ApiProperty(ID)
  @IsIdString()
  studentId: string;

  @ApiProperty({ ...DATE, description: 'Not in the future; the gate sends today' })
  @IsCalendarDate()
  date: string;

  @ApiProperty(TIME)
  @IsTimeOfDay()
  arrivedAt: string;
}

export const MARK_CHANGE_SORTS = ['-changedAt', 'changedAt'] as const;

export class MarkChangesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: MARK_CHANGE_SORTS, enumName: 'MarkChangeSort', default: '-changedAt' })
  @IsOptional()
  @IsIn(MARK_CHANGE_SORTS)
  sort?: (typeof MARK_CHANGE_SORTS)[number];
}

export const SECTION_DAY_SORTS = ['className', 'sectionName', '-registersRecorded'] as const;

export class ListRegistersQueryDto extends PageQueryDto {
  @ApiProperty({ ...DATE, description: 'Not in the future' })
  @IsCalendarDate()
  date: string;

  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  classId?: string;

  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  sectionId?: string;

  @QueryBoolean({ description: 'false: the unrecorded sections (the principal console)' })
  recorded?: boolean;

  @ApiPropertyOptional({ enum: SECTION_DAY_SORTS, enumName: 'SectionDaySort', default: 'className' })
  @IsOptional()
  @IsIn(SECTION_DAY_SORTS)
  sort?: (typeof SECTION_DAY_SORTS)[number];
}

export const DAILY_SUMMARY_SORTS = ['-date', 'date', 'className'] as const;

export class DailySummaryQueryDto extends PageQueryDto {
  @ApiProperty(DATE)
  @IsCalendarDate()
  dateFrom: string;

  @ApiProperty({ ...DATE, description: 'On or after dateFrom, at most 91 days after it' })
  @IsCalendarDate()
  dateTo: string;

  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  classId?: string;

  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  sectionId?: string;

  @ApiPropertyOptional({ enum: DAILY_SUMMARY_SORTS, enumName: 'DailySummarySort', default: '-date' })
  @IsOptional()
  @IsIn(DAILY_SUMMARY_SORTS)
  sort?: (typeof DAILY_SUMMARY_SORTS)[number];
}

export const DAY_LIST_SORTS = ['className', 'rollNo', 'fullName'] as const;
export const ABSENTEE_STATUSES = ['absent', 'partial', 'on_leave'] as const;

export class LateQueryDto extends PageQueryDto {
  @ApiProperty({ ...DATE, description: 'Not in the future' })
  @IsCalendarDate()
  date: string;

  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  classId?: string;

  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  sectionId?: string;

  @ApiPropertyOptional({ enum: DAY_LIST_SORTS, enumName: 'AttendanceDayListSort', default: 'className' })
  @IsOptional()
  @IsIn(DAY_LIST_SORTS)
  sort?: (typeof DAY_LIST_SORTS)[number];
}

export class AbsenteesQueryDto extends LateQueryDto {
  @ApiPropertyOptional({
    enum: ABSENTEE_STATUSES,
    enumName: 'AbsenteeStatus',
    description: 'Absent: all three',
  })
  @IsOptional()
  @IsIn(ABSENTEE_STATUSES)
  status?: (typeof ABSENTEE_STATUSES)[number];
}

export class StudentAttendanceQueryDto {
  @ApiProperty(DATE)
  @IsCalendarDate()
  dateFrom: string;

  @ApiProperty({ ...DATE, description: 'On or after dateFrom, at most 365 days after it' })
  @IsCalendarDate()
  dateTo: string;
}

export const PERCENTAGE_SORTS = ['percentage', '-percentage', 'fullName', 'className'] as const;

export class PercentageQueryDto extends PageQueryDto {
  @ApiProperty(DATE)
  @IsCalendarDate()
  dateFrom: string;

  @ApiProperty({ ...DATE, description: 'On or after dateFrom, at most 365 days after it' })
  @IsCalendarDate()
  dateTo: string;

  @ApiPropertyOptional({ ...ID, description: "The current active enrolment's" })
  @IsOptional()
  @IsIdString()
  classId?: string;

  @ApiPropertyOptional({ ...ID, description: "The current active enrolment's" })
  @IsOptional()
  @IsIdString()
  sectionId?: string;

  @ApiPropertyOptional({ type: Number, minimum: 0, maximum: 100, description: 'percentage < below' })
  @IsOptional()
  @QueryInt()
  @IsInt()
  @Min(0)
  @Max(100)
  below?: number;

  @ApiPropertyOptional({ enum: PERCENTAGE_SORTS, enumName: 'PercentageSort', default: 'percentage' })
  @IsOptional()
  @IsIn(PERCENTAGE_SORTS)
  sort?: (typeof PERCENTAGE_SORTS)[number];
}
