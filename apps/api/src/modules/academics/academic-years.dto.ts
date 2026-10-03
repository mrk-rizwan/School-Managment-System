import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, ValidateBy } from 'class-validator';
import { ACADEMIC_YEAR_STATUSES, type AcademicYearStatus } from '@asms/shared';
import { IfPresent, NameField } from '../../common/fields';
import { PageQueryDto } from '../../common/pagination';

// contracts/slice-3.md §2.

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` and a real calendar date (no 2026-02-30). */
const IsCalendarDate = (): PropertyDecorator =>
  ValidateBy({
    name: 'isCalendarDate',
    validator: {
      validate: (value: unknown) => {
        if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
        const date = new Date(`${value}T00:00:00.000Z`);
        // An impossible day is either Invalid Date or rolled into the next month.
        return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
      },
      defaultMessage: () => '$property must be a real date in the form YYYY-MM-DD',
    },
  });

export class AcademicYearDto {
  @ApiProperty({ type: String, pattern: '^[1-9][0-9]{0,18}$' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ type: String, format: 'date' })
  startsOn: string;

  @ApiProperty({ type: String, format: 'date' })
  endsOn: string;

  @ApiProperty({ enum: ACADEMIC_YEAR_STATUSES, enumName: 'AcademicYearStatus' })
  status: AcademicYearStatus;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export const ACADEMIC_YEAR_SORTS = ['-startsOn', 'startsOn', 'name', '-name'] as const;
export type AcademicYearSortValue = (typeof ACADEMIC_YEAR_SORTS)[number];

export class ListAcademicYearsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ACADEMIC_YEAR_STATUSES, enumName: 'AcademicYearStatus' })
  @IsOptional()
  @IsIn(ACADEMIC_YEAR_STATUSES)
  status?: AcademicYearStatus;

  @ApiPropertyOptional({
    enum: ACADEMIC_YEAR_SORTS,
    enumName: 'AcademicYearSort',
    default: '-startsOn',
  })
  @IsOptional()
  @IsIn(ACADEMIC_YEAR_SORTS)
  sort?: AcademicYearSortValue;
}

export class CreateAcademicYearDto {
  @ApiProperty({ minLength: 2, maxLength: 50, description: 'e.g. 2026-27 or Sept 2026' })
  @NameField(2, 50)
  name: string;

  @ApiProperty({ type: String, format: 'date' })
  @IsCalendarDate()
  startsOn: string;

  @ApiProperty({
    type: String,
    format: 'date',
    description: 'After startsOn, and at most 731 days after it',
  })
  @IsCalendarDate()
  endsOn: string;
}

export class UpdateAcademicYearDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 50 })
  @IfPresent()
  @NameField(2, 50)
  name?: string;

  @ApiPropertyOptional({ type: String, format: 'date' })
  @IfPresent()
  @IsCalendarDate()
  startsOn?: string;

  @ApiPropertyOptional({ type: String, format: 'date' })
  @IfPresent()
  @IsCalendarDate()
  endsOn?: string;
}
