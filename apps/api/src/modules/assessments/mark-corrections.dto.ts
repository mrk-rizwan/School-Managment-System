import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min, ValidateIf } from 'class-validator';
import { ASSESSMENT_KINDS, MAX_ASSESSMENT_MARKS, type AssessmentKind } from '@asms/shared';
import { Reason } from '../../common/fields';
import { IsIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';
import { ResultDto } from '../results/results.dto';

// contracts/slice-32.md §1, §2 (phase-4-academic.md slice 32, R280, R281): a correction of a mark
// on a published result. Prefixed MarkCorrection… (no collision with attendance's types, §5.1).

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;
const DATE = { type: String, format: 'date', example: '2026-05-10' } as const;

export const MARK_CORRECTION_STATES = ['pending', 'approved', 'rejected'] as const;
export type MarkCorrectionState = (typeof MARK_CORRECTION_STATES)[number];
const STATE = { enum: MARK_CORRECTION_STATES, enumName: 'MarkCorrectionState' } as const;

/** POST /marks/:id/correct: a mark, or an absence, and why. */
export class CorrectMarkDto {
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    maximum: MAX_ASSESSMENT_MARKS,
    nullable: true,
    description: 'The corrected mark; omit (or null) with absent: true',
  })
  @ValidateIf((_o, value) => value !== undefined && value !== null)
  @IsInt()
  @Min(0)
  @Max(MAX_ASSESSMENT_MARKS)
  obtained?: number | null;

  @ApiPropertyOptional({ default: false, description: 'True: the student was absent (no mark)' })
  @IsOptional()
  @IsBoolean()
  absent?: boolean;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;
}

export class ListMarkCorrectionsQueryDto extends PageQueryDto {
  @ApiPropertyOptional(STATE)
  @IsOptional()
  @IsIn(MARK_CORRECTION_STATES)
  status?: MarkCorrectionState;

  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  sectionId?: string;

  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  termId?: string;
}

export class MarkCorrectionValueDto {
  @ApiProperty({ type: 'integer', nullable: true }) obtained: number | null;
  @ApiProperty() absent: boolean;
  @ApiProperty() excused: boolean;
}

export class MarkCorrectionDto {
  @ApiProperty({ ...ID, description: 'The correction row (a mark born pending)' }) id: string;
  @ApiProperty(STATE) status: MarkCorrectionState;
  @ApiProperty(ID) assessmentId: string;
  @ApiProperty() assessmentName: string;
  @ApiProperty({ enum: ASSESSMENT_KINDS, enumName: 'AssessmentKind' }) kind: AssessmentKind;
  @ApiProperty() subjectName: string;
  @ApiProperty(DATE) heldOn: string;
  @ApiProperty(ID) classId: string;
  @ApiProperty() className: string;
  @ApiProperty(ID) sectionId: string;
  @ApiProperty() sectionName: string;
  @ApiProperty(ID) termId: string;
  @ApiProperty() termName: string;
  @ApiProperty(ID) enrolmentId: string;
  @ApiProperty(ID) studentId: string;
  @ApiProperty() studentName: string;
  @ApiProperty() admissionNo: string;
  @ApiProperty({ type: 'integer' }) maxMarks: number;
  @ApiProperty({ type: () => MarkCorrectionValueDto, nullable: true, description: 'The mark it corrects' })
  from: MarkCorrectionValueDto | null;
  @ApiProperty({ type: () => MarkCorrectionValueDto, description: 'The corrected value' })
  to: MarkCorrectionValueDto;
  @ApiProperty() reason: string;
  @ApiProperty() requestedByName: string;
  @ApiProperty({ description: 'The caller asked for it (and so cannot approve it, R281)' })
  requestedByMe: boolean;
  @ApiProperty({ type: String, format: 'date-time' }) requestedAt: Date;
  @ApiProperty({ type: String, nullable: true }) decidedByName: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) decidedAt: Date | null;
  @ApiProperty({ description: 'Rejected by its own requester (POST /mark-corrections/:id/withdraw)' })
  withdrawn: boolean;
}

/** POST /mark-corrections/:id/approve: the decided correction and the student's revised term card. */
export class MarkCorrectionDecisionDto {
  @ApiProperty({ type: () => MarkCorrectionDto }) mark: MarkCorrectionDto;
  @ApiProperty({ type: () => ResultDto, description: "The corrected student's new term result (version n+1)" })
  revisedResult: ResultDto;
}
