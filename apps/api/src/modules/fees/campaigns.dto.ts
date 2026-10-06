import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, ValidateNested } from 'class-validator';
import { CAMPAIGN_STATUSES, MAX_RUPEES, type CampaignStatus } from '@asms/shared';
import { IfPresent, IfPresentNotNull, IsCalendarDate, NameField, Reason, Rupees, TextField } from '../../common/fields';
import { IsIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';
import type { CampaignAudienceKind } from '../../repositories/charge-campaign.repository';

// phase-3-financial.md slice 19 (R184): a campaign charges one fee to a chosen audience of
// students, once, through the slice-14 resolver's student kinds.

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;
const DATE = { type: String, format: 'date' } as const;
const DATE_TIME = { type: String, format: 'date-time' } as const;
const RUPEES = { type: Number, minimum: 1, maximum: MAX_RUPEES, description: 'Whole rupees' } as const;

export const CAMPAIGN_AUDIENCE_KINDS = ['everyone', 'students', 'class', 'section', 'student'] as const satisfies readonly CampaignAudienceKind[];

export class CampaignAudienceDto {
  @ApiProperty({ enum: CAMPAIGN_AUDIENCE_KINDS, enumName: 'CampaignAudienceKind' })
  @IsIn(CAMPAIGN_AUDIENCE_KINDS)
  kind: CampaignAudienceKind;

  @ApiPropertyOptional({ ...ID, description: 'Required for class, section and student; forbidden otherwise' })
  @IfPresent()
  @IsIdString()
  targetId?: string;
}

/** 1-20 items; the shape rules (everyone alone, targets by kind, no repeats) are the service's. */
const Audiences = (): PropertyDecorator =>
  applyDecorators(
    ApiProperty({ type: () => CampaignAudienceDto, isArray: true, minItems: 1, maxItems: 20 }),
    IsArray(),
    ArrayMinSize(1),
    ArrayMaxSize(20),
    ValidateNested({ each: true }),
    Type(() => CampaignAudienceDto),
  );

export class CampaignDto {
  @ApiProperty(ID) id: string;
  @ApiProperty() name: string;
  @ApiProperty(ID) academicYearId: string;
  @ApiProperty(ID) feeHeadId: string;
  @ApiProperty() feeHeadName: string;
  @ApiProperty(RUPEES) amount: number;
  @ApiProperty(DATE) dueOn: string;
  @ApiProperty({ type: String, nullable: true }) description: string | null;
  @ApiProperty() applyConcessions: boolean;
  @ApiProperty({ enum: CAMPAIGN_STATUSES, enumName: 'CampaignStatus' }) status: CampaignStatus;
  @ApiProperty({ type: () => CampaignAudienceDto, isArray: true }) audiences: CampaignAudienceDto[];
  @ApiProperty(ID) createdByUserId: string;
  @ApiProperty(DATE_TIME) createdAt: Date;
  @ApiProperty({ ...DATE_TIME, nullable: true }) generatedAt: Date | null;
  @ApiProperty({ type: Number, nullable: true }) generatedCount: number | null;
  @ApiProperty({ ...DATE_TIME, nullable: true }) cancelledAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) cancelReason: string | null;
}

export class ListCampaignsQueryDto extends PageQueryDto {
  @ApiPropertyOptional(ID) @IsOptional() @IsIdString() academicYearId?: string;

  @ApiPropertyOptional({ enum: CAMPAIGN_STATUSES, enumName: 'CampaignStatus' })
  @IsOptional()
  @IsIn(CAMPAIGN_STATUSES)
  status?: CampaignStatus;

  @ApiPropertyOptional({ enum: ['-createdAt'], default: '-createdAt' })
  @IsOptional()
  @IsIn(['-createdAt'])
  sort?: '-createdAt';
}

export class CreateCampaignDto {
  @ApiProperty({ minLength: 1, maxLength: 120 })
  @NameField(1, 120)
  name: string;

  @ApiProperty(ID) @IsIdString() academicYearId: string;

  @ApiProperty({ ...ID, description: 'A per-term or ad hoc head' })
  @IsIdString()
  feeHeadId: string;

  @ApiProperty(RUPEES) @Rupees(1) amount: number;

  @ApiProperty({ ...DATE, description: 'Inside the academic year' })
  @IsCalendarDate()
  dueOn: string;

  @ApiPropertyOptional({ type: String, nullable: true, minLength: 1, maxLength: 500 })
  @IfPresentNotNull()
  @TextField(1, 500)
  description?: string | null;

  @ApiPropertyOptional({ default: false, description: "Apply each student's approved concession on the head" })
  @IfPresent()
  @IsBoolean()
  applyConcessions?: boolean;

  @Audiences()
  audiences: CampaignAudienceDto[];
}

/** A draft's fields; the audience, when sent, replaces the whole set. */
export class UpdateCampaignDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 120 })
  @IfPresent()
  @NameField(1, 120)
  name?: string;

  @ApiPropertyOptional(ID) @IfPresent() @IsIdString() feeHeadId?: string;
  @ApiPropertyOptional(RUPEES) @IfPresent() @Rupees(1) amount?: number;
  @ApiPropertyOptional(DATE) @IfPresent() @IsCalendarDate() dueOn?: string;

  @ApiPropertyOptional({ type: String, nullable: true, minLength: 1, maxLength: 500 })
  @IfPresentNotNull()
  @TextField(1, 500)
  description?: string | null;

  @ApiPropertyOptional() @IfPresent() @IsBoolean() applyConcessions?: boolean;

  @ApiPropertyOptional({ type: () => CampaignAudienceDto, isArray: true, minItems: 1, maxItems: 20 })
  @IfPresent()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CampaignAudienceDto)
  audiences?: CampaignAudienceDto[];
}

export class PreviewCampaignTargetsDto {
  @ApiProperty(ID) @IsIdString() academicYearId: string;
  @ApiProperty(ID) @IsIdString() feeHeadId: string;
  @ApiProperty(RUPEES) @Rupees(1) amount: number;

  @ApiPropertyOptional({ default: false })
  @IfPresent()
  @IsBoolean()
  applyConcessions?: boolean;

  @Audiences()
  audiences: CampaignAudienceDto[];
}

export class CampaignTargetCountsDto {
  @ApiProperty({ type: Number, minimum: 0 }) students: number;
  @ApiProperty({ type: Number, minimum: 0 }) enrolments: number;
}

export class CampaignConcessionPreviewDto {
  @ApiProperty({ type: Number, minimum: 0 }) affected: number;
  @ApiProperty({ type: Number, minimum: 0 }) totalReduction: number;
}

export class CampaignPreviewDto {
  @ApiProperty({ type: () => CampaignTargetCountsDto }) targets: CampaignTargetCountsDto;
  @ApiProperty({ type: () => CampaignConcessionPreviewDto }) concessions: CampaignConcessionPreviewDto;
}

export class CancelCampaignDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;
}
