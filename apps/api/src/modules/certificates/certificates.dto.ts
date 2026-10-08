import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import {
  CERTIFICATE_TYPES,
  DUES_STATUSES,
  GENDERS,
  STUDENT_STATUSES,
  type CertificateType,
  type DuesStatus,
  type Gender,
  type StudentStatus,
} from '@asms/shared';
import { IfPresent, IsCalendarDate, NameField, NoPhoneNumber, QueryBoolean, TextField } from '../../common/fields';
import { IsIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';
import type { CertificateBody, CertificateBodyEnrolment } from '../../repositories/certificate.repository';

// phase-4-academic.md slice 34 (R289-R293, §7.1); contracts/slice-34.md.

const ID = { type: String, pattern: '^[1-9][0-9]{0,18}$' } as const;
const NULLABLE_ID = { ...ID, nullable: true } as const;
const DATE = { type: String, format: 'date', example: '2026-10-07' } as const;
const NULLABLE_DATE = { ...DATE, nullable: true } as const;
const NULLABLE_TEXT = { type: String, nullable: true } as const;
const TYPE = { enum: CERTIFICATE_TYPES, enumName: 'CertificateType' } as const;
const DUES = { enum: DUES_STATUSES, enumName: 'DuesStatus' } as const;

/** One enrolment of the student, as the certificate was issued. */
export class CertificateEnrolmentDto implements CertificateBodyEnrolment {
  @ApiProperty()
  academicYearName: string;

  @ApiProperty()
  className: string;

  @ApiProperty()
  sectionName: string;

  @ApiProperty(DATE)
  from: string;

  @ApiProperty({ ...NULLABLE_DATE, description: 'Null while the enrolment was still open' })
  to: string | null;
}

/**
 * The certificate's body: a snapshot built once, at issue, by one builder (§7.1). It holds names,
 * dates, the class history and the school's own wording, and never an identity number, a phone,
 * an address, a dues figure, a user id, an object key or a Phase 2 remark.
 */
export class CertificateBodyDto implements CertificateBody {
  @ApiProperty()
  schoolName: string;

  @ApiProperty()
  studentName: string;

  @ApiProperty(NULLABLE_TEXT)
  fatherName: string | null;

  @ApiProperty()
  admissionNo: string;

  @ApiProperty({ enum: GENDERS, enumName: 'Gender' })
  gender: Gender;

  @ApiProperty(DATE)
  dateOfBirth: string;

  @ApiProperty(DATE)
  admittedOn: string;

  /** The student's status when the certificate was issued. */
  @ApiProperty({ enum: STUDENT_STATUSES, enumName: 'StudentStatus' })
  studentStatus: StudentStatus;

  /** The named year (or the last enrolment's), its class and section. */
  @ApiProperty(NULLABLE_TEXT)
  academicYearName: string | null;

  @ApiProperty(NULLABLE_TEXT)
  className: string | null;

  @ApiProperty(NULLABLE_TEXT)
  sectionName: string | null;

  /** The dates of attendance: the first enrolment's start and the last one's end. */
  @ApiProperty(NULLABLE_DATE)
  attendedFrom: string | null;

  @ApiProperty({ ...NULLABLE_DATE, description: 'Null while the student is still enrolled' })
  attendedTo: string | null;

  @ApiProperty({ type: CertificateEnrolmentDto, isArray: true, description: 'Oldest first' })
  enrolments: CertificateEnrolmentDto[];

  @ApiProperty(NULLABLE_TEXT)
  conduct: string | null;

  @ApiProperty(NULLABLE_TEXT)
  remarks: string | null;

  /** certificate_signatory_name when issued. */
  @ApiProperty()
  signatoryName: string;

  /** The marks table (academic, completion): the published result of the named year, as issued. */
  @ApiProperty({ type: () => CertificateResultDto, nullable: true })
  result: CertificateResultDto | null;
}

export class CertificateResultSubjectDto {
  @ApiProperty() subjectName: string;
  @ApiProperty({ type: 'integer', nullable: true, description: 'Printed obtained; null when not assessed' })
  obtained: number | null;
  @ApiProperty({ type: 'integer', minimum: 1 }) max: number;
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 10000, nullable: true, description: '7850 = 78.50 %' })
  percentBp: number | null;
  @ApiProperty(NULLABLE_TEXT) grade: string | null;
  @ApiProperty({ description: 'Absent from the term exam: prints "Ab" ("Ex" when excused, rule 26)' })
  examAbsent: boolean;
  @ApiProperty() examExcused: boolean;
}

/** A11: the named year's published final result, else its last published term (snapshotted). */
export class CertificateResultDto {
  @ApiProperty({ description: "The term's name, or Final" }) termName: string;
  @ApiProperty() isFinal: boolean;
  @ApiProperty() className: string;
  @ApiProperty() sectionName: string;
  @ApiProperty({ type: () => CertificateResultSubjectDto, isArray: true }) subjects: CertificateResultSubjectDto[];
  @ApiProperty({ type: 'integer' }) totalObtained: number;
  @ApiProperty({ type: 'integer' }) totalMax: number;
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 10000, nullable: true }) percentBp: number | null;
  @ApiProperty(NULLABLE_TEXT) grade: string | null;
  @ApiProperty({ type: Boolean, nullable: true }) passed: boolean | null;
}

/**
 * A certificate without its body, its dues status or its reason (GET /students/:id/certificates,
 * which a `student.view` holder without `certificate.issue` may read).
 */
export class CertificateSummaryDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(ID)
  studentId: string;

  /** The student's name and admission number now; the body keeps them as issued. */
  @ApiProperty()
  studentName: string;

  @ApiProperty()
  admissionNo: string;

  @ApiProperty(TYPE)
  type: CertificateType;

  /** The type's sequence number; a reissue keeps it. */
  @ApiProperty({ type: 'integer', minimum: 1 })
  number: number;

  /** `LC-0001` (§1.1). */
  @ApiProperty({ example: 'LC-0001' })
  label: string;

  /** 1 for the original; a reissue is the next one and prints DUPLICATE. */
  @ApiProperty({ type: 'integer', minimum: 1 })
  issueNo: number;

  @ApiProperty(NULLABLE_ID)
  reissueOfId: string | null;

  @ApiProperty(NULLABLE_ID)
  academicYearId: string | null;

  @ApiProperty(NULLABLE_TEXT)
  academicYearName: string | null;

  /** The printed title: the one given, else the type's own. */
  @ApiProperty()
  title: string;

  @ApiProperty(DATE)
  issuedOn: string;

  @ApiProperty()
  issuedByName: string;

  @ApiProperty({ type: 'integer', minimum: 0 })
  printedCount: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  voidedAt: Date | null;

  @ApiProperty(NULLABLE_TEXT)
  voidedByName: string | null;

  @ApiProperty(NULLABLE_TEXT)
  voidReason: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

/** The register's row (`certificate.issue`): the summary with the dues status, reason and body. */
export class CertificateDto extends CertificateSummaryDto {
  @ApiProperty(DUES)
  duesStatus: DuesStatus;

  /** The dues override's reason (leaving, `override`) or the reissue's reason. */
  @ApiProperty(NULLABLE_TEXT)
  reason: string | null;

  @ApiProperty({ type: CertificateBodyDto })
  body: CertificateBodyDto;
}

export const CERTIFICATE_SORTS = ['-issuedOn', 'issuedOn'] as const;
export type CertificateSort = (typeof CERTIFICATE_SORTS)[number];

export class ListCertificatesQueryDto extends PageQueryDto {
  @ApiPropertyOptional(TYPE)
  @IsOptional()
  @IsIn(CERTIFICATE_TYPES)
  type?: CertificateType;

  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  studentId?: string;

  @ApiPropertyOptional(DATE)
  @IsOptional()
  @IsCalendarDate()
  issuedFrom?: string;

  @ApiPropertyOptional(DATE)
  @IsOptional()
  @IsCalendarDate()
  issuedTo?: string;

  @QueryBoolean({ description: 'True lists only voided certificates, false only the valid ones' })
  voided?: boolean;

  @ApiPropertyOptional({ enum: CERTIFICATE_SORTS, enumName: 'CertificateSort', default: '-issuedOn' })
  @IsOptional()
  @IsIn(CERTIFICATE_SORTS)
  sort?: CertificateSort;
}

export class ListStudentCertificatesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: CERTIFICATE_SORTS, enumName: 'CertificateSort', default: '-issuedOn' })
  @IsOptional()
  @IsIn(CERTIFICATE_SORTS)
  sort?: CertificateSort;
}

export class IssueCertificateDto {
  @ApiProperty(TYPE)
  @IsIn(CERTIFICATE_TYPES)
  type: CertificateType;

  /** Default: the student's last enrolment's year. Required to be one the student was enrolled in. */
  @ApiPropertyOptional(ID)
  @IfPresent()
  @IsIdString()
  academicYearId?: string;

  /** Required for `other` and refused for every other type; never a leaving certificate's ("leav"). */
  @ApiPropertyOptional({ minLength: 1, maxLength: 80 })
  @IfPresent()
  @NameField(1, 80)
  title?: string;

  /** The conduct line, e.g. "Good". */
  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @IfPresent()
  @TextField(1, 100)
  @NoPhoneNumber()
  conduct?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 500 })
  @IfPresent()
  @TextField(1, 500)
  @NoPhoneNumber()
  remarks?: string;
}
