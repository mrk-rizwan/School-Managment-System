import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { GRADE_LABEL_MAX, MAX_GRADE_BANDS, PASS_RULES, type PassRule } from '@asms/shared';
import { IfPresent } from '../../common/fields';

// contracts/slice-29.md §3 (phase-4-academic.md §3.7).

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;

export class GradeBandDto {
  @ApiProperty({ minLength: 1, maxLength: GRADE_LABEL_MAX, pattern: '^[A-Za-z0-9+-]{1,4}$', example: 'A+' })
  @IsString()
  @Matches(/^[A-Za-z0-9+-]{1,4}$/, { message: 'A grade is 1-4 letters, digits, + or -' })
  grade: string;

  @ApiProperty({ type: 'integer', minimum: 0, maximum: 100, description: 'A percentage at or above it earns the grade' })
  @IsInt()
  @Min(0)
  @Max(100)
  minPercent: number;
}

export class ResultSettingsDto {
  @ApiProperty(ID)
  academicYearId: string;

  @ApiProperty({ type: 'integer', minimum: 0, maximum: 100, description: 'Class tests, %; with examWeight sums to 100' })
  testWeight: number;

  @ApiProperty({ type: 'integer', minimum: 0, maximum: 100 })
  examWeight: number;

  @ApiProperty({ type: 'integer', minimum: 0, maximum: 100, description: 'The pass mark per subject, %' })
  passPercent: number;

  @ApiProperty({ enum: PASS_RULES, enumName: 'PassRule' })
  passRule: PassRule;

  @ApiProperty({ type: GradeBandDto, isArray: true, description: 'Descending minimums; the last at 0' })
  bands: GradeBandDto[];

  @ApiProperty()
  showPosition: boolean;

  @ApiProperty()
  showAttendance: boolean;

  @ApiProperty()
  showRemark: boolean;

  @ApiProperty({ description: 'Withhold the report card from the family until dues are cleared' })
  withholdCardForDues: boolean;

  @ApiProperty({ description: 'Tell the family by app when a class test is marked (never SMS)' })
  notifyClassTests: boolean;

  @ApiProperty({
    description:
      'True once any result sheet of the year is approved: the settings are then frozen (from wave O; always false before)',
  })
  locked: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

/** Given fields only. testWeight + examWeight must sum to 100 after the merge. */
export class UpdateResultSettingsDto {
  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 100 })
  @IfPresent()
  @IsInt()
  @Min(0)
  @Max(100)
  testWeight?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 100 })
  @IfPresent()
  @IsInt()
  @Min(0)
  @Max(100)
  examWeight?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 100 })
  @IfPresent()
  @IsInt()
  @Min(0)
  @Max(100)
  passPercent?: number;

  @ApiPropertyOptional({ enum: PASS_RULES, enumName: 'PassRule' })
  @IfPresent()
  @IsIn(PASS_RULES)
  passRule?: PassRule;

  @ApiPropertyOptional({
    type: GradeBandDto,
    isArray: true,
    minItems: 1,
    maxItems: MAX_GRADE_BANDS,
    description: 'The whole table: descending minimums, unique grades, the last at 0',
  })
  @IfPresent()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_GRADE_BANDS)
  @ValidateNested({ each: true })
  @Type(() => GradeBandDto)
  bands?: GradeBandDto[];

  @ApiPropertyOptional()
  @IfPresent()
  @IsBoolean()
  showPosition?: boolean;

  @ApiPropertyOptional()
  @IfPresent()
  @IsBoolean()
  showAttendance?: boolean;

  @ApiPropertyOptional()
  @IfPresent()
  @IsBoolean()
  showRemark?: boolean;

  @ApiPropertyOptional()
  @IfPresent()
  @IsBoolean()
  withholdCardForDues?: boolean;

  @ApiPropertyOptional()
  @IfPresent()
  @IsBoolean()
  notifyClassTests?: boolean;
}
