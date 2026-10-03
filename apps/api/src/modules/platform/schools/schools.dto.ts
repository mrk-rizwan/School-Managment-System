import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  Allow,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateBy,
} from 'class-validator';
import {
  DEFAULT_FEE_DUE_DAY,
  DEFAULT_TIMEZONE,
  MAX_FEE_DUE_DAY,
  MIN_FEE_DUE_DAY,
  SCHOOL_STATUSES,
  SHORT_CODE_PATTERN,
  SMS_PROVIDER_CHOICES,
  WHATSAPP_PROVIDER_CHOICES,
  type SchoolStatus,
  type SmsProviderChoice,
  type WhatsAppProviderChoice,
} from '@asms/shared';
import { IfPresent, NameField, SearchField, TextField, trimLower } from '../../../common/fields';
import { PageQueryDto } from '../../../common/pagination';

// contracts/slice-1.md §4.

/** IANA zones this runtime knows, built once at boot. */
const TIMEZONES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('timeZone'));

const IsTimezone = (): PropertyDecorator =>
  ValidateBy({
    name: 'isTimezone',
    validator: {
      validate: (value: unknown) => typeof value === 'string' && TIMEZONES.has(value),
      defaultMessage: () => '$property must be an IANA time zone',
    },
  });

/** Trimmed only: a school's name keeps its internal spacing. */
const SchoolName = (): PropertyDecorator => NameField(2, 200, { collapse: false });

export class SchoolDto {
  @ApiProperty({ type: String, pattern: '^[1-9][0-9]{0,18}$' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ pattern: SHORT_CODE_PATTERN.source })
  shortCode: string;

  @ApiProperty({ enum: SCHOOL_STATUSES, enumName: 'SchoolStatus' })
  status: SchoolStatus;

  @ApiProperty({ description: 'IANA time zone' })
  timezone: string;

  @ApiProperty({ type: 'integer', minimum: 0, maximum: 100000, description: 'SMS segments a month' })
  smsMonthlyCap: number;

  @ApiProperty({ enum: WHATSAPP_PROVIDER_CHOICES, enumName: 'WhatsAppProviderChoice' })
  whatsappProvider: WhatsAppProviderChoice;

  @ApiProperty({ enum: SMS_PROVIDER_CHOICES, enumName: 'SmsProviderChoice' })
  smsProvider: SmsProviderChoice;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export const SCHOOL_SORTS = [
  'name',
  '-name',
  'shortCode',
  '-shortCode',
  'status',
  '-status',
  'createdAt',
  '-createdAt',
] as const;
export type SchoolSort = (typeof SCHOOL_SORTS)[number];

export class ListSchoolsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: SCHOOL_STATUSES, enumName: 'SchoolStatus' })
  @IsOptional()
  @IsIn(SCHOOL_STATUSES)
  status?: SchoolStatus;

  @SearchField('Name contains, or short code starts with (case-insensitive)', 100)
  q?: string;

  @ApiPropertyOptional({ enum: SCHOOL_SORTS, enumName: 'SchoolSort', default: 'name' })
  @IsOptional()
  @IsIn(SCHOOL_SORTS)
  sort?: SchoolSort;
}

export class CreateSchoolDto {
  @ApiProperty({ minLength: 2, maxLength: 200 })
  @SchoolName()
  name: string;

  @ApiProperty({
    pattern: SHORT_CODE_PATTERN.source,
    description: 'Trimmed and lower-cased before validation. Cannot be changed later.',
  })
  @Transform(trimLower)
  @IsString()
  @Matches(SHORT_CODE_PATTERN, { message: '$property must be 3-12 lower-case letters or digits' })
  shortCode: string;

  @ApiPropertyOptional({ default: DEFAULT_TIMEZONE, description: 'IANA time zone' })
  @IfPresent()
  @IsTimezone()
  timezone?: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: MIN_FEE_DUE_DAY,
    maximum: MAX_FEE_DUE_DAY,
    default: DEFAULT_FEE_DUE_DAY,
  })
  @IfPresent()
  @IsInt()
  @Min(MIN_FEE_DUE_DAY)
  @Max(MAX_FEE_DUE_DAY)
  feeDueDay?: number;
}

export class UpdateSchoolDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 200 })
  @IfPresent()
  @SchoolName()
  name?: string;

  @ApiPropertyOptional({ description: 'IANA time zone' })
  @IfPresent()
  @IsTimezone()
  timezone?: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 100000 })
  @IfPresent()
  @IsInt()
  @Min(0)
  @Max(100000)
  smsMonthlyCap?: number;

  @ApiPropertyOptional({ enum: WHATSAPP_PROVIDER_CHOICES, enumName: 'WhatsAppProviderChoice' })
  @IfPresent()
  @IsIn(WHATSAPP_PROVIDER_CHOICES)
  whatsappProvider?: WhatsAppProviderChoice;

  @ApiPropertyOptional({ enum: SMS_PROVIDER_CHOICES, enumName: 'SmsProviderChoice' })
  @IfPresent()
  @IsIn(SMS_PROVIDER_CHOICES)
  smsProvider?: SmsProviderChoice;

  /** Declared only so it can be refused with its own code (409), not as an unknown field. */
  @ApiPropertyOptional({
    type: String,
    description: 'Never accepted: present with any value is 409 SCHOOL_SHORT_CODE_IMMUTABLE',
  })
  @Allow()
  shortCode?: unknown;
}

export const STATUS_TARGETS = ['active', 'suspended', 'terminated'] as const;

export class ChangeSchoolStatusDto {
  @ApiProperty({ enum: STATUS_TARGETS, enumName: 'SchoolStatusTarget' })
  @IsIn(STATUS_TARGETS)
  status: (typeof STATUS_TARGETS)[number];

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @TextField(3, 500)
  reason: string;
}
