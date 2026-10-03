import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  ATTENDANCE_MODES,
  CLASS_STATUSES,
  type AttendanceMode,
  type ClassStatus,
} from '@asms/shared';
import { IfPresent, NameField, SearchField } from '../../common/fields';
import { IsIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';
import { SectionDto } from './sections.dto';

// contracts/slice-3.md §3.

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;

export class ClassDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(ID)
  academicYearId: string;

  @ApiProperty()
  academicYearName: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ type: 'integer' })
  sortOrder: number;

  @ApiProperty({ enum: ATTENDANCE_MODES, enumName: 'AttendanceMode' })
  attendanceMode: AttendanceMode;

  @ApiProperty({ enum: CLASS_STATUSES, enumName: 'ClassStatus' })
  status: ClassStatus;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export const CLASS_SORTS = ['sortOrder', '-sortOrder', 'name', '-name'] as const;
export type ClassSortValue = (typeof CLASS_SORTS)[number];

export class ListClassesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ ...ID, description: 'An id not in the school gives an empty page' })
  @IsOptional()
  @IsIdString()
  academicYearId?: string;

  @ApiPropertyOptional({ enum: CLASS_STATUSES, enumName: 'ClassStatus' })
  @IsOptional()
  @IsIn(CLASS_STATUSES)
  status?: ClassStatus;

  @SearchField('Name contains (case-insensitive)')
  q?: string;

  @ApiPropertyOptional({ enum: CLASS_SORTS, enumName: 'ClassSort', default: 'sortOrder' })
  @IsOptional()
  @IsIn(CLASS_SORTS)
  sort?: ClassSortValue;
}

const SortOrder = (): PropertyDecorator => applyDecorators(IsInt(), Min(0), Max(999));

export class CreateClassDto {
  @ApiProperty(ID)
  @IsIdString()
  academicYearId: string;

  @ApiProperty({ minLength: 1, maxLength: 50 })
  @NameField(1, 50)
  name: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 999, default: 0 })
  @IfPresent()
  @SortOrder()
  sortOrder?: number;

  @ApiProperty({
    enum: ATTENDANCE_MODES,
    enumName: 'AttendanceMode',
    description: 'Rule 14: the school chooses per class; no default',
  })
  @IsIn(ATTENDANCE_MODES)
  attendanceMode: AttendanceMode;
}

export class UpdateClassDto {
  @ApiPropertyOptional({
    ...ID,
    description: 'Changes only while the class has no section (409 CLASS_YEAR_IMMUTABLE)',
  })
  @IfPresent()
  @IsIdString()
  academicYearId?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 50 })
  @IfPresent()
  @NameField(1, 50)
  name?: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 999 })
  @IfPresent()
  @SortOrder()
  sortOrder?: number;

  @ApiPropertyOptional({ enum: ATTENDANCE_MODES, enumName: 'AttendanceMode' })
  @IfPresent()
  @IsIn(ATTENDANCE_MODES)
  attendanceMode?: AttendanceMode;
}

export class CopySectionsDto {
  @ApiProperty({ ...ID, description: 'A class in any year of the school; not this class' })
  @IsIdString()
  fromClassId: string;
}

export class CopySectionsResultDto {
  @ApiProperty({ type: SectionDto, isArray: true })
  created: SectionDto[];

  @ApiProperty({ type: String, isArray: true })
  skippedNames: string[];
}
