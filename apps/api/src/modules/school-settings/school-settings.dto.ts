import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, Max, Min } from 'class-validator';
import { MAX_FEE_DUE_DAY, MIN_FEE_DUE_DAY } from '@asms/shared';
import { IfPresent } from '../../common/fields';

// contracts/slice-2.md §6.

export class SchoolSettingsDto {
  @ApiProperty({ type: Number, minimum: MIN_FEE_DUE_DAY, maximum: MAX_FEE_DUE_DAY })
  feeDueDay: number;

  @ApiProperty()
  studentLoginEnabled: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

/** Absent = unchanged; `null` is 422 (neither can be cleared). An empty body changes nothing. */
export class UpdateSchoolSettingsDto {
  @ApiPropertyOptional({ type: Number, minimum: MIN_FEE_DUE_DAY, maximum: MAX_FEE_DUE_DAY })
  @IfPresent()
  @IsInt()
  @Min(MIN_FEE_DUE_DAY)
  @Max(MAX_FEE_DUE_DAY)
  feeDueDay?: number;

  @ApiPropertyOptional()
  @IfPresent()
  @IsBoolean()
  studentLoginEnabled?: boolean;
}
