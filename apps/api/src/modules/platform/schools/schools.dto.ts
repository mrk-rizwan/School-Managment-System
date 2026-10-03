import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  Allow,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateBy,
  ValidateIf,
} from 'class-validator';
import {
  DEFAULT_FEE_DUE_DAY,
  DEFAULT_TIMEZONE,
  MAX_FEE_DUE_DAY,
  MIN_FEE_DUE_DAY,
  SCHOOL_STATUSES,
  SHORT_CODE_PATTERN,
  type SchoolStatus,
} from '@asms/shared';
import { PageQueryDto } from '../../../common/pagination';

// contracts/slice-1.md §4.

/** IANA zones this runtime knows, built once at boot. */
const TIMEZONES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('timeZone'));

// No control characters (C0, DEL, C1) anywhere in a name.
const NO_CONTROL = /^[^\p{Cc}]*$/u;
// An identity number, plain (13 digits) or dashed, anywhere in the text. The audit tables refuse
// one (CHECK *_no_id_check), so it is refused here as a 422 rather than reaching them as a 500.
const IDENTITY_NUMBER = /[0-9]{13}|[0-9]{5}-[0-9]{7}-[0-9]/;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const trimLower = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/** Absent is allowed; present must pass the rest, so `null` is refused rather than skipped. */
const IfPresent = (): PropertyDecorator => ValidateIf((_object, value) => value !== undefined);

const IsTimezone = (): PropertyDecorator =>
  ValidateBy({
    name: 'isTimezone',
    validator: {
      validate: (value: unknown) => typeof value === 'string' && TIMEZONES.has(value),
      defaultMessage: () => '$property must be an IANA time zone',
    },
  });

const NoIdentityNumber = (): PropertyDecorator =>
  ValidateBy({
    name: 'noIdentityNumber',
    validator: {
      validate: (value: unknown) => typeof value === 'string' && !IDENTITY_NUMBER.test(value),
      defaultMessage: () => '$property must not contain an identity number',
    },
  });

const SchoolName = (): PropertyDecorator =>
  applyDecorators(
    Transform(trim),
    IsString(),
    Length(2, 200),
    Matches(NO_CONTROL, { message: '$property must not contain control characters' }),
    NoIdentityNumber(),
  );

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

  @ApiPropertyOptional({
    minLength: 2,
    maxLength: 100,
    description: 'Name contains, or short code starts with (case-insensitive)',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  @NoIdentityNumber()
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
  @Transform(trim)
  @IsString()
  @Length(3, 500)
  @NoIdentityNumber()
  reason: string;
}
