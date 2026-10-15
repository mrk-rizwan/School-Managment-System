import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { CONTRACT_TYPES, type ContractType } from '@asms/shared';
import { IfPresent, IsCalendarDate, SearchField } from '../../../common/fields';
import { PageQueryDto } from '../../../common/pagination';
import { CsvFormatField, type CsvFormat } from '../../../common/report-export';

// Phase 5 slice 42 (rule 38, R337; contracts/slice-42.md §1.4): the staff report — per member,
// attendance in a window, approved leave taken, and the newest contract's standing.

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;
const DATE = { type: String, format: 'date' } as const;

export const STAFF_REPORT_SORTS = ['staffName'] as const;
/** The newest contract: none on file, in force, past its end date but not ended (a warning), or ended. */
export const STAFF_CONTRACT_STANDINGS = ['none', 'live', 'expired_not_ended', 'ended'] as const;
export type StaffContractStanding = (typeof STAFF_CONTRACT_STANDINGS)[number];

/** A contract ending within this many days is flagged (R337). */
export const CONTRACT_ENDING_SOON_DAYS = 60;

export class StaffReportQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ ...DATE, description: 'Default: 1 January of the school year to date (calendar year)' })
  @IfPresent()
  @IsCalendarDate()
  from?: string;

  @ApiPropertyOptional({ ...DATE, description: 'Default: today; at most 366 days after from' })
  @IfPresent()
  @IsCalendarDate()
  to?: string;

  @SearchField('Part of the name')
  staffName?: string;

  @ApiPropertyOptional({ enum: STAFF_REPORT_SORTS, enumName: 'StaffReportSort', default: 'staffName' })
  @IsOptional()
  @IsIn(STAFF_REPORT_SORTS)
  sort?: (typeof STAFF_REPORT_SORTS)[number];

  @CsvFormatField() format?: CsvFormat;
}

export class StaffReportRowDto {
  @ApiProperty(ID) staffId: string;
  @ApiProperty() fullName: string;
  @ApiProperty({ type: String, nullable: true }) designation: string | null;
  @ApiProperty({ enum: ['active', 'suspended', 'left'], enumName: 'StaffStatus' }) status: 'active' | 'suspended' | 'left';
  @ApiProperty({ type: 'integer', minimum: 0 }) present: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) late: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) absent: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) onLeave: number;
  /** (present + late) ÷ (present + late + absent), one decimal; null when nothing is recorded. */
  @ApiProperty({ type: Number, nullable: true }) attendancePercent: number | null;
  /** Working days of approved leave starting in the window. */
  @ApiProperty({ type: 'integer', minimum: 0 }) leaveTakenDays: number;
  @ApiProperty({ enum: STAFF_CONTRACT_STANDINGS, enumName: 'StaffContractStanding' }) contractStatus: StaffContractStanding;
  @ApiProperty({ enum: CONTRACT_TYPES, enumName: 'ContractType', nullable: true }) contractType: ContractType | null;
  @ApiProperty({ ...DATE, nullable: true }) contractEndsOn: string | null;
  /** A live contract whose end date is within 60 days of today. */
  @ApiProperty() contractEndingSoon: boolean;
}

export class StaffReportDto {
  @ApiProperty(DATE) from: string;
  @ApiProperty(DATE) to: string;
  @ApiProperty({ type: () => StaffReportRowDto, isArray: true }) data: StaffReportRowDto[];
  @ApiProperty({ type: 'integer', minimum: 1 }) page: number;
  @ApiProperty({ type: 'integer', minimum: 1, maximum: 50 }) limit: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) total: number;
}
