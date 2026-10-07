import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { IfPresent, IsCalendarDate, NameField, Reason } from '../../common/fields';
import { IsIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';

// contracts/slice-29.md §2 (phase-4-academic.md slice 29).

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;
const DATE = { type: String, format: 'date', example: '2026-04-01' } as const;

/** A class the term is not held for (§1.1). */
export class TermSkipDto {
  @ApiProperty(ID)
  classId: string;

  @ApiProperty()
  className: string;

  @ApiProperty()
  reason: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

export class TermDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(ID)
  academicYearId: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: 6, description: 'The rank by date in the year' })
  sortOrder: number;

  @ApiProperty(DATE)
  startsOn: string;

  @ApiProperty(DATE)
  endsOn: string;

  @ApiProperty({ type: 'integer', minimum: 0, maximum: 100, description: "The term's share of the final result, %" })
  weight: number;

  @ApiProperty({ description: 'False for the two terms seeded with the year' })
  createdByUser: boolean;

  @ApiProperty({ type: TermSkipDto, isArray: true, description: 'Classes the term is not held for' })
  skippedClasses: TermSkipDto[];

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export const TERM_SORTS = ['sortOrder', '-sortOrder'] as const;
export type TermSortValue = (typeof TERM_SORTS)[number];

export class ListTermsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: TERM_SORTS, enumName: 'TermSort', default: 'sortOrder' })
  @IsOptional()
  @IsIn(TERM_SORTS)
  sort?: TermSortValue;
}

export class CreateTermDto {
  @ApiProperty({ minLength: 1, maxLength: 40 })
  @NameField(1, 40)
  name: string;

  @ApiProperty(DATE)
  @IsCalendarDate()
  startsOn: string;

  @ApiProperty(DATE)
  @IsCalendarDate()
  endsOn: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    maximum: 100,
    description: "Default: what the year's other terms leave of 100 (never below 0); their weights are unchanged",
  })
  @IfPresent()
  @IsInt()
  @Min(0)
  @Max(100)
  weight?: number;
}

export class UpdateTermDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 40 })
  @IfPresent()
  @NameField(1, 40)
  name?: string;

  @ApiPropertyOptional(DATE)
  @IfPresent()
  @IsCalendarDate()
  startsOn?: string;

  @ApiPropertyOptional(DATE)
  @IfPresent()
  @IsCalendarDate()
  endsOn?: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 100 })
  @IfPresent()
  @IsInt()
  @Min(0)
  @Max(100)
  weight?: number;
}

export class SkipClassDto {
  @ApiProperty(ID)
  @IsIdString()
  classId: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;
}
