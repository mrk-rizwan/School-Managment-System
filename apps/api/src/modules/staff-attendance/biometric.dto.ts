import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { applyDecorators } from '@nestjs/common';
import {
  DEVICE_USER_ID_PATTERN,
  PUNCH_DIRECTIONS,
  PUNCH_OUTCOMES,
  PUNCH_RESULT_OUTCOMES,
  type PunchDirection,
  type PunchOutcome,
  type PunchResultOutcome,
} from '@asms/shared';
import { IsCalendarDate, NoIdentityNumber, QueryBoolean } from '../../common/fields';
import { ID_PATTERN, IsIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';

// contracts/slice-44.md §1 (R344, R345, A11). A punch carries a device user id and an instant,
// never a name; the batch answer never carries a name or a staff id either.

const ID = { type: String, pattern: ID_PATTERN.source } as const;
const DATE_TIME = { type: String, format: 'date-time' } as const;
const DEVICE_USER_ID = {
  type: String,
  minLength: 1,
  maxLength: 40,
  pattern: DEVICE_USER_ID_PATTERN.source,
  description: "The person's user number on the school's biometric device: 1-40 printable ASCII, no spaces",
} as const;
/** One batch: at most 500 punches (§5 slice 44). */
export const MAX_PUNCHES = 500;

const DeviceUserIdField = (): PropertyDecorator =>
  applyDecorators(
    IsString(),
    Matches(DEVICE_USER_ID_PATTERN, { message: '$property is 1-40 printable ASCII characters without spaces' }),
  );

// ------------------------------------------------------------------------------- device side

export class DevicePunchInDto {
  @ApiProperty(DEVICE_USER_ID)
  @DeviceUserIdField()
  deviceUserId: string;

  @ApiProperty({
    ...DATE_TIME,
    description: 'The instant of the punch with its offset; accepted from 7 days before receipt to 5 minutes after',
  })
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/, {
    message: '$property must be a date and time with an offset, e.g. 2026-11-14T08:01:00+05:00',
  })
  punchedAt: string;

  @ApiPropertyOptional({ enum: PUNCH_DIRECTIONS, enumName: 'PunchDirection' })
  @IsOptional()
  @IsIn(PUNCH_DIRECTIONS)
  direction?: PunchDirection;
}

export class DevicePunchBatchDto {
  @ApiProperty({ type: [DevicePunchInDto], minItems: 1, maxItems: MAX_PUNCHES })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PUNCHES)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => DevicePunchInDto)
  punches: DevicePunchInDto[];
}

export class DevicePunchResultDto {
  @ApiProperty(DEVICE_USER_ID)
  deviceUserId: string;

  @ApiProperty({ ...DATE_TIME, description: 'As sent' })
  punchedAt: string;

  @ApiProperty({
    enum: PUNCH_RESULT_OUTCOMES,
    enumName: 'PunchResultOutcome',
    description:
      'marked: made the day’s mark; stored: kept, no mark (a later punch, a non-working day, a day already marked); unmapped: no staff member holds the id; inactive: its holder is not active; duplicate: already received; rejected: outside the accepted window, not stored',
  })
  outcome: PunchResultOutcome;

  @ApiProperty({ ...ID, nullable: true, description: 'The mark this punch made (outcome marked)' })
  staffAttendanceId: string | null;
}

export class DevicePunchBatchResultDto {
  @ApiProperty({ type: [DevicePunchResultDto], description: 'In request order' })
  results: DevicePunchResultDto[];
}

// ------------------------------------------------------------------------------- school side

/** POST /school/device-token/revoke: whether a token was set (false: there was none, nothing written). */
export class DeviceTokenRevokedDto {
  @ApiProperty({ type: Boolean })
  revoked: boolean;
}

export class DeviceTokenDto {
  @ApiProperty({
    type: String,
    pattern: '^[A-Za-z0-9_-]{43}$',
    description: 'Shown once: only its hash is kept. The device sends it as `Authorization: Bearer <token>`.',
  })
  token: string;

  @ApiProperty(DATE_TIME)
  rotatedAt: Date;
}

export class SetDeviceUserDto {
  @ApiProperty({ ...DEVICE_USER_ID, nullable: true, description: 'null clears the mapping' })
  @ValidateIf((_o, value) => value !== null)
  @DeviceUserIdField()
  @NoIdentityNumber()
  deviceUserId: string | null;
}

export class StaffDeviceUserDto {
  @ApiProperty(ID)
  staffId: string;

  @ApiProperty({ ...DEVICE_USER_ID, nullable: true })
  deviceUserId: string | null;
}

export class DevicePunchDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(DEVICE_USER_ID)
  deviceUserId: string;

  @ApiProperty({ ...ID, nullable: true, description: 'The holder at receipt; null when unmapped (A11)' })
  staffId: string | null;

  @ApiProperty({ type: String, nullable: true })
  staffName: string | null;

  @ApiProperty(DATE_TIME)
  punchedAt: Date;

  @ApiProperty({ enum: PUNCH_DIRECTIONS, enumName: 'PunchDirection', nullable: true })
  direction: PunchDirection | null;

  @ApiProperty({ enum: PUNCH_OUTCOMES, enumName: 'PunchOutcome' })
  outcome: PunchOutcome;

  @ApiProperty(DATE_TIME)
  receivedAt: Date;

  @ApiProperty({ ...ID, nullable: true })
  staffAttendanceId: string | null;
}

export class ListDevicePunchesQueryDto extends PageQueryDto {
  @ApiProperty({ type: String, format: 'date', description: 'The school day (school time), not in the future' })
  @IsCalendarDate()
  date: string;

  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  staffId?: string;

  @QueryBoolean({ description: 'Only punches no staff member held the id of' })
  unmapped?: boolean;
}
