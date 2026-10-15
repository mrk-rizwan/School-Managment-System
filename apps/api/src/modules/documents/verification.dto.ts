import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import {
  DOCUMENT_STATUSES,
  DOCUMENT_TYPES,
  type DocumentStatus,
  type DocumentType,
} from '@asms/shared';
import { IsCalendarDate } from '../../common/fields';
import { IsIdString, ID_PATTERN } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';
import { CsvFormatField, type CsvFormat } from '../../common/report-export';
import { StudentDocumentDto } from './documents.dto';

// Phase 5 slice 40, document verification (contracts/slice-40.md §1-§2, rule 36, R322-R325).

const ID = { type: String, pattern: ID_PATTERN.source } as const;
const DATE = { type: String, format: 'date', example: '2026-10-10' } as const;
const TYPE = { enum: DOCUMENT_TYPES, enumName: 'DocumentType' } as const;
const TYPES = { ...TYPE, isArray: true } as const;

/** A required type's place on the checklist (R323): `missing` when no row of the type exists. */
export const CHECKLIST_STATUSES = ['missing', ...DOCUMENT_STATUSES] as const;
export type ChecklistStatus = (typeof CHECKLIST_STATUSES)[number];
const CHECKLIST_STATUS = { enum: CHECKLIST_STATUSES, enumName: 'DocumentChecklistStatus' } as const;

/** The student a queued document belongs to, with their current class and section. */
export class DocumentStudentDto {
  @ApiProperty(ID) id: string;
  @ApiProperty({ description: 'Digits' }) admissionNo: string;
  @ApiProperty() fullName: string;
  @ApiProperty({ type: String, nullable: true }) className: string | null;
  @ApiProperty({ type: String, nullable: true }) sectionName: string | null;
}

/** GET /documents: one row of the verification queue. */
export class QueuedDocumentDto extends StudentDocumentDto {
  @ApiProperty({ type: () => DocumentStudentDto }) student: DocumentStudentDto;

  /** The caller uploaded it: they may not decide it (409 SELF_ACTION_FORBIDDEN own_upload). */
  @ApiProperty() ownUpload: boolean;
}

export const DOCUMENT_QUEUE_SORTS = ['createdAt', '-createdAt'] as const;

export class ListDocumentQueueQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: DOCUMENT_STATUSES, enumName: 'DocumentStatus', default: 'uploaded' })
  @IsOptional()
  @IsIn(DOCUMENT_STATUSES)
  status?: DocumentStatus;

  @ApiPropertyOptional(TYPE)
  @IsOptional()
  @IsIn(DOCUMENT_TYPES)
  type?: DocumentType;

  @ApiPropertyOptional({ ...ID, description: 'Students actively enrolled in this class' })
  @IsOptional()
  @IsIdString()
  classId?: string;

  @ApiPropertyOptional({ enum: DOCUMENT_QUEUE_SORTS, default: 'createdAt' })
  @IsOptional()
  @IsIn(DOCUMENT_QUEUE_SORTS)
  sort?: (typeof DOCUMENT_QUEUE_SORTS)[number];
}

/** One required type on a student's checklist (staff view). */
export class DocumentChecklistItemDto {
  @ApiProperty(TYPE) type: DocumentType;
  @ApiProperty(CHECKLIST_STATUS) status: ChecklistStatus;

  /** The newest document of the type, which the status reads; null when missing. */
  @ApiProperty({ type: () => StudentDocumentDto, nullable: true }) document: StudentDocumentDto | null;
}

/** GET /students/:id/document-checklist (R323). */
export class DocumentChecklistDto {
  @ApiProperty(ID) studentId: string;

  /** The school's required types, in DOCUMENT_TYPES order; empty when the school requires none. */
  @ApiProperty({ type: () => DocumentChecklistItemDto, isArray: true }) items: DocumentChecklistItemDto[];

  /** Every required type has a verified newest document. */
  @ApiProperty() complete: boolean;
}

/** One required type on the family's checklist: the status and fixed text only (R322). */
export class MyDocumentChecklistItemDto {
  @ApiProperty(TYPE) type: DocumentType;
  @ApiProperty(CHECKLIST_STATUS) status: ChecklistStatus;

  /**
   * Fixed text, never the office's reason: "Please re-upload the <type>." when rejected,
   * "Please send the <type> to the school office." when missing, else null.
   */
  @ApiProperty({ type: String, nullable: true }) note: string | null;
}

/** GET /me/children/:id/documents and GET /me/student/documents: no ids, names or reasons. */
export class MyDocumentChecklistDto {
  @ApiProperty(ID) studentId: string;
  @ApiProperty({ type: () => MyDocumentChecklistItemDto, isArray: true }) items: MyDocumentChecklistItemDto[];
}

export const INCOMPLETE_ADMISSION_SORTS = ['admittedOn', '-admittedOn'] as const;

/** Default the last 90 days ending today (school time); at most ten years apart. */
export class IncompleteAdmissionsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ ...DATE, description: 'Default: admittedTo minus 90 days' })
  @IsOptional()
  @IsCalendarDate()
  admittedFrom?: string;

  @ApiPropertyOptional({ ...DATE, description: "Default: the school's today" })
  @IsOptional()
  @IsCalendarDate()
  admittedTo?: string;

  @ApiPropertyOptional({ enum: INCOMPLETE_ADMISSION_SORTS, default: 'admittedOn' })
  @IsOptional()
  @IsIn(INCOMPLETE_ADMISSION_SORTS)
  sort?: (typeof INCOMPLETE_ADMISSION_SORTS)[number];

  /** Phase 5 slice 42 (R336). */
  @CsvFormatField() format?: CsvFormat;
}

/** GET /documents/incomplete-admissions: a student with a required type not yet verified. */
export class IncompleteAdmissionDto {
  @ApiProperty(ID) studentId: string;
  @ApiProperty({ description: 'Digits' }) admissionNo: string;
  @ApiProperty() fullName: string;
  @ApiProperty(DATE) admittedOn: string;
  @ApiProperty({ type: String, nullable: true }) className: string | null;
  @ApiProperty({ type: String, nullable: true }) sectionName: string | null;
  /** No document of the type at all. */
  @ApiProperty(TYPES) missing: DocumentType[];
  /** The newest document of the type awaits a decision. */
  @ApiProperty(TYPES) awaiting: DocumentType[];
  /** The newest document of the type was rejected. */
  @ApiProperty(TYPES) rejected: DocumentType[];
}
