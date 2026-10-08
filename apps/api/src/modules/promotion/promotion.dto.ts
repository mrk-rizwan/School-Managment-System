import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, ValidateNested } from 'class-validator';
import {
  ENROLMENT_STATUSES,
  PROMOTION_OUTCOMES,
  PROMOTION_SHEET_STATUSES,
  STUDENT_STATUSES,
  type EnrolmentStatus,
  type PromotionOutcome,
  type PromotionSheetStatus,
  type StudentStatus,
} from '@asms/shared';
import { IfPresent, Reason } from '../../common/fields';
import { IsIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';

// phase-4-academic.md slice 35 (R294-R300, §1.1 rule 30, §3.2 "Promotion"); contracts/slice-35.md.

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;
const NULLABLE_ID = { ...ID, nullable: true } as const;
const NULLABLE_TEXT = { type: String, nullable: true } as const;
const OUTCOME = { enum: PROMOTION_OUTCOMES, enumName: 'PromotionOutcome' } as const;
const NULLABLE_OUTCOME = { ...OUTCOME, nullable: true } as const;
const STATUS = { enum: PROMOTION_SHEET_STATUSES, enumName: 'PromotionSheetStatus' } as const;
const TIMESTAMP = { type: String, format: 'date-time' } as const;
const NULLABLE_TIMESTAMP = { ...TIMESTAMP, nullable: true } as const;
/** A section's roster fits one request (a section is at most a few dozen students). */
const MAX_DECISIONS = 200;

export class OpenPromotionSheetDto {
  /** The year the promoted and detained students move into: planned or active, not this year. */
  @ApiProperty(ID)
  @IsIdString()
  targetYearId: string;
}

export class PromotionSheetDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(ID) academicYearId: string;
  @ApiProperty() academicYearName: string;
  @ApiProperty(ID) classId: string;
  @ApiProperty() className: string;
  @ApiProperty({ description: 'The class is the final class: only its rows may complete (R295)' }) classIsFinal: boolean;
  @ApiProperty(ID) sectionId: string;
  @ApiProperty() sectionName: string;
  @ApiProperty(ID) targetYearId: string;
  @ApiProperty() targetYearName: string;
  @ApiProperty(STATUS) status: PromotionSheetStatus;
  @ApiProperty({ type: 'integer', minimum: 0, description: 'Students on the sheet' }) rows: number;
  @ApiProperty({ type: 'integer', minimum: 0, description: 'Rows still without a decision' }) undecided: number;
  @ApiProperty() openedByName: string;
  @ApiProperty(TIMESTAMP) openedAt: Date;
  @ApiProperty(NULLABLE_TEXT) appliedByName: string | null;
  @ApiProperty(NULLABLE_TIMESTAMP) appliedAt: Date | null;
  @ApiProperty(TIMESTAMP) updatedAt: Date;
}

/** One student's row: the result read, the proposal, the decision and what apply did. */
export class PromotionDecisionDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(ID) enrolmentId: string;
  @ApiProperty(ID) studentId: string;
  @ApiProperty() studentName: string;
  @ApiProperty() admissionNo: string;
  @ApiProperty({ enum: STUDENT_STATUSES, enumName: 'StudentStatus' }) studentStatus: StudentStatus;
  @ApiProperty({ type: 'integer', nullable: true }) rollNo: number | null;
  /** The enrolment's status now: `active` until apply closes it. */
  @ApiProperty({ enum: ENROLMENT_STATUSES, enumName: 'EnrolmentStatus' }) enrolmentStatus: EnrolmentStatus;
  /** The final (or only held term's) result the proposal came from; null when the student has none. */
  @ApiProperty(NULLABLE_ID) resultId: string | null;
  /** The result was superseded since it was read: re-decide the row before apply (R298). */
  @ApiProperty() resultSuperseded: boolean;
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 10000, nullable: true }) percentBp: number | null;
  @ApiProperty(NULLABLE_TEXT) grade: string | null;
  @ApiProperty({ type: Boolean, nullable: true }) passed: boolean | null;
  @ApiProperty(NULLABLE_OUTCOME) proposed: PromotionOutcome | null;
  @ApiProperty(NULLABLE_OUTCOME) decision: PromotionOutcome | null;
  @ApiProperty(NULLABLE_TEXT) reason: string | null;
  @ApiProperty(NULLABLE_ID) targetClassId: string | null;
  @ApiProperty(NULLABLE_TEXT) targetClassName: string | null;
  @ApiProperty(NULLABLE_ID) targetSectionId: string | null;
  @ApiProperty(NULLABLE_TEXT) targetSectionName: string | null;
  /** Money was owed when the sheet opened (the dues endpoint): a flag, never a block. */
  @ApiProperty() arrearsFlag: boolean;
  @ApiProperty(NULLABLE_TEXT) decidedByName: string | null;
  @ApiProperty(NULLABLE_TIMESTAMP) decidedAt: Date | null;
  @ApiProperty(NULLABLE_TIMESTAMP) appliedAt: Date | null;
  /** On an applied sheet: the enrolment had already closed, so apply left the row alone. */
  @ApiProperty() skipped: boolean;
  @ApiProperty(NULLABLE_ID) newEnrolmentId: string | null;
  /** The result was corrected after apply; the enrolments apply opened stand. */
  @ApiProperty() revisedAfterApply: boolean;
}

export class PromotionSheetDetailDto extends PromotionSheetDto {
  @ApiProperty({ type: PromotionDecisionDto, isArray: true, description: 'By roll number, then name' })
  decisions: PromotionDecisionDto[];

  /** The target year has no class yet: create it (and each class's next class) first. */
  @ApiProperty() targetYearHasClasses: boolean;
}

export const PROMOTION_SHEET_SORTS = ['-openedAt', 'openedAt'] as const;
export type PromotionSheetSort = (typeof PROMOTION_SHEET_SORTS)[number];

export class ListPromotionSheetsQueryDto extends PageQueryDto {
  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  academicYearId?: string;

  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  sectionId?: string;

  @ApiPropertyOptional(STATUS)
  @IsOptional()
  @IsIn(PROMOTION_SHEET_STATUSES)
  status?: PromotionSheetStatus;

  @ApiPropertyOptional({ enum: PROMOTION_SHEET_SORTS, enumName: 'PromotionSheetSort', default: '-openedAt' })
  @IsOptional()
  @IsIn(PROMOTION_SHEET_SORTS)
  sort?: PromotionSheetSort;
}

export class PromotionDecisionInputDto {
  @ApiProperty(ID)
  @IsIdString()
  enrolmentId: string;

  @ApiProperty(OUTCOME)
  @IsIn(PROMOTION_OUTCOMES)
  decision: PromotionOutcome;

  /** Required when the decision differs from the proposal or there is none (R295). */
  @ApiPropertyOptional({ minLength: 3, maxLength: 500 })
  @IfPresent()
  @Reason()
  reason?: string;

  /** promote and detain: the class of the target year (omitted: the default for the decision — the next class to promote, this class's namesake to detain). */
  @ApiPropertyOptional(ID)
  @IfPresent()
  @IsIdString()
  targetClassId?: string;

  /** promote and detain: a live section of that class (omitted: the section of the same name, else the class's only section). */
  @ApiPropertyOptional(ID)
  @IfPresent()
  @IsIdString()
  targetSectionId?: string;
}

export class UpdatePromotionSheetDto {
  @ApiProperty({ type: () => PromotionDecisionInputDto, isArray: true, minItems: 1, maxItems: MAX_DECISIONS })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_DECISIONS)
  @ValidateNested({ each: true })
  @Type(() => PromotionDecisionInputDto)
  decisions: PromotionDecisionInputDto[];
}
