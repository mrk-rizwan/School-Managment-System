import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { IsCalendarDate } from '../../common/fields';
import { PageQueryDto } from '../../common/pagination';
import { CsvFormatField, type CsvFormat } from '../../common/report-export';
import { DISCREPANCY_KINDS, type DiscrepancyKind } from '../../repositories/attendance-report.repository';

// Phase 5 slice 42 (rule 38, R335; contracts/slice-42.md §1.5): the attendance discrepancy report.

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;
const DATE = { type: String, format: 'date' } as const;
export const DISCREPANCY_SORTS = ['-date'] as const;

export class DiscrepanciesQueryDto extends PageQueryDto {
  @ApiProperty({ ...DATE, description: 'Inclusive; at most 92 days before to' }) @IsCalendarDate() from: string;
  @ApiProperty({ ...DATE, description: 'Inclusive' }) @IsCalendarDate() to: string;

  @ApiPropertyOptional({ enum: DISCREPANCY_KINDS, enumName: 'DiscrepancyKind', description: 'Default: both kinds' })
  @IsOptional()
  @IsIn(DISCREPANCY_KINDS)
  kind?: DiscrepancyKind;

  @ApiPropertyOptional({ enum: DISCREPANCY_SORTS, enumName: 'DiscrepancySort', default: '-date' })
  @IsOptional()
  @IsIn(DISCREPANCY_SORTS)
  sort?: (typeof DISCREPANCY_SORTS)[number];

  @CsvFormatField() format?: CsvFormat;
}

export class DiscrepancyDto {
  /**
   * `mixed_day`: the student was present (or late) in one period and absent in another that day,
   * with no arrival recorded. `amended_register`: the register's marks were amended more than once.
   */
  @ApiProperty({ enum: DISCREPANCY_KINDS, enumName: 'DiscrepancyKind' }) kind: DiscrepancyKind;
  @ApiProperty(DATE) date: string;
  @ApiProperty({ ...ID, nullable: true }) studentId: string | null;
  @ApiProperty({ type: String, nullable: true }) studentName: string | null;
  @ApiProperty(ID) classId: string;
  @ApiProperty() className: string;
  @ApiProperty(ID) sectionId: string;
  @ApiProperty() sectionName: string;
  @ApiProperty({ type: 'integer', nullable: true, description: 'amended_register: the register period' }) period: number | null;
  @ApiProperty({ type: 'integer', isArray: true }) presentPeriods: number[];
  @ApiProperty({ type: 'integer', isArray: true }) absentPeriods: number[];
  @ApiProperty({ type: 'integer', nullable: true }) amendments: number | null;
}
