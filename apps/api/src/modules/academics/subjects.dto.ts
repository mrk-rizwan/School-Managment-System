import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import {
  IfPresent,
  IfPresentNotNull,
  NameField,
  NoIdentityNumber,
  QueryBoolean,
  SearchField,
} from '../../common/fields';
import { PageQueryDto } from '../../common/pagination';

// contracts/slice-3.md §5.

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;
const CODE_PATTERN = /^[A-Z0-9-]{1,20}$/;

export class SubjectDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ type: String, nullable: true, pattern: CODE_PATTERN.source })
  code: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  archivedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export const SUBJECT_SORTS = ['name', '-name', 'code', '-code'] as const;
export type SubjectSortValue = (typeof SUBJECT_SORTS)[number];

export class ListSubjectsQueryDto extends PageQueryDto {
  @QueryBoolean({ default: false, description: 'Include archived subjects' })
  includeArchived?: boolean;

  @SearchField('Name contains (case-insensitive), or code starts with')
  q?: string;

  @ApiPropertyOptional({ enum: SUBJECT_SORTS, enumName: 'SubjectSort', default: 'name' })
  @IsOptional()
  @IsIn(SUBJECT_SORTS)
  sort?: SubjectSortValue;
}

/** Trimmed and upper-cased before validation. */
const Code = (): PropertyDecorator =>
  applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.trim().toUpperCase() : value,
    ),
    IsString(),
    Matches(CODE_PATTERN, {
      message: '$property must be 1-20 letters, digits or hyphens',
    }),
    NoIdentityNumber(),
  );

export class CreateSubjectDto {
  @ApiProperty({ minLength: 1, maxLength: 100 })
  @NameField(1, 100)
  name: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: CODE_PATTERN.source,
    description: 'Trimmed and upper-cased',
  })
  @IfPresentNotNull()
  @Code()
  code?: string | null;
}

export class UpdateSubjectDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @IfPresent()
  @NameField(1, 100)
  name?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: CODE_PATTERN.source,
    description: 'Trimmed and upper-cased; null clears',
  })
  @IfPresentNotNull()
  @Code()
  code?: string | null;
}
