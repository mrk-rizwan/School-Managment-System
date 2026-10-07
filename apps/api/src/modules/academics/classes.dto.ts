import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  ATTENDANCE_MODES,
  CLASS_STATUSES,
  DEFAULT_EXAM_MAX_MARKS,
  MAX_ASSESSMENT_MARKS,
  type AttendanceMode,
  type ClassStatus,
} from '@asms/shared';
import { IfPresent, IfPresentNotNull, NameField, Reason, SearchField } from '../../common/fields';
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

  @ApiProperty({
    ...ID,
    nullable: true,
    description: 'Phase 4 (rule 30): the class a passed student is promoted into, usually in the next year',
  })
  nextClassId: string | null;

  @ApiProperty({ type: String, nullable: true })
  nextClassName: string | null;

  @ApiProperty({ description: 'The last class: a passed student completes (alumni). Never with a next class' })
  isFinal: boolean;

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

/** One subject of a class's list (contracts/slice-29.md §4). */
export class ClassSubjectEntryDto {
  @ApiProperty(ID)
  @IsIdString()
  subjectId: string;

  @ApiProperty({ type: 'integer', minimum: 0, maximum: 999, description: 'Print order' })
  @SortOrder()
  sortOrder: number;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: MAX_ASSESSMENT_MARKS,
    default: DEFAULT_EXAM_MAX_MARKS,
    description: "The term exam's default max marks",
  })
  @IfPresent()
  @IsInt()
  @Min(1)
  @Max(MAX_ASSESSMENT_MARKS)
  examMaxMarks?: number;
}

/** A class's subject list holds at most this many subjects. */
export const MAX_CLASS_SUBJECTS = 40;

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

  @ApiPropertyOptional({
    type: ClassSubjectEntryDto,
    isArray: true,
    maxItems: MAX_CLASS_SUBJECTS,
    description:
      "Phase 4: the whole subject list in print order. A live subject left out is archived and needs `reason`; " +
      'refused (409 CLASS_SUBJECT_IN_USE) once it has marks or results, and the list is frozen (409 ' +
      'CLASS_SUBJECTS_FROZEN) while a result sheet of the class is submitted or approved (from waves N and O)',
  })
  @IfPresent()
  @IsArray()
  @ArrayMaxSize(MAX_CLASS_SUBJECTS)
  @ValidateNested({ each: true })
  @Type(() => ClassSubjectEntryDto)
  subjects?: ClassSubjectEntryDto[];

  @ApiPropertyOptional({ ...ID, nullable: true, description: 'Another class of the school, not archived; null clears' })
  @IfPresentNotNull()
  @IsIdString()
  nextClassId?: string | null;

  @ApiPropertyOptional({ description: 'The last class: a passed student completes. A final class has no next class (422 otherwise)' })
  @IfPresent()
  @IsBoolean()
  isFinal?: boolean;

  @ApiPropertyOptional({ minLength: 3, maxLength: 500, description: 'Required when the subject list archives a subject' })
  @IfPresent()
  @Reason()
  reason?: string;
}

export class ClassSubjectDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(ID)
  classId: string;

  @ApiProperty(ID)
  subjectId: string;

  @ApiProperty()
  subjectName: string;

  @ApiProperty({ type: String, nullable: true })
  subjectCode: string | null;

  @ApiProperty({ type: 'integer', minimum: 0, maximum: 999 })
  sortOrder: number;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: MAX_ASSESSMENT_MARKS })
  examMaxMarks: number;
}

export const CLASS_SUBJECT_SORTS = ['sortOrder', '-sortOrder'] as const;
export type ClassSubjectSortValue = (typeof CLASS_SUBJECT_SORTS)[number];

export class ListClassSubjectsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: CLASS_SUBJECT_SORTS, enumName: 'ClassSubjectSort', default: 'sortOrder' })
  @IsOptional()
  @IsIn(CLASS_SUBJECT_SORTS)
  sort?: ClassSubjectSortValue;
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
