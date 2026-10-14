import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { CONTRACT_TYPES, type ContractType } from '@asms/shared';
import { IfPresent, IsCalendarDate, NameField, Reason } from '../../../common/fields';
import { ID_PATTERN, IsIdString } from '../../../common/ids';
import { PageQueryDto } from '../../../common/pagination';

// Phase 5 slice 39 (phase-5-extended.md rule 35, §5 slice 39, R318-R321; contracts/slice-39.md
// §1). A contract carries no pay: it names the salary structure at its start, never an amount.

const ID = { type: String, pattern: ID_PATTERN.source } as const;
const NULLABLE_ID = { ...ID, nullable: true } as const;
const DATE = { type: String, format: 'date', example: '2026-10-10' } as const;
const NULLABLE_DATE = { ...DATE, nullable: true } as const;
const DATE_TIME = { type: String, format: 'date-time' } as const;
const NULLABLE_DATE_TIME = { ...DATE_TIME, nullable: true } as const;
const NULLABLE_TEXT = { type: String, nullable: true } as const;
const TYPE = { enum: CONTRACT_TYPES, enumName: 'ContractType' } as const;

/**
 * Against the school's today: `ended` (the end group is set), `upcoming` (starts later), `expired`
 * (past its last day and not ended: "expired, not ended", R320), `live`.
 */
export const STAFF_CONTRACT_STATUSES = ['live', 'upcoming', 'expired', 'ended'] as const;
export type StaffContractStatus = (typeof STAFF_CONTRACT_STATUSES)[number];
const STATUS = { enum: STAFF_CONTRACT_STATUSES, enumName: 'StaffContractStatus' } as const;

export class StaffContractDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(ID)
  staffId: string;

  @ApiProperty()
  staffName: string;

  @ApiProperty(TYPE)
  type: ContractType;

  @ApiProperty(DATE)
  startsOn: string;

  @ApiProperty({ ...NULLABLE_DATE, description: 'The last working day; null exactly for permanent' })
  endsOn: string | null;

  @ApiProperty(STATUS)
  status: StaffContractStatus;

  @ApiProperty({ type: Number, nullable: true, description: 'Days from today to endsOn (negative once past); null without an end or once ended' })
  daysLeft: number | null;

  @ApiProperty({ ...NULLABLE_ID, description: 'The salary structure in force at the start (informational; never an amount)' })
  salaryStructureId: string | null;

  @ApiProperty()
  hasDocument: boolean;

  @ApiProperty(NULLABLE_TEXT)
  documentMime: string | null;

  @ApiProperty(NULLABLE_TEXT)
  note: string | null;

  @ApiProperty(NULLABLE_TEXT)
  createdByName: string | null;

  @ApiProperty(DATE_TIME)
  createdAt: Date;

  @ApiProperty(NULLABLE_DATE_TIME)
  endedAt: Date | null;

  @ApiProperty({ ...NULLABLE_DATE, description: "The contract's actual last day" })
  endedOn: string | null;

  @ApiProperty({ ...NULLABLE_TEXT, description: '`renewed`, `left` or the reason given' })
  endReason: string | null;

  @ApiProperty(NULLABLE_TEXT)
  endedByName: string | null;
}

/** The staff member's own contract (GET /me/staff/contract): no note, no structure id. */
export class MyStaffContractCurrentDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(TYPE)
  type: ContractType;

  @ApiProperty(DATE)
  startsOn: string;

  @ApiProperty(NULLABLE_DATE)
  endsOn: string | null;

  @ApiProperty(STATUS)
  status: StaffContractStatus;

  @ApiProperty()
  hasDocument: boolean;
}

export class MyStaffContractDto {
  @ApiProperty({ type: MyStaffContractCurrentDto, nullable: true, description: 'The live contract, if any' })
  current: MyStaffContractCurrentDto | null;
}

export class ListStaffContractsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['-startsOn'], enumName: 'StaffContractSort', default: '-startsOn' })
  @IsOptional()
  @IsIn(['-startsOn'])
  sort?: '-startsOn';
}

export class ListEndingContractsQueryDto extends PageQueryDto {
  @ApiProperty({ ...DATE, description: 'Live contracts whose last day is on or before this date (expired ones included)' })
  @IsCalendarDate()
  endsBy: string;

  @ApiPropertyOptional({ enum: ['endsOn'], enumName: 'EndingContractSort', default: 'endsOn' })
  @IsOptional()
  @IsIn(['endsOn'])
  sort?: 'endsOn';
}

export class CreateStaffContractDto {
  @ApiProperty(TYPE)
  @IsIn(CONTRACT_TYPES)
  type: ContractType;

  @ApiProperty(DATE)
  @IsCalendarDate()
  startsOn: string;

  /** Required for fixed-term and probation, absent for permanent (STAFF_CONTRACT_END_REQUIRED). */
  @ApiPropertyOptional(DATE)
  @IfPresent()
  @IsCalendarDate()
  endsOn?: string;

  /** Default: the staff member's salary structure in force on startsOn, if any. */
  @ApiPropertyOptional(ID)
  @IfPresent()
  @IsIdString()
  salaryStructureId?: string;

  /** The scanned contract (POST /uploads): JPEG, PNG or PDF, at most 5 MB. Set only here. */
  @ApiPropertyOptional(ID)
  @IfPresent()
  @IsIdString()
  stagedUploadId?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 500 })
  @IfPresent()
  @NameField(1, 500, { collapse: false })
  note?: string;
}

export class EndStaffContractDto {
  @ApiProperty({ ...DATE, description: "The contract's actual last day: from its start to its endsOn" })
  @IsCalendarDate()
  endedOn: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;
}
