import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import {
  HOLIDAY_KINDS,
  HOLIDAY_STATUSES,
  type HolidayKind,
  type HolidayStatus,
} from '@asms/shared';
import {
  IfPresent,
  IfPresentNotNull,
  IsCalendarDate,
  NoticeTextField,
} from '../../common/fields';
import { ID_PATTERN } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';

// contracts/slice-10.md §2, §4, §5. Dates are YYYY-MM-DD calendar dates in the school's time zone.

const ID = { type: String, pattern: ID_PATTERN.source } as const;
const NULLABLE_ID = { ...ID, nullable: true } as const;
const DATE = { type: String, format: 'date' } as const;
const DATE_TIME = { type: String, format: 'date-time' } as const;
const KIND = { enum: HOLIDAY_KINDS, enumName: 'HolidayKind' } as const;
const STATUS = { enum: HOLIDAY_STATUSES, enumName: 'HolidayStatus' } as const;
const WEEKDAYS = {
  type: Number,
  isArray: true,
  description: 'Weekly-off days ascending, 0 = Sunday … 6 = Saturday',
};

// ------------------------------------------------------------------------------------ responses

export class HolidayDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(DATE)
  startsOn: string;

  @ApiProperty({ ...DATE, description: 'Equals startsOn for a single day' })
  endsOn: string;

  @ApiProperty({ minLength: 1, maxLength: 100 })
  name: string;

  @ApiProperty({ type: String, nullable: true })
  description: string | null;

  @ApiProperty({ ...KIND, description: 'Informational: both kinds count the same' })
  kind: HolidayKind;

  @ApiProperty({ description: 'False: a teaching holiday on which staff still work' })
  appliesToStaff: boolean;

  @ApiProperty(STATUS)
  status: HolidayStatus;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  publishedAt: Date | null;

  @ApiProperty(NULLABLE_ID)
  publishedBy: string | null;

  @ApiProperty({ type: String, nullable: true })
  publishedByName: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  cancelledAt: Date | null;

  @ApiProperty(NULLABLE_ID)
  cancelledBy: string | null;

  @ApiProperty({ type: String, nullable: true })
  cancelledByName: string | null;

  @ApiProperty({ type: String, nullable: true })
  cancelReason: string | null;

  @ApiProperty({ ...NULLABLE_ID, description: 'Always null until announcements (slice 14)' })
  announcementId: string | null;

  @ApiProperty(DATE_TIME)
  createdAt: Date;

  @ApiProperty(DATE_TIME)
  updatedAt: Date;
}

export class CalendarHolidayDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(DATE)
  startsOn: string;

  @ApiProperty(DATE)
  endsOn: string;

  @ApiProperty()
  name: string;

  @ApiProperty(KIND)
  kind: HolidayKind;

  @ApiProperty({ description: 'False: a teaching holiday on which staff still work' })
  appliesToStaff: boolean;
}

export class TeachingDaysDto {
  @ApiProperty(DATE)
  dateFrom: string;

  @ApiProperty(DATE)
  dateTo: string;

  @ApiProperty({ description: 'Informational for past ranges (R116): nothing stored depends on it' })
  teachingDays: number;

  @ApiProperty(WEEKDAYS)
  weeklyOffDays: number[];

  @ApiProperty({ type: CalendarHolidayDto, isArray: true, description: 'Published holidays overlapping the range' })
  holidays: CalendarHolidayDto[];
}

/** A published holiday as a guardian or student sees it: no id, description, actor or reason. */
export class MyCalendarHolidayDto {
  @ApiProperty(DATE)
  startsOn: string;

  @ApiProperty(DATE)
  endsOn: string;

  @ApiProperty()
  name: string;

  @ApiProperty(KIND)
  kind: HolidayKind;

  @ApiProperty({ description: 'False: a teaching holiday on which staff still work' })
  appliesToStaff: boolean;
}

export class MyCalendarDto {
  @ApiProperty(DATE)
  dateFrom: string;

  @ApiProperty(DATE)
  dateTo: string;

  @ApiProperty(WEEKDAYS)
  weeklyOffDays: number[];

  @ApiProperty({ type: MyCalendarHolidayDto, isArray: true })
  holidays: MyCalendarHolidayDto[];
}

// ------------------------------------------------------------------------------------- requests

export const HOLIDAY_SORTS = ['startsOn', '-startsOn'] as const;
export type HolidaySortParam = (typeof HOLIDAY_SORTS)[number];

export class ListHolidaysQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ ...DATE, description: 'Holidays overlapping the range (open-ended alone)' })
  @IsOptional()
  @IsCalendarDate()
  dateFrom?: string;

  @ApiPropertyOptional({ ...DATE, description: 'Not before dateFrom' })
  @IsOptional()
  @IsCalendarDate()
  dateTo?: string;

  @ApiPropertyOptional({ ...STATUS, description: 'draft without holiday.manage: an empty page' })
  @IsOptional()
  @IsIn(HOLIDAY_STATUSES)
  status?: HolidayStatus;

  @ApiPropertyOptional(KIND)
  @IsOptional()
  @IsIn(HOLIDAY_KINDS)
  kind?: HolidayKind;

  @ApiPropertyOptional({ enum: HOLIDAY_SORTS, enumName: 'HolidaySort', default: 'startsOn' })
  @IsOptional()
  @IsIn(HOLIDAY_SORTS)
  sort?: HolidaySortParam;
}

export class CreateHolidayDto {
  @ApiProperty({ ...DATE, description: 'Within today − 366 days … today + 731 days' })
  @IsCalendarDate()
  startsOn: string;

  @ApiPropertyOptional({ ...DATE, description: 'Default startsOn; at most 365 days after it' })
  @IfPresent()
  @IsCalendarDate()
  endsOn?: string;

  @ApiProperty({ minLength: 1, maxLength: 100 })
  @NoticeTextField(1, 100)
  name: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500, description: "'' and null store null" })
  @IfPresentNotNull()
  @NoticeTextField(0, 500)
  description?: string | null;

  @ApiProperty(KIND)
  @IsIn(HOLIDAY_KINDS)
  kind: HolidayKind;

  @ApiPropertyOptional({ type: Boolean, default: true })
  @IfPresent()
  @IsBoolean()
  appliesToStaff?: boolean;
}

/** Absent = unchanged; null only on description (clears). Date rules apply to the merged result. */
export class UpdateHolidayDto {
  @ApiPropertyOptional(DATE)
  @IfPresent()
  @IsCalendarDate()
  startsOn?: string;

  @ApiPropertyOptional(DATE)
  @IfPresent()
  @IsCalendarDate()
  endsOn?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @IfPresent()
  @NoticeTextField(1, 100)
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @IfPresentNotNull()
  @NoticeTextField(0, 500)
  description?: string | null;

  @ApiPropertyOptional(KIND)
  @IfPresent()
  @IsIn(HOLIDAY_KINDS)
  kind?: HolidayKind;

  @ApiPropertyOptional({ type: Boolean })
  @IfPresent()
  @IsBoolean()
  appliesToStaff?: boolean;
}

export class CancelHolidayDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @NoticeTextField(3, 500)
  reason: string;
}

export class CalendarRangeQueryDto {
  @ApiProperty(DATE)
  @IsCalendarDate()
  dateFrom: string;

  @ApiProperty({ ...DATE, description: 'On or after dateFrom, at most 365 days after it' })
  @IsCalendarDate()
  dateTo: string;
}
