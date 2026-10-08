import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
  ValidateBy,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  ASSESSMENT_KINDS,
  ASSESSMENT_MARK_STATUSES,
  MARK_ENTRY_OUTCOMES,
  MAX_ASSESSMENT_MARKS,
  TEST_TYPES,
  type AssessmentKind,
  type AssessmentMarkStatus,
  type MarkEntryOutcome,
  type TestType,
} from '@asms/shared';
import {
  IfPresent,
  IsCalendarDate,
  NameField,
  NoIdentityNumber,
  QueryBoolean,
} from '../../common/fields';
import { IsIdString, isIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';

// contracts/slice-30.md §1-§4 (phase-4-academic.md slice 30). Every type is prefixed Assessment…
// or MarkEntry… so it never collides with attendance's MarkOutcome, SubmittedMarkDto, AmendMarkDto
// (§5.1).

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;
const DATE = { type: String, format: 'date', example: '2026-05-10' } as const;
const KIND = { enum: ASSESSMENT_KINDS, enumName: 'AssessmentKind' } as const;
const TEST_TYPE = { enum: TEST_TYPES, enumName: 'TestType' } as const;

/** The phone's per-entry key (§3.8): 16-64 of [A-Za-z0-9_-], never a 13-digit run. */
export const CLIENT_ENTRY_KEY = /^[A-Za-z0-9_-]{16,64}$/;

/** A section's at most 200 students, as attendance's register. */
export const MAX_MARK_ENTRIES = 200;

export class AssessmentDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(ID) academicYearId: string;
  @ApiProperty(ID) termId: string;
  @ApiProperty() termName: string;
  @ApiProperty(ID) classId: string;
  @ApiProperty() className: string;
  @ApiProperty(ID) sectionId: string;
  @ApiProperty() sectionName: string;
  @ApiProperty(ID) classSubjectId: string;
  @ApiProperty(ID) subjectId: string;
  @ApiProperty() subjectName: string;
  @ApiProperty(KIND) kind: AssessmentKind;
  @ApiProperty({ ...TEST_TYPE, nullable: true, description: 'A test only; null on an exam' })
  testType: TestType | null;
  @ApiProperty() name: string;
  @ApiProperty({ type: 'integer', minimum: 1, maximum: MAX_ASSESSMENT_MARKS }) maxMarks: number;
  @ApiProperty(DATE) heldOn: string;
  @ApiProperty({ description: 'The caller created it' }) createdByMe: boolean;
  @ApiProperty({ type: 'integer', description: 'Live marks entered so far' }) markedCount: number;
  @ApiProperty({
    description:
      'The caller may enter marks on it now: their write scope on held_on reaches its section and subject, and it is neither voided nor locked',
  })
  canEnterMarks: boolean;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'A test locked by its submitted sheet',
  })
  lockedAt: Date | null;
  @ApiProperty({
    description:
      "Locked (R265): a test with lockedAt, or any assessment whose section's sheet for the term is submitted, approved or published; it takes no mark, only a correction (slice 32)",
  })
  locked: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) voidedAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) voidReason: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt: Date;
}

export const ASSESSMENT_SORTS = ['-heldOn', 'heldOn'] as const;
export type AssessmentSortValue = (typeof ASSESSMENT_SORTS)[number];

export class ListAssessmentsQueryDto extends PageQueryDto {
  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  termId?: string;

  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  classId?: string;

  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  sectionId?: string;

  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  classSubjectId?: string;

  @ApiPropertyOptional(KIND)
  @IsOptional()
  @IsIn(ASSESSMENT_KINDS)
  kind?: AssessmentKind;

  @QueryBoolean({ default: false, description: 'Include voided assessments' })
  includeVoided?: boolean;

  @ApiPropertyOptional({ enum: ASSESSMENT_SORTS, enumName: 'AssessmentSort', default: '-heldOn' })
  @IsOptional()
  @IsIn(ASSESSMENT_SORTS)
  sort?: AssessmentSortValue;
}

export class CreateAssessmentDto {
  @ApiProperty(ID)
  @IsIdString()
  classSubjectId: string;

  @ApiProperty(ID)
  @IsIdString()
  sectionId: string;

  @ApiProperty(TEST_TYPE)
  @IsIn(TEST_TYPES)
  testType: TestType;

  @ApiProperty({ minLength: 1, maxLength: 80 })
  @NameField(1, 80)
  name: string;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: MAX_ASSESSMENT_MARKS })
  @IsInt()
  @Min(1)
  @Max(MAX_ASSESSMENT_MARKS)
  maxMarks: number;

  @ApiProperty({ ...DATE, description: 'Inside a term of the class’s year; fixes the term (A3)' })
  @IsCalendarDate()
  heldOn: string;
}

export class UpdateAssessmentDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 80 })
  @IfPresent()
  @NameField(1, 80)
  name?: string;

  @ApiPropertyOptional({ ...DATE, description: 'Stays inside the same term' })
  @IfPresent()
  @IsCalendarDate()
  heldOn?: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: MAX_ASSESSMENT_MARKS })
  @IfPresent()
  @IsInt()
  @Min(1)
  @Max(MAX_ASSESSMENT_MARKS)
  maxMarks?: number;
}

// ------------------------------------------------------------------------------- the grid

export class AssessmentStudentDto {
  @ApiProperty(ID) id: string;
  @ApiProperty() fullName: string;
  @ApiProperty() admissionNo: string;
  @ApiProperty({ type: 'integer', nullable: true }) rollNo: number | null;
}

export class AssessmentMarkRowDto {
  @ApiProperty(ID) enrolmentId: string;
  @ApiProperty({ type: AssessmentStudentDto }) student: AssessmentStudentDto;
  @ApiProperty({ ...ID, nullable: true, description: 'The live mark; null when none is entered' })
  markId: string | null;
  @ApiProperty({ type: 'integer', nullable: true }) obtained: number | null;
  @ApiProperty() absent: boolean;
  @ApiProperty() excused: boolean;
  @ApiProperty({
    enum: ASSESSMENT_MARK_STATUSES,
    enumName: 'AssessmentMarkStatus',
    nullable: true,
    description: 'live, or null when no mark is entered',
  })
  status: AssessmentMarkStatus | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) enteredAt: Date | null;
  @ApiProperty({
    ...ID,
    nullable: true,
    description:
      "The caller's user id when the caller is a guardian of this student (rule 27), else null",
  })
  ownChildOf: string | null;
  @ApiProperty({ ...ID, nullable: true, description: 'A correction of this mark waiting for a decision (slice 32)' })
  pendingCorrectionId: string | null;
  @ApiProperty({ description: 'The caller asked for that correction (and so may withdraw it)' })
  pendingCorrectionMine: boolean;
}

export class AssessmentMarksDto {
  @ApiProperty({ type: AssessmentDto }) assessment: AssessmentDto;
  @ApiProperty({
    type: AssessmentMarkRowDto,
    isArray: true,
    description: "The section's enrolments in force on held_on, by roll number then name",
  })
  rows: AssessmentMarkRowDto[];
}

export class MarkEntryDto {
  @ApiProperty(ID)
  @IsIdString()
  enrolmentId: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    maximum: MAX_ASSESSMENT_MARKS,
    nullable: true,
    description: 'The mark; absent or null with absent: true',
  })
  @ValidateIf((_o, value) => value !== undefined && value !== null)
  @IsInt()
  @Min(0)
  @Max(MAX_ASSESSMENT_MARKS)
  obtained?: number | null;

  @ApiPropertyOptional({ default: false, description: 'True for an absence (no mark)' })
  @IsOptional()
  @IsBoolean()
  absent?: boolean;

  @ApiProperty({
    pattern: CLIENT_ENTRY_KEY.source,
    description: 'Generated once per entry on the device',
  })
  @Matches(CLIENT_ENTRY_KEY)
  @NoIdentityNumber()
  clientEntryKey: string;

  @ApiProperty({
    ...ID,
    nullable: true,
    description: 'The live mark the client saw, or null when it saw none',
  })
  @ValidateIf((_o, value) => value !== null)
  @IsIdString()
  basedOnMarkId: string | null;
}

export class AssessmentSubmitMarksDto {
  @ApiProperty({ type: MarkEntryDto, isArray: true, minItems: 1, maxItems: MAX_MARK_ENTRIES })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_MARK_ENTRIES)
  @ValidateNested({ each: true })
  @Type(() => MarkEntryDto)
  entries: MarkEntryDto[];
}

export class MarkEntryResultDto {
  @ApiProperty() clientEntryKey: string;
  @ApiProperty(ID) enrolmentId: string;
  @ApiProperty({
    ...ID,
    nullable: true,
    description:
      'The live mark after this entry: the one written, the unchanged one, or (changed_elsewhere) the one now live',
  })
  markId: string | null;
  @ApiProperty({ enum: MARK_ENTRY_OUTCOMES, enumName: 'MarkEntryOutcome' })
  outcome: MarkEntryOutcome;
}

export class AssessmentSubmitMarksResultDto {
  @ApiProperty({ type: AssessmentDto }) assessment: AssessmentDto;
  @ApiProperty({
    type: MarkEntryResultDto,
    isArray: true,
    description:
      'In request order; an entry for a student not on the grid is omitted (nothing written)',
  })
  entries: MarkEntryResultDto[];
}

/** The answer to `Prefer: return=minimal`: the entries only (the phone holds what it sent). */
export class AssessmentSubmitMarksMinimalResultDto {
  @ApiProperty(ID) assessmentId: string;
  @ApiProperty({ type: MarkEntryResultDto, isArray: true }) entries: MarkEntryResultDto[];
}

export class AssessmentMarkDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(ID) assessmentId: string;
  @ApiProperty(ID) enrolmentId: string;
  @ApiProperty(ID) studentId: string;
  @ApiProperty({ type: 'integer', nullable: true }) obtained: number | null;
  @ApiProperty({ type: 'integer' }) maxMarks: number;
  @ApiProperty() absent: boolean;
  @ApiProperty() excused: boolean;
  @ApiProperty({ enum: ASSESSMENT_MARK_STATUSES, enumName: 'AssessmentMarkStatus' })
  status: AssessmentMarkStatus;
  @ApiProperty({ ...ID, nullable: true }) supersedesId: string | null;
  @ApiProperty({ type: String, nullable: true }) correctionReason: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) enteredAt: Date;
}

// ----------------------------------------------------------------------------- exam set-up

export class SetUpExamsDto {
  @ApiPropertyOptional({
    type: String,
    isArray: true,
    maxItems: 100,
    description: "Default: every class of the term's year that is not archived",
  })
  @IfPresent()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateBy({
    name: 'isIdStringList',
    validator: {
      validate: (value: unknown) => Array.isArray(value) && value.every(isIdString),
      defaultMessage: () => '$property must be a list of ids',
    },
  })
  classIds?: string[];

  @ApiPropertyOptional({
    ...DATE,
    description:
      "The exams' date, inside the term (slice 36). Default: the term's last day. Exams that already exist keep theirs",
  })
  @IfPresent()
  @IsCalendarDate()
  heldOn?: string;
}

export class ExamSetUpResultDto {
  @ApiProperty({ type: 'integer', description: 'Exams created by this request' }) created: number;
  @ApiProperty({ type: 'integer', description: 'Exams that already existed (live)' })
  existing: number;
  @ApiProperty({
    type: 'integer',
    description: 'Class-subject × section pairs not set up: the term is not held for the class',
  })
  skipped: number;
}
