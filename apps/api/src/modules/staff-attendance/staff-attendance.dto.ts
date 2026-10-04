import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import {
  MARK_OUTCOMES,
  STAFF_ATTENDANCE_STATUSES,
  STAFF_STATUSES,
  type MarkOutcome,
  type StaffAttendanceStatus,
  type StaffStatus,
} from '@asms/shared';
import {
  IfPresent,
  IfPresentNotNull,
  IsCalendarDate,
  NoIdentityNumber,
  NoticeTextField,
  SearchField,
} from '../../common/fields';
import { ID_PATTERN, IsIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';

// contracts/slice-12.md §2, §4. Dates are YYYY-MM-DD calendar dates in the school's time zone.

const ID = { type: String, pattern: ID_PATTERN.source } as const;
const DATE = { type: String, format: 'date' } as const;
const DATE_TIME = { type: String, format: 'date-time' } as const;
const STATUS = { enum: STAFF_ATTENDANCE_STATUSES, enumName: 'StaffAttendanceStatus' } as const;
const NULLABLE_STRING = { type: String, nullable: true } as const;


// ------------------------------------------------------------------------------------ responses

export class StaffMarkDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(ID)
  staffId: string;

  @ApiProperty(DATE)
  date: string;

  @ApiProperty(STATUS)
  status: StaffAttendanceStatus;

  @ApiProperty({ ...NULLABLE_STRING, maxLength: 200 })
  note: string | null;

  @ApiProperty({ ...ID, description: 'The first writer (frozen)' })
  markedBy: string;

  @ApiProperty({ ...NULLABLE_STRING, description: 'The first writer’s staff name' })
  markedByName: string | null;

  @ApiProperty(DATE_TIME)
  markedAt: Date;

  @ApiProperty({ description: 'A staff_attendance_changes row exists' })
  amended: boolean;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  lastAmendedAt: Date | null;

  @ApiProperty(NULLABLE_STRING)
  lastAmendedByName: string | null;
}

export class StaffSubmitMarkResultDto extends StaffMarkDto {
  @ApiProperty({ enum: MARK_OUTCOMES, enumName: 'MarkOutcome' })
  outcome: MarkOutcome;
}

export class StaffDayDto {
  @ApiProperty(ID)
  staffId: string;

  @ApiProperty()
  fullName: string;

  @ApiProperty(NULLABLE_STRING)
  designation: string | null;

  @ApiProperty({
    enum: STAFF_STATUSES,
    enumName: 'StaffStatus',
    description: '`active`, or the current status of a member marked that day who is no longer active',
  })
  staffStatus: StaffStatus;

  @ApiProperty({ type: StaffMarkDto, nullable: true })
  mark: StaffMarkDto | null;
}

export class StaffDaySummaryDto {
  @ApiProperty({ description: 'Staff markable on the date: active now, joined on or before it' })
  staff: number;

  @ApiProperty({ description: 'Marks recorded for the date' })
  marked: number;

  @ApiProperty()
  present: number;

  @ApiProperty()
  absent: number;

  @ApiProperty()
  late: number;

  @ApiProperty()
  onLeave: number;
}

export class StaffSubmitResultDto {
  @ApiProperty(DATE)
  date: string;

  @ApiProperty({ description: 'Always true on success' })
  workingDay: boolean;

  @ApiProperty({ type: StaffSubmitMarkResultDto, isArray: true, description: 'In request order' })
  marks: StaffSubmitMarkResultDto[];

  @ApiProperty({ type: StaffDaySummaryDto })
  summary: StaffDaySummaryDto;
}

export class StaffAttendanceDayDto {
  @ApiProperty(DATE)
  date: string;

  @ApiProperty({ description: 'A staff working day as the calendar says now (R136)' })
  workingDay: boolean;

  @ApiProperty({ description: 'On or after joined_on and, when set, on or before left_on' })
  employed: boolean;

  @ApiProperty({ ...STATUS, nullable: true })
  status: StaffAttendanceStatus | null;

  @ApiProperty(NULLABLE_STRING)
  note: string | null;

  @ApiProperty(NULLABLE_STRING)
  markedByName: string | null;

  @ApiProperty()
  amended: boolean;
}

/** R135, decision 6: the member's own history carries no office note and no marker. */
export class MyStaffAttendanceDayDto extends OmitType(StaffAttendanceDayDto, [
  'note',
  'markedByName',
] as const) {}

class StaffAttendanceTotalsDto {
  @ApiProperty(ID)
  staffId: string;

  @ApiProperty(DATE)
  dateFrom: string;

  @ApiProperty(DATE)
  dateTo: string;

  @ApiProperty({ description: 'Staff working days in the range while employed' })
  workingDays: number;

  @ApiProperty({ description: 'Marks on working days' })
  present: number;

  @ApiProperty()
  absent: number;

  @ApiProperty()
  late: number;

  @ApiProperty()
  onLeave: number;

  @ApiProperty({ description: 'workingDays − marked working days, never below 0' })
  unrecorded: number;
}

export class StaffAttendanceDto extends StaffAttendanceTotalsDto {
  @ApiProperty({ type: StaffAttendanceDayDto, isArray: true, description: 'One per date, ascending' })
  days: StaffAttendanceDayDto[];
}

export class MyStaffAttendanceDto extends StaffAttendanceTotalsDto {
  @ApiProperty({ type: MyStaffAttendanceDayDto, isArray: true, description: 'One per date, ascending' })
  days: MyStaffAttendanceDayDto[];
}

// ------------------------------------------------------------------------------------- requests

export const STAFF_DAY_SORTS = ['fullName', '-fullName', 'status'] as const;
export type StaffDaySortParam = (typeof STAFF_DAY_SORTS)[number];

const STATUS_FILTERS = [...STAFF_ATTENDANCE_STATUSES, 'unrecorded'] as const;

export class StaffDayQueryDto extends PageQueryDto {
  @ApiProperty({ ...DATE, description: 'Not after today' })
  @IsCalendarDate()
  date: string;

  @ApiPropertyOptional({ enum: STATUS_FILTERS, enumName: 'StaffDayStatusFilter' })
  @IsOptional()
  @IsIn(STATUS_FILTERS)
  status?: StaffAttendanceStatus | 'unrecorded';

  @SearchField('Full name contains', 100)
  @NoIdentityNumber({ ignoreSeparators: true, message: '$property must not contain a CNIC' })
  q?: string;

  @ApiPropertyOptional({ enum: STAFF_DAY_SORTS, enumName: 'StaffDaySort', default: 'fullName' })
  @IsOptional()
  @IsIn(STAFF_DAY_SORTS)
  sort?: StaffDaySortParam;
}

export class StaffSubmitMarkDto {
  @ApiProperty(ID)
  @IsIdString()
  staffId: string;

  @ApiProperty(STATUS)
  @IsIn(STAFF_ATTENDANCE_STATUSES)
  status: StaffAttendanceStatus;

  @ApiPropertyOptional({ minLength: 1, maxLength: 200, description: 'Absent: no note' })
  @IfPresent()
  @NoticeTextField(1, 200)
  note?: string;
}

export class StaffSubmitDto {
  @ApiProperty({ ...DATE, description: 'A staff working day within the last 366 days' })
  @IsCalendarDate()
  date: string;

  @ApiPropertyOptional({ minLength: 3, maxLength: 500, description: 'Required when any mark is an amendment' })
  @IfPresent()
  @NoticeTextField(3, 500)
  reason?: string;

  @ApiProperty({ type: [StaffSubmitMarkDto], minItems: 1, maxItems: 500 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => StaffSubmitMarkDto)
  marks: StaffSubmitMarkDto[];
}

export class StaffAmendDto {
  @ApiProperty({ ...STATUS, description: 'The status the client last saw' })
  @IsIn(STAFF_ATTENDANCE_STATUSES)
  fromStatus: StaffAttendanceStatus;

  @ApiProperty(STATUS)
  @IsIn(STAFF_ATTENDANCE_STATUSES)
  status: StaffAttendanceStatus;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @NoticeTextField(3, 500)
  reason: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    minLength: 1,
    maxLength: 200,
    description: 'Absent: unchanged; null clears',
  })
  @IfPresentNotNull()
  @NoticeTextField(1, 200)
  note?: string | null;
}
