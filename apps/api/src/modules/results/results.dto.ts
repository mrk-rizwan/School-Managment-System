import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  Matches,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  PASS_RULES,
  RESULT_SHEET_STATUSES,
  RESULT_SUBJECT_STATUSES,
  TERM_REMARK_MAX,
  type PassRule,
  type ResultSheetStatus,
  type ResultSubjectStatus,
} from '@asms/shared';
import { IfPresentNotNull, NO_CONTROL, TextField } from '../../common/fields';
import { IsIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';
import { OWN_CHILD_ROLES, type OwnChildRole } from '../../repositories/result.repository';

// contracts/slice-31.md §1-§3 (phase-4-academic.md slice 31). Percentages are basis points
// (7850 = 78.50 %); attendance too (92.3 % = 9230).

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;
const BP = { type: 'integer', minimum: 0, maximum: 10000 } as const;
const STATUS = { enum: RESULT_SHEET_STATUSES, enumName: 'ResultSheetStatus' } as const;
const DATE_TIME = { type: String, format: 'date-time', nullable: true } as const;

/** A section's at most 200 students, as the marks grid. */
export const MAX_REMARKS = 200;

export class OwnChildFlagDto {
  @ApiProperty(ID) userId: string;
  @ApiProperty({ enum: OWN_CHILD_ROLES, enumName: 'OwnChildRole' }) role: OwnChildRole;
  @ApiProperty({ description: "The user's display name" }) userName: string;
}

export class ResultSheetDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(ID) academicYearId: string;
  @ApiProperty({ ...ID, nullable: true, description: 'Null for the final sheet of the year' })
  termId: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "The term's name; null for the final sheet",
  })
  termName: string | null;
  @ApiProperty({ description: 'The final sheet of the year (no term)' }) isFinal: boolean;
  @ApiProperty(ID) classId: string;
  @ApiProperty() className: string;
  @ApiProperty(ID) sectionId: string;
  @ApiProperty() sectionName: string;
  @ApiProperty({ type: 'integer', minimum: 1 }) version: number;
  @ApiProperty(STATUS) status: ResultSheetStatus;
  @ApiProperty(DATE_TIME) submittedAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) submittedByName: string | null;
  @ApiProperty({ description: 'The caller submitted it' }) submittedByMe: boolean;
  @ApiProperty({
    description: "Submitted under a cover assignment (the class teacher's cover, R175)",
  })
  cover: boolean;
  @ApiProperty(DATE_TIME) decidedAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) decidedByName: string | null;
  @ApiProperty({ description: 'Approved by its own submitter, the sole principal (§1.1)' })
  selfApproved: boolean;
  @ApiProperty({ type: String, nullable: true }) returnReason: string | null;
  @ApiProperty(DATE_TIME) publishedAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) publishedByName: string | null;
  @ApiProperty({
    type: () => OwnChildFlagDto,
    isArray: true,
    description:
      'A guardian of a student on the sheet among its contributors (mark authors, the remark writer, the submitter, the caller as approver), recomputed from live rows (R276); distinct by user and role. In the list, carried only by `status=submitted` (the approvals queue, paged at most 10); other lists carry none',
  })
  ownChildFlags: OwnChildFlagDto[];
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt: Date;
}

export class ResultPreviewSubjectDto {
  @ApiProperty(ID) classSubjectId: string;
  @ApiProperty() subjectName: string;
  @ApiProperty({ ...BP, nullable: true }) testBp: number | null;
  @ApiProperty({ ...BP, nullable: true }) examBp: number | null;
  @ApiProperty({ type: 'integer', nullable: true }) examObtained: number | null;
  @ApiProperty({ type: 'integer', nullable: true }) examMax: number | null;
  @ApiProperty() examAbsent: boolean;
  @ApiProperty() examExcused: boolean;
  @ApiProperty({ ...BP, nullable: true }) percentBp: number | null;
  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'Printed obtained = round(percent × max)',
  })
  obtained: number | null;
  @ApiProperty({ type: 'integer', minimum: 1 }) max: number;
  @ApiProperty({ type: String, nullable: true }) grade: string | null;
  @ApiProperty({ enum: RESULT_SUBJECT_STATUSES, enumName: 'ResultSubjectStatus' })
  status: ResultSubjectStatus;
  @ApiProperty({
    ...ID,
    nullable: true,
    description: "A mark author of the subject who is the student's guardian",
  })
  ownChildOf: string | null;
}

export class ResultPreviewRowDto {
  @ApiProperty(ID) enrolmentId: string;
  @ApiProperty(ID) studentId: string;
  @ApiProperty() fullName: string;
  @ApiProperty() admissionNo: string;
  @ApiProperty({ type: 'integer', nullable: true }) rollNo: number | null;
  @ApiProperty({ type: 'integer' }) totalObtained: number;
  @ApiProperty({ type: 'integer' }) totalMax: number;
  @ApiProperty({ ...BP, nullable: true }) percentBp: number | null;
  @ApiProperty({ type: String, nullable: true }) grade: string | null;
  @ApiProperty({ type: Boolean, nullable: true, description: 'Null when nothing is assessed' })
  passed: boolean | null;
  @ApiProperty({ type: 'integer', minimum: 0 }) failedSubjects: number;
  @ApiProperty({ type: 'integer', nullable: true }) position: number | null;
  @ApiProperty({ type: 'integer', nullable: true }) positionOf: number | null;
  @ApiProperty({ ...BP, nullable: true, description: '92.3 % = 9230' }) attendanceBp: number | null;
  @ApiProperty({ type: String, nullable: true }) remark: string | null;
  @ApiProperty({ type: () => OwnChildFlagDto, isArray: true }) ownChildFlags: OwnChildFlagDto[];
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Assessments applying to the student with no mark yet',
  })
  missing: number;
  @ApiProperty({ type: () => ResultPreviewSubjectDto, isArray: true })
  subjects: ResultPreviewSubjectDto[];
}

export class ResultSheetSubjectDto {
  @ApiProperty(ID) classSubjectId: string;
  @ApiProperty() subjectName: string;
  @ApiProperty({ type: 'integer' }) sortOrder: number;
}

export class ResultSheetGapDto {
  @ApiProperty(ID) enrolmentId: string;
  @ApiProperty(ID) assessmentId: string;
}

export class ResultSheetSettingsDto {
  @ApiProperty({ type: 'integer', nullable: true }) testWeight: number | null;
  @ApiProperty({ type: 'integer', nullable: true }) examWeight: number | null;
  @ApiProperty({ type: 'integer' }) passPercent: number;
  @ApiProperty({ enum: PASS_RULES, enumName: 'PassRule' }) passRule: PassRule;
  @ApiProperty({
    description: 'The snapshot stored at approval (true), or the year’s live settings (false)',
  })
  snapshot: boolean;
}

export class ResultSheetFlagsDto {
  @ApiProperty({ type: () => OwnChildFlagDto, isArray: true }) ownChild: OwnChildFlagDto[];
  @ApiProperty() cover: boolean;
  @ApiProperty() selfApproved: boolean;
  @ApiProperty({
    type: () => ResultSheetGapDto,
    isArray: true,
    maxItems: 100,
    description: 'Gaps that refuse a submission (R268)',
  })
  missing: ResultSheetGapDto[];
  @ApiProperty({ type: 'integer', minimum: 0 }) missingCount: number;
  @ApiProperty({
    ...ID,
    isArray: true,
    description: 'Class-subjects with no exam for the section (EXAM_NOT_SET_UP)',
  })
  examsNotSetUp: string[];
}

export class ResultSheetDetailDto extends ResultSheetDto {
  @ApiProperty({
    enum: ['preview', 'stored'],
    enumName: 'ResultSheetPreviewSource',
    description:
      'preview: the shared composition over the live marks, never stored (draft, submitted, returned); stored: the results stored at approval',
  })
  source: 'preview' | 'stored';
  @ApiProperty({ type: () => ResultSheetSettingsDto }) settings: ResultSheetSettingsDto;
  @ApiProperty({ type: () => ResultSheetSubjectDto, isArray: true })
  subjects: ResultSheetSubjectDto[];
  @ApiProperty({ type: () => ResultPreviewRowDto, isArray: true }) preview: ResultPreviewRowDto[];
  @ApiProperty({ type: () => ResultSheetFlagsDto }) flags: ResultSheetFlagsDto;
  @ApiProperty({
    description:
      "The caller may write remarks now: the sheet's author while it is draft or returned (the final sheet included)",
  })
  canRemark: boolean;
  @ApiProperty({
    description: 'The caller may submit it now (a term sheet; the final is approved directly)',
  })
  canSubmit: boolean;
  @ApiProperty({ description: 'The caller may approve or return it now' }) canDecide: boolean;
  @ApiProperty({ description: 'The caller may publish it now' }) canPublish: boolean;
}

// ---------------------------------------------------------------------------------- requests

export class CreateResultSheetDto {
  @ApiProperty({ ...ID, nullable: true, description: "The term; null for the year's final sheet" })
  @ValidateIf((_o, value) => value !== null)
  @IsIdString()
  termId: string | null;
}

export const RESULT_SHEET_SORTS = ['-updatedAt', 'updatedAt', 'submittedAt'] as const;
export type ResultSheetSort = (typeof RESULT_SHEET_SORTS)[number];

export class ListResultSheetsQueryDto extends PageQueryDto {
  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  termId?: string;

  @ApiPropertyOptional({ type: Boolean, description: 'true: the final sheets only' })
  @IsOptional()
  @IsIn(['true', 'false'])
  final?: 'true' | 'false';

  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  classId?: string;

  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  sectionId?: string;

  @ApiPropertyOptional(STATUS)
  @IsOptional()
  @IsIn(RESULT_SHEET_STATUSES)
  status?: ResultSheetStatus;

  @ApiPropertyOptional({
    enum: RESULT_SHEET_SORTS,
    enumName: 'ResultSheetSort',
    default: '-updatedAt',
  })
  @IsOptional()
  @IsIn(RESULT_SHEET_SORTS)
  sort?: ResultSheetSort;
}

export class SheetRemarkDto {
  @ApiProperty(ID)
  @IsIdString()
  enrolmentId: string;

  @ApiProperty({
    type: String,
    nullable: true,
    minLength: 1,
    maxLength: TERM_REMARK_MAX,
    description: 'null clears it',
  })
  @IfPresentNotNull()
  @TextField(1, TERM_REMARK_MAX)
  @Matches(NO_CONTROL, { message: '$property must not contain control characters' })
  remark: string | null;
}

export class UpdateResultSheetDto {
  @ApiProperty({ type: () => SheetRemarkDto, isArray: true, minItems: 1, maxItems: MAX_REMARKS })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_REMARKS)
  @ValidateNested({ each: true })
  @Type(() => SheetRemarkDto)
  remarks: SheetRemarkDto[];
}
