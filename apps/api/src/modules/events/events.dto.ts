import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  Matches,
  ValidateNested,
} from 'class-validator';
import { applyDecorators } from '@nestjs/common';
import {
  DUTY_KINDS,
  EVENT_STATUSES,
  EVENT_TYPES,
  PARTICIPATION_STATUSES,
  type DutyKind,
  type EventStatus,
  type EventType,
  type ParticipationStatus,
} from '@asms/shared';
import {
  IfPresent,
  IfPresentNotNull,
  IsCalendarDate,
  NoticeBodyField,
  NoticeTextField,
  QueryBoolean,
  Rupees,
  TextField,
} from '../../common/fields';
import { IsIdString } from '../../common/ids';
import { EachIdString } from '../fees/charges.dto';
import { PageQueryDto } from '../../common/pagination';

// Phase 5 slice 38 (contracts/slice-38.md §1). Ids are strings; dates are `YYYY-MM-DD`; instants
// are ISO 8601 with an offset.

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;
const NULLABLE_ID = { ...ID, nullable: true } as const;
const DATE = { type: String, format: 'date', example: '2026-11-14' } as const;
const DATE_TIME = { type: String, format: 'date-time' } as const;
const NULLABLE_DATE_TIME = { ...DATE_TIME, nullable: true } as const;
const RUPEES = { type: Number, minimum: 1, description: 'Whole rupees' } as const;
const EVENT_TYPE = { enum: EVENT_TYPES, enumName: 'EventType' } as const;
const EVENT_STATUS = { enum: EVENT_STATUSES, enumName: 'EventStatus' } as const;
const DUTY_KIND = { enum: DUTY_KINDS, enumName: 'DutyKind' } as const;
const PARTICIPATION = { enum: PARTICIPATION_STATUSES, enumName: 'ParticipationStatus' } as const;
/** A section list on an event: at most a school's worth. */
const MAX_SECTIONS = 100;
/** One participation request: at most 500 students. */
const MAX_PARTICIPATION_ROWS = 500;

/** An instant with a date, a time and an offset (`2026-11-14T09:00:00+05:00`). */
const IsInstant = (): PropertyDecorator =>
  applyDecorators(
    IsISO8601({ strict: true, strictSeparator: true }),
    Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/, {
      message: '$property must be a date and time with an offset, e.g. 2026-11-14T09:00:00+05:00',
    }),
  );

// ------------------------------------------------------------------------------------ responses

export class EventChargeDto {
  @ApiProperty(RUPEES) amount: number;
  @ApiProperty({ ...DATE, description: 'The stored due date, or the event date (school time) when none was given' })
  dueOn: string;
}

export class EventSectionDto {
  @ApiProperty(ID) sectionId: string;
  @ApiProperty() sectionName: string;
  @ApiProperty(ID) classId: string;
  @ApiProperty() className: string;
}

export class EventDutyDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(ID) eventId: string;
  @ApiProperty(ID) staffId: string;
  @ApiProperty() staffName: string;
  @ApiProperty(DUTY_KIND) duty: DutyKind;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @ApiProperty(DATE_TIME) createdAt: Date;
  @ApiProperty(NULLABLE_DATE_TIME) endedAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) endReason: string | null;
}

export class EventDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(ID) academicYearId: string;
  @ApiProperty() academicYearName: string;
  @ApiProperty(EVENT_TYPE) type: EventType;
  @ApiProperty() title: string;
  @ApiProperty(DATE_TIME) startsAt: Date;
  @ApiProperty(DATE_TIME) endsAt: Date;
  @ApiProperty() venue: string;
  @ApiProperty({ type: String, nullable: true }) details: string | null;
  @ApiProperty(EVENT_STATUS) status: EventStatus;
  @ApiProperty({ type: EventChargeDto, nullable: true }) charge: EventChargeDto | null;
  @ApiProperty({ type: EventSectionDto, isArray: true }) sections: EventSectionDto[];
  @ApiProperty({
    type: EventDutyDto,
    isArray: true,
    description: "Every duty for a holiday.manage holder; only the caller's own otherwise (rule 34)",
  })
  duties: EventDutyDto[];
  @ApiProperty({ ...DUTY_KIND, isArray: true, description: "The caller's live duties on this event" })
  myDuties: DutyKind[];
  @ApiProperty(NULLABLE_ID) announcementId: string | null;
  @ApiProperty(NULLABLE_ID) cancelAnnouncementId: string | null;
  @ApiProperty(NULLABLE_ID) campaignId: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'The campaign status (draft, generating, generated, cancelled)' })
  campaignStatus: string | null;
  @ApiProperty() createdByName: string;
  @ApiProperty(DATE_TIME) createdAt: Date;
  @ApiProperty(NULLABLE_DATE_TIME) completedAt: Date | null;
  @ApiProperty(NULLABLE_DATE_TIME) cancelledAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) cancelReason: string | null;
}

export class EventRosterChargeDto {
  @ApiProperty(ID) chargeId: string;
  @ApiProperty(RUPEES) amount: number;
  @ApiProperty({ type: Number, minimum: 0 }) outstanding: number;
  @ApiProperty() status: string;
}

export class EventRosterRowDto {
  @ApiProperty(ID) studentId: string;
  @ApiProperty(ID) enrolmentId: string;
  @ApiProperty() fullName: string;
  @ApiProperty() admissionNo: string;
  @ApiProperty({ type: Number, nullable: true }) rollNo: number | null;
  @ApiProperty(ID) sectionId: string;
  @ApiProperty() sectionName: string;
  @ApiProperty() className: string;
  @ApiProperty({ ...PARTICIPATION, nullable: true }) participation: ParticipationStatus | null;
  @ApiProperty(NULLABLE_DATE_TIME) recordedAt: Date | null;
  @ApiProperty({
    type: EventRosterChargeDto,
    nullable: true,
    description: 'Null without a charge, or unless the caller collects for this event, holds holiday.manage or payment.record',
  })
  charge: EventRosterChargeDto | null;
}

export class EventRosterDto {
  @ApiProperty(ID) eventId: string;
  @ApiProperty(EVENT_STATUS) status: EventStatus;
  @ApiProperty({ type: EventRosterRowDto, isArray: true, description: 'Class, section, roll number and name order' })
  rows: EventRosterRowDto[];
}

export class EventParticipantsDto {
  @ApiProperty() roster: number;
  @ApiProperty() attended: number;
  @ApiProperty() absent: number;
  @ApiProperty() excused: number;
  @ApiProperty() unrecorded: number;
}

export class EventCollectionsDto {
  @ApiProperty() chargeCount: number;
  @ApiProperty() charged: number;
  @ApiProperty({ description: 'Σ live allocations to the campaign charges (R314)' }) collected: number;
  @ApiProperty() outstanding: number;
}

export class EventExpensesDto {
  @ApiProperty() count: number;
  @ApiProperty({ description: 'Σ recorded and approved expenses tagged to the event' }) total: number;
}

export class EventReportDto {
  @ApiProperty(ID) eventId: string;
  @ApiProperty() title: string;
  @ApiProperty(EVENT_STATUS) status: EventStatus;
  @ApiProperty({ type: EventParticipantsDto }) participants: EventParticipantsDto;
  @ApiProperty({ type: EventCollectionsDto }) collections: EventCollectionsDto;
  @ApiProperty({ type: EventExpensesDto }) expenses: EventExpensesDto;
  @ApiProperty({ description: 'collected − expenses' }) net: number;
}

/** R315: the family's view — no duties, no staff, only the child's own charge. */
export class MyEventChargeDto {
  @ApiProperty(RUPEES) amount: number;
  @ApiProperty({ type: Number, minimum: 0 }) outstanding: number;
  @ApiProperty() status: string;
}

export class MyEventDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(EVENT_TYPE) type: EventType;
  @ApiProperty() title: string;
  @ApiProperty(DATE_TIME) startsAt: Date;
  @ApiProperty(DATE_TIME) endsAt: Date;
  @ApiProperty() venue: string;
  @ApiProperty({ type: String, nullable: true }) details: string | null;
  @ApiProperty(EVENT_STATUS) status: EventStatus;
  @ApiProperty({ type: MyEventChargeDto, nullable: true }) charge: MyEventChargeDto | null;
}

// ------------------------------------------------------------------------------------- requests

export class EventChargeInputDto {
  @ApiProperty(RUPEES)
  @Rupees(1)
  amount: number;

  @ApiPropertyOptional({ ...DATE, description: 'Today or later, inside the year; default the event date' })
  @IfPresent()
  @IsCalendarDate()
  dueOn?: string;
}

export class CreateEventDto {
  @ApiProperty(ID)
  @IsIdString()
  academicYearId: string;

  @ApiProperty(EVENT_TYPE)
  @IsIn(EVENT_TYPES)
  type: EventType;

  @ApiProperty({ minLength: 1, maxLength: 120 })
  @NoticeTextField(1, 120)
  title: string;

  @ApiProperty({ ...DATE_TIME, description: 'Its date in school time lies inside the year' })
  @IsInstant()
  startsAt: string;

  @ApiProperty({ ...DATE_TIME, description: 'Not before startsAt' })
  @IsInstant()
  endsAt: string;

  @ApiProperty({ minLength: 1, maxLength: 120 })
  @NoticeTextField(1, 120)
  venue: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 1000, description: 'Line breaks kept' })
  @IfPresent()
  @NoticeBodyField(1, 1000)
  details?: string;

  @ApiProperty({ ...ID, isArray: true, maxItems: MAX_SECTIONS, description: 'Sections of the year (none yet is allowed on a draft)' })
  @IsArray()
  @ArrayMaxSize(MAX_SECTIONS)
  @EachIdString()
  sectionIds: string[];

  @ApiPropertyOptional({ type: EventChargeInputDto, description: 'Needs charge.create and charge.campaign.send' })
  @IfPresent()
  @ValidateNested()
  @Type(() => EventChargeInputDto)
  charge?: EventChargeInputDto;
}

export class UpdateEventDto {
  @ApiPropertyOptional(EVENT_TYPE)
  @IfPresent()
  @IsIn(EVENT_TYPES)
  type?: EventType;

  @ApiPropertyOptional({ minLength: 1, maxLength: 120 })
  @IfPresent()
  @NoticeTextField(1, 120)
  title?: string;

  @ApiPropertyOptional(DATE_TIME)
  @IfPresent()
  @IsInstant()
  startsAt?: string;

  @ApiPropertyOptional(DATE_TIME)
  @IfPresent()
  @IsInstant()
  endsAt?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 120 })
  @IfPresent()
  @NoticeTextField(1, 120)
  venue?: string;

  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 1000, nullable: true, description: 'null clears' })
  @IfPresentNotNull()
  @NoticeBodyField(1, 1000)
  details?: string | null;

  @ApiPropertyOptional({ ...ID, isArray: true, maxItems: MAX_SECTIONS, description: 'Replaces the whole set' })
  @IfPresent()
  @IsArray()
  @ArrayMaxSize(MAX_SECTIONS)
  @EachIdString()
  sectionIds?: string[];

  @ApiPropertyOptional({ type: EventChargeInputDto, nullable: true, description: 'null removes the charge' })
  @IfPresentNotNull()
  @ValidateNested()
  @Type(() => EventChargeInputDto)
  charge?: EventChargeInputDto | null;
}

export class AddEventDutyDto {
  @ApiProperty(ID)
  @IsIdString()
  staffId: string;

  @ApiProperty(DUTY_KIND)
  @IsIn(DUTY_KINDS)
  duty: DutyKind;

  @ApiPropertyOptional({ minLength: 1, maxLength: 200 })
  @IfPresent()
  @TextField(1, 200)
  note?: string;
}

export class ParticipationRowDto {
  @ApiProperty(ID)
  @IsIdString()
  studentId: string;

  @ApiProperty(PARTICIPATION)
  @IsIn(PARTICIPATION_STATUSES)
  status: ParticipationStatus;
}

export class RecordEventParticipationDto {
  @ApiProperty({ type: ParticipationRowDto, isArray: true, minItems: 1, maxItems: MAX_PARTICIPATION_ROWS })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PARTICIPATION_ROWS)
  @ValidateNested({ each: true })
  @Type(() => ParticipationRowDto)
  rows: ParticipationRowDto[];
}

export class CreateEventPaymentDto {
  @ApiProperty(ID)
  @IsIdString()
  studentId: string;

  @ApiProperty(RUPEES)
  @Rupees(1)
  amount: number;

  @ApiProperty({ ...DATE, description: 'Today or earlier (school time)' })
  @IsCalendarDate()
  receivedOn: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 60, description: 'A note of the receipt book or slip, if any' })
  @IfPresent()
  @TextField(1, 60)
  reference?: string;
}

export const EVENT_SORTS = ['-startsAt', 'startsAt'] as const;

export class ListEventsQueryDto extends PageQueryDto {
  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  academicYearId?: string;

  @ApiPropertyOptional(EVENT_TYPE)
  @IsOptional()
  @IsIn(EVENT_TYPES)
  type?: EventType;

  @ApiPropertyOptional(EVENT_STATUS)
  @IsOptional()
  @IsIn(EVENT_STATUSES)
  status?: EventStatus;

  @ApiPropertyOptional({ ...DATE, description: 'Starting on or after this day (school time)' })
  @IsOptional()
  @IsCalendarDate()
  startsFrom?: string;

  @ApiPropertyOptional({ ...DATE, description: 'Starting on or before this day (school time)' })
  @IsOptional()
  @IsCalendarDate()
  startsTo?: string;

  @QueryBoolean({
    default: false,
    description: "Only events of the caller's live duties or of the sections they are class teacher or cover of today",
  })
  mine?: boolean;

  @ApiPropertyOptional({ enum: EVENT_SORTS, enumName: 'EventSort', default: '-startsAt' })
  @IsOptional()
  @IsIn(EVENT_SORTS)
  sort?: (typeof EVENT_SORTS)[number];
}

export class EventRosterQueryDto {
  @ApiPropertyOptional({ ...ID, description: 'One of the event sections' })
  @IsOptional()
  @IsIdString()
  sectionId?: string;
}
