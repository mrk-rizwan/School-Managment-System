import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import {
  FEE_FREQUENCIES,
  FEE_HEAD_CATEGORIES,
  FEE_HEAD_STATUSES,
  FEE_STRUCTURE_STATUSES,
  MAX_RUPEES,
  type FeeFrequency,
  type FeeHeadCategory,
  type FeeHeadStatus,
  type FeeStructureStatus,
} from '@asms/shared';
import { IfPresent, IsYearMonth, NameField, Reason, Rupees } from '../../common/fields';
import { IsIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';

// phase-3-financial.md slice 18 (R176, R177).

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;
const MONTH = { type: String, pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$', example: '2026-04' } as const;
const RUPEES = { type: Number, minimum: 0, maximum: MAX_RUPEES, description: 'Whole rupees' } as const;
const CATEGORY = { enum: FEE_HEAD_CATEGORIES, enumName: 'FeeHeadCategory' } as const;
const FREQUENCY = { enum: FEE_FREQUENCIES, enumName: 'FeeFrequency' } as const;

// --------------------------------------------------------------------------------- fee heads

export class FeeHeadDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty(CATEGORY)
  category: FeeHeadCategory;

  @ApiProperty(FREQUENCY)
  frequency: FeeFrequency;

  @ApiProperty()
  concessionEligible: boolean;

  @ApiProperty()
  refundable: boolean;

  @ApiProperty({ enum: FEE_HEAD_STATUSES, enumName: 'FeeHeadStatus' })
  status: FeeHeadStatus;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  archivedAt: Date | null;

  @ApiProperty({ type: String, nullable: true })
  archiveReason: string | null;

  /** True for the five heads the school started with (created_by null). */
  @ApiProperty()
  seeded: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

export const FEE_HEAD_SORTS = ['name', '-name'] as const;
export type FeeHeadSort = (typeof FEE_HEAD_SORTS)[number];

export class ListFeeHeadsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: FEE_HEAD_STATUSES, enumName: 'FeeHeadStatus' })
  @IsOptional()
  @IsIn(FEE_HEAD_STATUSES)
  status?: FeeHeadStatus;

  @ApiPropertyOptional({ enum: FEE_HEAD_SORTS, enumName: 'FeeHeadSort', default: 'name' })
  @IsOptional()
  @IsIn(FEE_HEAD_SORTS)
  sort?: FeeHeadSort;
}

/**
 * A fine is never concession-eligible and an admission fee never refundable (rules 19, 20): left
 * out they default to false for those categories and true for the rest; sent as true they are 422.
 */
export class CreateFeeHeadDto {
  @ApiProperty({ minLength: 1, maxLength: 60 })
  @NameField(1, 60)
  name: string;

  @ApiProperty(CATEGORY)
  @IsIn(FEE_HEAD_CATEGORIES)
  category: FeeHeadCategory;

  @ApiProperty(FREQUENCY)
  @IsIn(FEE_FREQUENCIES)
  frequency: FeeFrequency;

  @ApiPropertyOptional()
  @IfPresent()
  @IsBoolean()
  concessionEligible?: boolean;

  @ApiPropertyOptional()
  @IfPresent()
  @IsBoolean()
  refundable?: boolean;
}

/** Category and frequency are frozen (a different kind of fee is a new head). */
export class UpdateFeeHeadDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 60 })
  @IfPresent()
  @NameField(1, 60)
  name?: string;

  @ApiPropertyOptional()
  @IfPresent()
  @IsBoolean()
  concessionEligible?: boolean;

  @ApiPropertyOptional()
  @IfPresent()
  @IsBoolean()
  refundable?: boolean;
}

/** The body of every Phase 3 archive, disable and decision that needs a reason (@Reason). */
export class ReasonDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;
}

// ---------------------------------------------------------------------------- fee structures

export class FeeStructureDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(ID)
  academicYearId: string;

  @ApiProperty(ID)
  classId: string;

  @ApiProperty(ID)
  feeHeadId: string;

  @ApiProperty()
  feeHeadName: string;

  @ApiProperty(RUPEES)
  amount: number;

  @ApiProperty(MONTH)
  effectiveFrom: string;

  @ApiProperty({ enum: FEE_STRUCTURE_STATUSES, enumName: 'FeeStructureStatus' })
  status: FeeStructureStatus;

  /** The row that replaced this one in the same month. */
  @ApiProperty({ ...ID, nullable: true })
  supersededBy: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  supersededAt: Date | null;

  @ApiProperty({ type: String, nullable: true })
  reason: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

/** A head's current amount for a class: its active row with the latest effective month. */
export class FeeStructureHeadDto {
  @ApiProperty(ID)
  feeHeadId: string;

  @ApiProperty()
  name: string;

  @ApiProperty(FREQUENCY)
  frequency: FeeFrequency;

  @ApiProperty(RUPEES)
  amount: number;

  @ApiProperty(MONTH)
  effectiveFrom: string;

  @ApiProperty(ID)
  structureId: string;
}

export class FeeStructureClassDto {
  @ApiProperty(ID)
  classId: string;

  @ApiProperty()
  className: string;

  @ApiProperty({ type: () => FeeStructureHeadDto, isArray: true })
  heads: FeeStructureHeadDto[];

  /** Every row of the class in the year, superseded ones included, newest month first per head. */
  @ApiProperty({ type: () => FeeStructureDto, isArray: true })
  history: FeeStructureDto[];
}

export class ListFeeStructuresQueryDto extends PageQueryDto {
  @ApiProperty(ID)
  @IsIdString()
  academicYearId: string;

  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  classId?: string;
}

/**
 * A same-month row supersedes the active one and needs `reason` (without it the answer is 409
 * FEE_STRUCTURE_EXISTS naming the row); a different month must be later than the latest active.
 */
export class CreateFeeStructureDto {
  @ApiProperty(ID)
  @IsIdString()
  academicYearId: string;

  @ApiProperty(ID)
  @IsIdString()
  classId: string;

  @ApiProperty(ID)
  @IsIdString()
  feeHeadId: string;

  @ApiProperty(RUPEES)
  @Rupees()
  amount: number;

  @ApiProperty(MONTH)
  @IsYearMonth()
  effectiveFrom: string;

  @ApiPropertyOptional({ minLength: 3, maxLength: 500 })
  @IfPresent()
  @Reason()
  reason?: string;
}

export class CopyFeeStructuresDto {
  @ApiProperty(ID)
  @IsIdString()
  fromAcademicYearId: string;

  @ApiProperty(ID)
  @IsIdString()
  toAcademicYearId: string;

  @ApiProperty(MONTH)
  @IsYearMonth()
  effectiveFrom: string;
}

export class CopyFeeStructuresResultDto {
  @ApiProperty({ type: Number, minimum: 0 })
  created: number;

  /** Pairs left alone: no class of that name, the head archived, or the class already priced. */
  @ApiProperty({ type: Number, minimum: 0 })
  skipped: number;
}
