import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import {
  IMPORT_KINDS,
  IMPORT_STATUSES,
  type ImportKind,
  type ImportRowErrorCode,
  type ImportStatus,
} from '@asms/shared';
import { IsCalendarDate } from '../../common/fields';
import { ID_PATTERN, IsIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';

// Phase 5 slice 43 (contracts/slice-43.md §1). Ids are strings; dates `YYYY-MM-DD`; amounts whole
// rupees. The two preview routes are multipart: one `file` part (the CSV, ≤ 2 MB) and these
// fields as text parts.

const ID = { type: String, pattern: ID_PATTERN.source } as const;
const NULLABLE_ID = { ...ID, nullable: true } as const;
const DATE = { type: String, format: 'date', example: '2026-11-10' } as const;
const NULLABLE_DATE = { ...DATE, nullable: true } as const;
const DATE_TIME = { type: String, format: 'date-time' } as const;
const NULLABLE_DATE_TIME = { ...DATE_TIME, nullable: true } as const;
const NULLABLE_TEXT = { type: String, nullable: true } as const;

/** Every ImportRowErrorCode (packages/shared imports/kinds.ts), for the schema and stored-row reads. */
export const IMPORT_ROW_ERROR_CODES: readonly ImportRowErrorCode[] = [
  'first_column',
  'unknown_column',
  'missing_column',
  'duplicate_column',
  'required',
  'unknown_admission_no',
  'not_on_roster',
  'duplicate',
  'missing_from_file',
  'invalid_mark',
  'over_max',
  'invalid_amount',
  'identity_number',
];

// -------------------------------------------------------------------------------------- requests

/** POST /imports/past-results: the section and term the file holds (with the `file` part). */
export class PastResultsImportDto {
  @ApiProperty(ID) @IsIdString() sectionId: string;
  @ApiProperty(ID) @IsIdString() termId: string;
}

/** POST /imports/opening-balances: the year charged and the due date of every row (with `file`). */
export class OpeningBalancesImportDto {
  @ApiProperty(ID) @IsIdString() academicYearId: string;
  @ApiProperty({ ...DATE, description: 'Today or later, school time' }) @IsCalendarDate() dueOn: string;
}

/** The two preview bodies as one multipart schema (OpenAPI only). */
export class PastResultsUploadDto extends PastResultsImportDto {
  @ApiProperty({ type: 'string', format: 'binary', description: 'The CSV, UTF-8, at most 2 MB' }) file: unknown;
}
export class OpeningBalancesUploadDto extends OpeningBalancesImportDto {
  @ApiProperty({ type: 'string', format: 'binary', description: 'The CSV, UTF-8, at most 2 MB' }) file: unknown;
}

export class ListImportsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: IMPORT_KINDS, enumName: 'ImportKind' })
  @IsOptional()
  @IsIn(IMPORT_KINDS)
  kind?: ImportKind;

  @ApiPropertyOptional({ enum: IMPORT_STATUSES, enumName: 'ImportStatus' })
  @IsOptional()
  @IsIn(IMPORT_STATUSES)
  status?: ImportStatus;
}

// ------------------------------------------------------------------------------------- responses

/** A refused row (or the header, row 1; a roster student the file omits, row 0). Never a cell's text. */
export class ImportRowErrorDto {
  @ApiProperty({ type: 'integer', minimum: 0 }) row: number;
  @ApiProperty({ description: 'The column: admission_no, a subject name, amount, note' }) field: string;
  @ApiProperty({ enum: IMPORT_ROW_ERROR_CODES, enumName: 'ImportRowErrorCode' }) code: ImportRowErrorCode;
  @ApiPropertyOptional({ description: "On missing_from_file: the roster student's admission number" })
  admissionNo?: string;
}

export class ImportSubjectDto {
  @ApiProperty(ID) classSubjectId: string;
  @ApiProperty() name: string;
  @ApiProperty({ type: 'integer', minimum: 1, description: "The exam's max marks" }) maxMarks: number;
}

export class ImportMarkDto {
  @ApiProperty(ID) classSubjectId: string;
  @ApiProperty({ type: 'integer', nullable: true, description: 'Null is "Ab" (absent)' }) obtained: number | null;
}

/** One valid row of the file, as it will be (or was) committed. */
export class ImportRowDto {
  @ApiProperty({ type: 'integer', minimum: 2, description: 'The file line' }) row: number;
  @ApiProperty(ID) studentId: string;
  @ApiProperty() admissionNo: string;
  @ApiProperty() studentName: string;
  @ApiProperty({ type: () => ImportMarkDto, isArray: true, nullable: true, description: 'Past results only, in subject order' })
  marks: ImportMarkDto[] | null;
  @ApiProperty({ type: 'integer', nullable: true, description: 'Opening balances only' }) amount: number | null;
  @ApiProperty(NULLABLE_TEXT) note: string | null;
  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: "Opening balances only: the child's advance in the year at preview, which pays the charge on commit",
  })
  advance: number | null;
}

export class ImportDto {
  @ApiProperty(ID) id: string;
  @ApiProperty({ enum: IMPORT_KINDS, enumName: 'ImportKind' }) kind: ImportKind;
  @ApiProperty({ enum: IMPORT_STATUSES, enumName: 'ImportStatus' }) status: ImportStatus;
  @ApiProperty({ description: 'As uploaded; render as text' }) fileName: string;
  @ApiProperty({ type: 'integer', minimum: 0, description: 'Data rows in the file' }) rowCount: number;
  @ApiProperty(ID) academicYearId: string;
  @ApiProperty() academicYearName: string;
  @ApiProperty(NULLABLE_ID) classId: string | null;
  @ApiProperty(NULLABLE_TEXT) className: string | null;
  @ApiProperty(NULLABLE_ID) sectionId: string | null;
  @ApiProperty(NULLABLE_TEXT) sectionName: string | null;
  @ApiProperty(NULLABLE_ID) termId: string | null;
  @ApiProperty(NULLABLE_TEXT) termName: string | null;
  @ApiProperty(NULLABLE_DATE) dueOn: string | null;
  @ApiProperty() createdByName: string;
  @ApiProperty(DATE_TIME) createdAt: Date;
  @ApiProperty({ ...DATE_TIME, description: 'A preview not committed by then fails as "expired"' }) expiresAt: Date;
  @ApiProperty(NULLABLE_TEXT) committedByName: string | null;
  @ApiProperty(NULLABLE_DATE_TIME) committedAt: Date | null;
  @ApiProperty(NULLABLE_DATE_TIME) failedAt: Date | null;
  @ApiProperty({ ...NULLABLE_TEXT, description: 'Why it failed ("expired")' }) error: string | null;
  @ApiProperty({ type: 'integer', minimum: 0, description: 'Every row error; the first 100 are listed' }) errorCount: number;
  @ApiProperty({ type: () => ImportRowErrorDto, isArray: true }) errors: ImportRowErrorDto[];
}

/** An import with its rows: the preview table, and what a commit wrote. */
export class ImportDetailDto extends ImportDto {
  @ApiProperty({ type: () => ImportSubjectDto, isArray: true, description: 'Past results only: the columns, in print order' })
  subjects: ImportSubjectDto[];
  @ApiProperty({ type: () => ImportRowDto, isArray: true, description: 'Empty while the file has row errors' })
  rows: ImportRowDto[];
  @ApiProperty({ type: 'integer', nullable: true, description: 'Opening balances: the sum charged' }) totalAmount: number | null;
  @ApiProperty({ type: 'integer', nullable: true, description: 'Opening balances: the advances that apply' }) totalAdvance: number | null;
  @ApiProperty({ ...NULLABLE_ID, description: 'Past results, once committed: the imported sheet' }) resultSheetId: string | null;
}
