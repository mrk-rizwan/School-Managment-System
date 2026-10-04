import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';
import {
  REMARK_CATEGORIES,
  REMARK_VISIBILITIES,
  type RemarkCategory,
  type RemarkVisibility,
} from '@asms/shared';
import {
  IfPresent,
  IfPresentNotNull,
  IsCalendarDate,
  NoticeTextField,
  QueryBoolean,
  TextField,
} from '../../common/fields';
import { ID_PATTERN, IsIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';

// contracts/slice-13.md §1.6, §2, §4-§6. Diary text is normalised per §1.6: `topic` travels in
// the diary_posted body, so it refuses phone numbers as well as identity numbers; the other text
// fields refuse identity numbers and keep line breaks.

const ID = { type: String, pattern: ID_PATTERN.source } as const;
const NULLABLE_ID = { ...ID, nullable: true } as const;
const DATE = { type: String, format: 'date' } as const;
const NULLABLE_DATE = { ...DATE, nullable: true } as const;
const DATE_TIME = { type: String, format: 'date-time' } as const;
const NULLABLE_DATE_TIME = { ...DATE_TIME, nullable: true } as const;

export const ATTACHMENT_MIMES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
export type AttachmentMime = (typeof ATTACHMENT_MIMES)[number];

export const DIARY_SORTS = ['-date', 'date'] as const;
export type DiarySort = (typeof DIARY_SORTS)[number];

/** `''` (or only spaces) and null both store null (§1.6). */
const emptyToNull = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && value.trim() === '' ? null : value;

// ------------------------------------------------------------------------------------ queries

/** `dateFrom`, `dateTo` (either alone open-ended, both at most 366 days) and the sort. */
export class DiaryRangeQueryDto extends PageQueryDto {
  @ApiPropertyOptional(DATE)
  @IsOptional()
  @IsCalendarDate()
  dateFrom?: string;

  @ApiPropertyOptional({ ...DATE, description: 'On or after dateFrom; both at most 366 days apart' })
  @IsOptional()
  @IsCalendarDate()
  dateTo?: string;

  @ApiPropertyOptional({ enum: DIARY_SORTS, enumName: 'DiarySort', default: '-date' })
  @IsOptional()
  @IsIn(DIARY_SORTS)
  sort?: DiarySort;
}

export class ListDiaryEntriesQueryDto extends DiaryRangeQueryDto {
  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  subjectId?: string;
}

/** GET /me/children/:id/remarks and /me/student/remarks (§6.4). */
export class MyRemarksQueryDto extends DiaryRangeQueryDto {
  @ApiPropertyOptional({ enum: REMARK_CATEGORIES, enumName: 'RemarkCategory' })
  @IsOptional()
  @IsIn(REMARK_CATEGORIES)
  category?: RemarkCategory;
}

/** GET /students/:id/remarks (§5.1). */
export class ListRemarksQueryDto extends MyRemarksQueryDto {
  @ApiPropertyOptional({ enum: REMARK_VISIBILITIES, enumName: 'RemarkVisibility' })
  @IsOptional()
  @IsIn(REMARK_VISIBILITIES)
  visibility?: RemarkVisibility;

  @QueryBoolean({ default: false, description: 'Include rows a correction has superseded' })
  includeSuperseded?: boolean;
}

// ------------------------------------------------------------------------------------- bodies

export class CreateDiaryEntryDto {
  @ApiProperty({ ...DATE, description: 'On or before today, within the class’s academic year' })
  @IsCalendarDate()
  date: string;

  @ApiProperty(ID)
  @IsIdString()
  subjectId: string;

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @NoticeTextField(1, 500)
  topic: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000 })
  @Transform(emptyToNull)
  @IfPresentNotNull()
  @TextField(1, 1000)
  assignment?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @Transform(emptyToNull)
  @IfPresentNotNull()
  @TextField(1, 500)
  learningOutcome?: string | null;

  @ApiPropertyOptional({ ...NULLABLE_DATE, description: 'On or after date, within the year' })
  @IfPresentNotNull()
  @IsCalendarDate()
  dueOn?: string | null;

  @ApiPropertyOptional({ ...NULLABLE_ID, description: 'One attachment, image or PDF (POST /uploads)' })
  @IfPresentNotNull()
  @IsIdString()
  stagedUploadId?: string | null;
}

/**
 * PATCH /diary-entries/:id (§4.4): absent = unchanged; `topic: null` is refused; the other
 * fields' null clears. `date`, `subjectId` and `sectionId` are not declared, so sending one is
 * `422 UNKNOWN_FIELD` (the natural key is the entry's identity).
 */
export class UpdateDiaryEntryDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 500 })
  @IfPresent()
  @NoticeTextField(1, 500)
  topic?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000 })
  @Transform(emptyToNull)
  @IfPresentNotNull()
  @TextField(1, 1000)
  assignment?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @Transform(emptyToNull)
  @IfPresentNotNull()
  @TextField(1, 500)
  learningOutcome?: string | null;

  @ApiPropertyOptional(NULLABLE_DATE)
  @IfPresentNotNull()
  @IsCalendarDate()
  dueOn?: string | null;

  @ApiPropertyOptional({ ...NULLABLE_ID, description: 'A new attachment; null removes it' })
  @IfPresentNotNull()
  @IsIdString()
  stagedUploadId?: string | null;

  @ApiPropertyOptional({
    minLength: 3,
    maxLength: 500,
    description: 'Required after the edit window for a school-wide diary.write holder',
  })
  @IfPresent()
  @TextField(3, 500)
  reason?: string;
}

export class CreateRemarkDto {
  @ApiProperty({ ...DATE, description: 'On or before today; the student’s enrolment on it' })
  @IsCalendarDate()
  date: string;

  @ApiProperty({ enum: REMARK_CATEGORIES, enumName: 'RemarkCategory' })
  @IsIn(REMARK_CATEGORIES)
  category: RemarkCategory;

  @ApiProperty({ minLength: 1, maxLength: 1000 })
  @TextField(1, 1000)
  text: string;

  @ApiPropertyOptional({
    enum: REMARK_VISIBILITIES,
    enumName: 'RemarkVisibility',
    description: 'Default: the school’s remarkDefaultVisibility',
  })
  @IfPresent()
  @IsIn(REMARK_VISIBILITIES)
  visibility?: RemarkVisibility;

  @ApiPropertyOptional({ ...NULLABLE_ID, description: 'A tag, not a right: no assignment check' })
  @IfPresentNotNull()
  @IsIdString()
  subjectId?: string | null;
}

/** POST /remarks/:id/correct (§5.3). The identity of the original is copied, never changed. */
export class CorrectRemarkDto {
  @ApiProperty({ minLength: 1, maxLength: 1000 })
  @TextField(1, 1000)
  text: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @TextField(3, 500)
  reason: string;

  @ApiPropertyOptional({
    enum: REMARK_VISIBILITIES,
    enumName: 'RemarkVisibility',
    description: 'Default: the original’s',
  })
  @IfPresent()
  @IsIn(REMARK_VISIBILITIES)
  visibility?: RemarkVisibility;
}

// ---------------------------------------------------------------------------------- responses

/** The fields a diary entry shows to everyone who may read it. */
class DiaryEntryBaseDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(ID)
  sectionId: string;

  @ApiProperty(ID)
  classId: string;

  @ApiProperty(DATE)
  date: string;

  @ApiProperty(ID)
  subjectId: string;

  @ApiProperty()
  subjectName: string;

  @ApiProperty()
  authorName: string;

  @ApiProperty()
  topic: string;

  @ApiProperty({ type: String, nullable: true })
  assignment: string | null;

  @ApiProperty({ type: String, nullable: true })
  learningOutcome: string | null;

  @ApiProperty(NULLABLE_DATE)
  dueOn: string | null;

  @ApiProperty()
  hasAttachment: boolean;

  @ApiProperty({ enum: ATTACHMENT_MIMES, enumName: 'AttachmentMime', nullable: true })
  attachmentMime: AttachmentMime | null;

  @ApiProperty({ type: Number, nullable: true })
  attachmentSizeBytes: number | null;

  @ApiProperty(DATE_TIME)
  createdAt: Date;

  @ApiProperty({ ...DATE_TIME, description: 'Later than createdAt means edited' })
  updatedAt: Date;
}

/** Staff routes (§2.2). */
export class DiaryEntryDto extends DiaryEntryBaseDto {
  @ApiProperty(ID)
  academicYearId: string;

  @ApiProperty(ID)
  authorStaffId: string;

  @ApiProperty({ ...DATE, description: 'The last day the author may edit without a reason' })
  editWindowEndsOn: string;
}

/** `/me/*` routes (R165): no author staff id, the labels of the row's own section. */
export class MyDiaryEntryDto extends DiaryEntryBaseDto {
  @ApiProperty()
  className: string;

  @ApiProperty()
  sectionName: string;
}

class RemarkBaseDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(ID)
  studentId: string;

  @ApiProperty(DATE)
  date: string;

  @ApiProperty({ enum: REMARK_CATEGORIES, enumName: 'RemarkCategory' })
  category: RemarkCategory;

  @ApiProperty()
  text: string;

  @ApiProperty(NULLABLE_ID)
  subjectId: string | null;

  @ApiProperty({ type: String, nullable: true })
  subjectName: string | null;

  @ApiProperty()
  authorName: string;

  @ApiProperty({ ...NULLABLE_ID, description: 'The row this one corrects' })
  supersedesId: string | null;

  @ApiProperty(NULLABLE_DATE_TIME)
  supersededAt: Date | null;

  @ApiProperty({ ...NULLABLE_ID, description: 'The correction of this row, once one exists' })
  supersededById: string | null;

  @ApiProperty(DATE_TIME)
  createdAt: Date;
}

/** Staff routes (§2.2): every visibility. */
export class RemarkDto extends RemarkBaseDto {
  @ApiProperty(ID)
  enrolmentId: string;

  @ApiProperty({ enum: REMARK_VISIBILITIES, enumName: 'RemarkVisibility' })
  visibility: RemarkVisibility;

  @ApiProperty(ID)
  authorStaffId: string;

  @ApiProperty({ type: String, nullable: true, description: 'Set exactly when supersedesId is' })
  correctionReason: string | null;
}

/** `/me/*` routes (R165): no author staff id, enrolment, visibility or correction reason. */
export class MyRemarkDto extends RemarkBaseDto {}
