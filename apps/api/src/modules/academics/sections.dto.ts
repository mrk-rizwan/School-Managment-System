import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { IfPresent, IfPresentNotNull, NameField, QueryBoolean } from '../../common/fields';
import { PageQueryDto } from '../../common/pagination';
import type { SectionRecord } from '../../repositories/section.repository';

// contracts/slice-3.md §4.

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;

export class SectionDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(ID)
  classId: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ type: 'integer', nullable: true, description: 'Informational in Phase 1' })
  capacity: number | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  archivedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export function toSectionDto(section: SectionRecord): SectionDto {
  return {
    id: section.id.toString(),
    classId: section.classId.toString(),
    name: section.name,
    capacity: section.capacity,
    archivedAt: section.deletedAt,
    createdAt: section.createdAt,
    updatedAt: section.updatedAt,
  };
}

export const SECTION_SORTS = ['name', '-name'] as const;
export type SectionSortValue = (typeof SECTION_SORTS)[number];

export class ListSectionsQueryDto extends PageQueryDto {
  @QueryBoolean({ default: false, description: 'Include archived sections' })
  includeArchived?: boolean;

  @ApiPropertyOptional({ enum: SECTION_SORTS, enumName: 'SectionSort', default: 'name' })
  @IsOptional()
  @IsIn(SECTION_SORTS)
  sort?: SectionSortValue;
}

const Capacity = (): PropertyDecorator => applyDecorators(IsInt(), Min(1), Max(200));

export class CreateSectionDto {
  @ApiProperty({ minLength: 1, maxLength: 20 })
  @NameField(1, 20)
  name: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 200, nullable: true })
  @IfPresentNotNull()
  @Capacity()
  capacity?: number | null;
}

export class UpdateSectionDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 20 })
  @IfPresent()
  @NameField(1, 20)
  name?: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 200,
    nullable: true,
    description: 'null clears',
  })
  @IfPresentNotNull()
  @Capacity()
  capacity?: number | null;
}
