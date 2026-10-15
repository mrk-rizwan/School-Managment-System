import { ApiProperty } from '@nestjs/swagger';
import { DOCUMENT_TYPES, STUDENT_STATUSES, type DocumentType, type StudentStatus } from '@asms/shared';
import { CHECKLIST_STATUSES, type ChecklistStatus } from '../../documents/verification.dto';

// Phase 5 slice 42 (rule 38, R334; contracts/slice-42.md §1.3): the one-page student profile, a
// print-friendly summary of reads the caller can already make — each section present only when
// the caller holds that section's own read key, so the profile never widens what a user sees.
// No identity number appears on it.

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;
const DATE = { type: String, format: 'date' } as const;
const DATE_TIME = { type: String, format: 'date-time' } as const;
const BP = { type: 'integer', minimum: 0, maximum: 10000 } as const;
const NULLABLE_TEXT = { type: String, nullable: true } as const;
const RUPEES = { type: Number, minimum: 0, description: 'Whole rupees' } as const;

export class ProfileEnrolmentDto {
  @ApiProperty(ID) academicYearId: string;
  @ApiProperty() academicYearName: string;
  @ApiProperty() className: string;
  @ApiProperty() sectionName: string;
  @ApiProperty({ type: Number, nullable: true }) rollNo: number | null;
}

export class ProfileAttendanceDto {
  @ApiProperty(DATE) dateFrom: string;
  @ApiProperty(DATE) dateTo: string;
  @ApiProperty({ type: Number, nullable: true, description: 'One decimal; null when no recorded days' })
  percentage: number | null;
  @ApiProperty() countedDays: number;
  @ApiProperty() present: number;
  @ApiProperty() absent: number;
  @ApiProperty() late: number;
  @ApiProperty() onLeave: number;
}

export class ProfileResultDto {
  @ApiProperty(ID) resultId: string;
  @ApiProperty() academicYearName: string;
  @ApiProperty({ ...NULLABLE_TEXT, description: 'Null on the final result' }) termName: string | null;
  @ApiProperty() isFinal: boolean;
  @ApiProperty() className: string;
  @ApiProperty() sectionName: string;
  @ApiProperty({ ...BP, nullable: true }) percentBp: number | null;
  @ApiProperty(NULLABLE_TEXT) grade: string | null;
  @ApiProperty({ type: Boolean, nullable: true }) passed: boolean | null;
  @ApiProperty({ type: Number, nullable: true, description: 'In the section (as the card prints it)' })
  position: number | null;
  @ApiProperty({ type: Number, nullable: true }) positionOf: number | null;
  @ApiProperty({ type: Number, nullable: true, description: "In the class, from the term's live class ranking" })
  classPosition: number | null;
  @ApiProperty({ type: Number, nullable: true }) classPositionOf: number | null;
  @ApiProperty() revised: boolean;
  @ApiProperty({ ...DATE_TIME, nullable: true }) publishedAt: Date | null;
}

export class ProfileDuesDto {
  /** Across every enrolment and year. */
  @ApiProperty(RUPEES) outstanding: number;
  @ApiProperty(RUPEES) advance: number;
  @ApiProperty() cleared: boolean;
}

export class ProfileDocumentItemDto {
  @ApiProperty({ enum: DOCUMENT_TYPES, enumName: 'DocumentType' }) type: DocumentType;
  @ApiProperty({ enum: CHECKLIST_STATUSES, enumName: 'DocumentChecklistStatus' }) status: ChecklistStatus;
}

export class ProfileDocumentsDto {
  @ApiProperty() complete: boolean;
  @ApiProperty({ type: () => ProfileDocumentItemDto, isArray: true }) items: ProfileDocumentItemDto[];
}

export class ProfileTransportDto {
  @ApiProperty() routeName: string;
  @ApiProperty(NULLABLE_TEXT) stopName: string | null;
  @ApiProperty({ ...NULLABLE_TEXT, description: 'HH:MM' }) pickupTime: string | null;
  @ApiProperty(DATE) startsOn: string;
}

export class StudentProfileDto {
  @ApiProperty(ID) studentId: string;
  @ApiProperty() fullName: string;
  @ApiProperty() admissionNo: string;
  @ApiProperty({ enum: STUDENT_STATUSES, enumName: 'StudentStatus' }) status: StudentStatus;
  @ApiProperty(DATE) admittedOn: string;
  @ApiProperty(DATE) dateOfBirth: string;
  @ApiProperty({ type: () => ProfileEnrolmentDto, nullable: true }) current: ProfileEnrolmentDto | null;
  /** The current academic year to date; null without a current enrolment or before the year starts. */
  @ApiProperty({ type: () => ProfileAttendanceDto, nullable: true }) attendance: ProfileAttendanceDto | null;
  /** The newest published, live result the caller may read. */
  @ApiProperty({ type: () => ProfileResultDto, nullable: true }) latestResult: ProfileResultDto | null;
  /** Null unless the caller holds fee.statement.view. */
  @ApiProperty({ type: () => ProfileDuesDto, nullable: true }) dues: ProfileDuesDto | null;
  /** Null unless the caller holds document.view. */
  @ApiProperty({ type: () => ProfileDocumentsDto, nullable: true }) documents: ProfileDocumentsDto | null;
  /** The route in force today; null when none. */
  @ApiProperty({ type: () => ProfileTransportDto, nullable: true }) transport: ProfileTransportDto | null;
  @ApiProperty(DATE) asOf: string;
}
