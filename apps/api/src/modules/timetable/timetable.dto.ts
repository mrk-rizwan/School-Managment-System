import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  Length,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { MAX_TIMETABLE_PERIODS, TIMETABLE_ROOM_MAX } from '@asms/shared';
import { IfPresent, IsCalendarDate, NoIdentityNumber, QueryBoolean, Reason, trim } from '../../common/fields';
import { IsIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';

// Phase 5 slice 37 (contracts/slice-37.md §1). Ids are strings; dates are `YYYY-MM-DD`.

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;
const NULLABLE_ID = { ...ID, nullable: true } as const;
const DATE = { type: String, format: 'date', example: '2026-10-12' } as const;
const NULLABLE_DATE = { ...DATE, nullable: true } as const;
const DATE_TIME = { type: String, format: 'date-time' } as const;
const NULLABLE_DATE_TIME = { ...DATE_TIME, nullable: true } as const;
const WEEKDAY = { type: Number, minimum: 0, maximum: 6, description: '0 = Sunday ... 6 = Saturday' } as const;
const PERIOD = { type: Number, minimum: 1, maximum: MAX_TIMETABLE_PERIODS } as const;

export const TIMETABLE_VERSION_STATUSES = ['live', 'future', 'past', 'voided'] as const;
export type TimetableVersionStatus = (typeof TIMETABLE_VERSION_STATUSES)[number];
const VERSION_STATUS = { enum: TIMETABLE_VERSION_STATUSES, enumName: 'TimetableVersionStatus' } as const;

export const TIMETABLE_PERIOD_KINDS = ['slot', 'substitution'] as const;
export type TimetablePeriodKind = (typeof TIMETABLE_PERIOD_KINDS)[number];

/** A query-string integer: plain decimal digits only, else left for IsInt to refuse. */
const QueryInt = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^[0-9]{1,2}$/.test(value) ? Number(value) : value,
  );

// ------------------------------------------------------------------------------------ responses

export class TimetableSlotDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(WEEKDAY) weekday: number;
  @ApiProperty(PERIOD) period: number;
  @ApiProperty(ID) classSubjectId: string;
  @ApiProperty() subjectName: string;
  @ApiProperty(ID) staffId: string;
  @ApiProperty() teacherName: string;
  @ApiProperty({ type: String, nullable: true }) room: string | null;
  @ApiProperty({
    description:
      'False when the teacher holds no live assignment for the subject and section on the day (a version: its first day, or today when live): "no assigned teacher" (R303)',
  })
  assignedTeacher: boolean;
}

export class TimetableVersionDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(ID) sectionId: string;
  @ApiProperty() sectionName: string;
  @ApiProperty(ID) classId: string;
  @ApiProperty() className: string;
  @ApiProperty(ID) academicYearId: string;
  @ApiProperty(DATE) effectiveFrom: string;
  @ApiProperty({ ...NULLABLE_DATE, description: 'Inclusive; null = open-ended' }) effectiveTo: string | null;
  @ApiProperty({ ...VERSION_STATUS, description: 'Against the school today' }) status: TimetableVersionStatus;
  @ApiProperty() slotCount: number;
  @ApiProperty() createdByName: string;
  @ApiProperty(DATE_TIME) createdAt: Date;
  @ApiProperty(NULLABLE_DATE_TIME) voidedAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) voidedByName: string | null;
  @ApiProperty({ type: String, nullable: true }) voidReason: string | null;
}

export class TimetableVersionDetailDto extends TimetableVersionDto {
  @ApiProperty({ type: TimetableSlotDto, isArray: true, description: 'Weekday, then period order' })
  slots: TimetableSlotDto[];
}

export class TimetableSubstitutionDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(ID) sectionId: string;
  @ApiProperty() sectionName: string;
  @ApiProperty(ID) classId: string;
  @ApiProperty() className: string;
  @ApiProperty(DATE) date: string;
  @ApiProperty(PERIOD) period: number;
  @ApiProperty({ ...ID, description: 'The substitute' }) staffId: string;
  @ApiProperty() teacherName: string;
  @ApiProperty({ ...NULLABLE_ID, description: "The slot's own teacher on the date; null when no longer timetabled" })
  regularStaffId: string | null;
  @ApiProperty({ type: String, nullable: true }) regularTeacherName: string | null;
  @ApiProperty({ type: String, nullable: true }) subjectName: string | null;
  @ApiProperty() reason: string;
  @ApiProperty() createdByName: string;
  @ApiProperty(DATE_TIME) createdAt: Date;
  @ApiProperty(NULLABLE_DATE_TIME) voidedAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) voidReason: string | null;
}

export class TimetableSectionRefDto {
  @ApiProperty(ID) id: string;
  @ApiProperty() name: string;
  @ApiProperty(ID) classId: string;
  @ApiProperty() className: string;
  @ApiProperty(ID) academicYearId: string;
}

export class SectionTimetableDayDto {
  @ApiProperty(DATE) date: string;
  @ApiProperty(WEEKDAY) weekday: number;
  @ApiProperty() teachingDay: boolean;
  @ApiProperty({ ...NULLABLE_ID, description: 'The version live on this day (R309)' }) versionId: string | null;
  @ApiProperty({ type: TimetableSlotDto, isArray: true }) slots: TimetableSlotDto[];
  @ApiProperty({ type: TimetableSubstitutionDto, isArray: true, description: 'Live substitutions of the day' })
  substitutions: TimetableSubstitutionDto[];
}

export class SectionTimetableDto {
  @ApiProperty({ type: TimetableSectionRefDto }) section: TimetableSectionRefDto;
  @ApiProperty({ ...DATE, description: 'The Monday of the week' }) weekOf: string;
  @ApiProperty() periodsPerDay: number;
  @ApiProperty({ type: SectionTimetableDayDto, isArray: true, description: 'Monday to Sunday' })
  days: SectionTimetableDayDto[];
}

/** R308: names only — no ids, reasons or versions. */
export class MyTimetablePeriodDto {
  @ApiProperty(PERIOD) period: number;
  @ApiProperty() subjectName: string;
  @ApiProperty({ description: "The teacher's name (the substitute's on a substituted day)" }) teacherName: string;
  @ApiProperty({ type: String, nullable: true }) room: string | null;
}

export class MyTimetableDayDto {
  @ApiProperty(DATE) date: string;
  @ApiProperty(WEEKDAY) weekday: number;
  @ApiProperty() teachingDay: boolean;
  @ApiProperty({ type: MyTimetablePeriodDto, isArray: true }) periods: MyTimetablePeriodDto[];
}

export class MyTimetableDto {
  @ApiProperty(ID) studentId: string;
  @ApiProperty({ type: String, nullable: true }) sectionName: string | null;
  @ApiProperty({ type: String, nullable: true }) className: string | null;
  @ApiProperty({ ...DATE, description: 'The Monday of the week' }) weekOf: string;
  @ApiProperty() periodsPerDay: number;
  @ApiProperty({ type: MyTimetableDayDto, isArray: true, description: 'Monday to Sunday' }) days: MyTimetableDayDto[];
}

export class MyStaffTimetablePeriodDto {
  @ApiProperty(PERIOD) period: number;
  @ApiProperty(ID) sectionId: string;
  @ApiProperty() sectionName: string;
  @ApiProperty(ID) classId: string;
  @ApiProperty() className: string;
  @ApiProperty({ type: String, nullable: true }) subjectName: string | null;
  @ApiProperty({ type: String, nullable: true }) room: string | null;
  @ApiProperty({ enum: TIMETABLE_PERIOD_KINDS, enumName: 'TimetablePeriodKind' }) kind: TimetablePeriodKind;
  @ApiProperty({ type: String, nullable: true, description: 'A slot of yours another teacher takes that day' })
  substitutedByName: string | null;
}

export class MyStaffTimetableDayDto {
  @ApiProperty(DATE) date: string;
  @ApiProperty(WEEKDAY) weekday: number;
  @ApiProperty() teachingDay: boolean;
  @ApiProperty({ type: MyStaffTimetablePeriodDto, isArray: true }) periods: MyStaffTimetablePeriodDto[];
}

export class MyStaffTimetableDto {
  @ApiProperty({ ...DATE, description: 'The Monday of the week' }) weekOf: string;
  @ApiProperty() periodsPerDay: number;
  @ApiProperty({ type: MyStaffTimetableDayDto, isArray: true, description: 'Monday to Sunday' })
  days: MyStaffTimetableDayDto[];
}

export class TimetableGridSectionDto {
  @ApiProperty(ID) sectionId: string;
  @ApiProperty() sectionName: string;
  @ApiProperty(ID) classId: string;
  @ApiProperty() className: string;
  @ApiProperty(NULLABLE_ID) versionId: string | null;
  @ApiProperty({ type: TimetableSlotDto, isArray: true }) cells: TimetableSlotDto[];
}

export class TimetableGridDto {
  @ApiProperty(ID) academicYearId: string;
  @ApiProperty(DATE) date: string;
  @ApiProperty(WEEKDAY) weekday: number;
  @ApiProperty() periodsPerDay: number;
  @ApiProperty({ type: Number, isArray: true }) weeklyOffDays: number[];
  @ApiProperty({ type: TimetableGridSectionDto, isArray: true }) sections: TimetableGridSectionDto[];
}

// ------------------------------------------------------------------------------------ requests

export class TimetableWeekQueryDto {
  @ApiPropertyOptional({ ...DATE, description: 'Any day of the week; default today' })
  @IsOptional()
  @IsCalendarDate()
  date?: string;
}

export class MyStaffTimetableQueryDto {
  @ApiPropertyOptional({ ...DATE, description: 'Any day of the week; default today' })
  @IsOptional()
  @IsCalendarDate()
  weekOf?: string;
}

export class TimetableSlotInputDto {
  @ApiProperty(WEEKDAY)
  @IsInt()
  @Min(0)
  @Max(6)
  weekday: number;

  @ApiProperty(PERIOD)
  @IsInt()
  @Min(1)
  @Max(MAX_TIMETABLE_PERIODS)
  period: number;

  @ApiProperty(ID)
  @IsIdString()
  classSubjectId: string;

  @ApiProperty(ID)
  @IsIdString()
  staffId: string;

  @ApiPropertyOptional({ type: String, nullable: true, minLength: 1, maxLength: TIMETABLE_ROOM_MAX })
  @Transform(trim)
  @ValidateIf((_o, value) => value !== undefined && value !== null && value !== '')
  @Length(1, TIMETABLE_ROOM_MAX)
  @NoIdentityNumber()
  room?: string | null;
}

/** Exactly one of `slots` and `copyFromVersionId` (both or neither: 422 on `slots`). */
export class CreateTimetableVersionDto {
  @ApiProperty({ ...DATE, description: 'Today or later, inside the academic year' })
  @IsCalendarDate()
  effectiveFrom: string;

  @ApiPropertyOptional({ type: TimetableSlotInputDto, isArray: true, minItems: 1, maxItems: 84 })
  @IfPresent()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(84)
  @ValidateNested({ each: true })
  @Type(() => TimetableSlotInputDto)
  slots?: TimetableSlotInputDto[];

  @ApiPropertyOptional({ ...ID, description: 'Copy the slots of another version of the same class' })
  @IfPresent()
  @IsIdString()
  copyFromVersionId?: string;
}

export const TIMETABLE_VERSION_SORTS = ['-effectiveFrom', 'effectiveFrom'] as const;

export class ListTimetableVersionsQueryDto extends PageQueryDto {
  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  sectionId?: string;

  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  academicYearId?: string;

  @ApiPropertyOptional(VERSION_STATUS)
  @IsOptional()
  @IsIn(TIMETABLE_VERSION_STATUSES)
  status?: TimetableVersionStatus;

  @ApiPropertyOptional({ enum: TIMETABLE_VERSION_SORTS, enumName: 'TimetableVersionSort', default: '-effectiveFrom' })
  @IsOptional()
  @IsIn(TIMETABLE_VERSION_SORTS)
  sort?: (typeof TIMETABLE_VERSION_SORTS)[number];
}

export class CreateSubstitutionDto {
  @ApiProperty(DATE)
  @IsCalendarDate()
  date: string;

  @ApiProperty(PERIOD)
  @IsInt()
  @Min(1)
  @Max(MAX_TIMETABLE_PERIODS)
  period: number;

  @ApiProperty({ ...ID, description: 'The substitute; needs no assignment' })
  @IsIdString()
  staffId: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;
}

export const SUBSTITUTION_SORTS = ['-date', 'date'] as const;

export class ListSubstitutionsQueryDto extends PageQueryDto {
  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  sectionId?: string;

  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  staffId?: string;

  @ApiPropertyOptional(DATE)
  @IsOptional()
  @IsCalendarDate()
  from?: string;

  @ApiPropertyOptional(DATE)
  @IsOptional()
  @IsCalendarDate()
  to?: string;

  @QueryBoolean({ default: false, description: 'Voided substitutions too' })
  includeVoided?: boolean;

  @ApiPropertyOptional({ enum: SUBSTITUTION_SORTS, enumName: 'TimetableSubstitutionSort', default: '-date' })
  @IsOptional()
  @IsIn(SUBSTITUTION_SORTS)
  sort?: (typeof SUBSTITUTION_SORTS)[number];
}

export class TimetableGridQueryDto {
  @ApiProperty(ID)
  @IsIdString()
  academicYearId: string;

  @ApiPropertyOptional({ ...DATE, description: 'Which versions are live; default today' })
  @IsOptional()
  @IsCalendarDate()
  date?: string;

  @ApiPropertyOptional({ ...WEEKDAY, description: "Default the date's weekday" })
  @IsOptional()
  @QueryInt()
  @IsInt()
  @Min(0)
  @Max(6)
  weekday?: number;
}
