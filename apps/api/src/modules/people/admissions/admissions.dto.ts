import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  ValidateBy,
  ValidateNested,
} from 'class-validator';
import {
  DOCUMENT_TYPES,
  GENDERS,
  IDENTITY_INPUT_PATTERN,
  RELATIONSHIPS,
  type DocumentType,
  type Gender,
  type Relationship,
  type StudentStatus,
} from '@asms/shared';
import { CnicField, IfPresent, IsCalendarDate } from '../../../common/fields';
import { ID_PATTERN, isIdString, IsIdString } from '../../../common/ids';
import { StudentDocumentDto } from '../../documents/documents.dto';
import { AdmissionFeeDto } from '../../fees/admission-fees';
import { ChargeDto } from '../../fees/charges.dto';
import { CreateGuardianDto } from '../guardians/guardians.dto';
import {
  EnrolmentDto,
  GenderField,
  GuardianLinkDto,
  Reason,
  RollNoField,
  StudentDetailDto,
  StudentFullName,
  StudentNotes,
} from '../students/students.dto';

// contracts/slice-6.md §3.7 (readmission) and §6.3 (admission). Field rules are the students
// module's own decorators, so a student field is checked the same way on every route. Identity
// numbers arrive in bodies only and are never echoed.

const ID = { type: String, pattern: ID_PATTERN.source } as const;
const DATE = { type: String, format: 'date' } as const;

/** Every element an id string (IsIdString for an array). */
const EachIdString = (): PropertyDecorator =>
  ValidateBy(
    {
      name: 'isIdString',
      validator: {
        validate: isIdString,
        defaultMessage: () => 'each value in $property must be an id',
      },
    },
    { each: true },
  );

// --------------------------------------------------------------------------------- admission

export class AdmissionStudentDto {
  @ApiProperty({ minLength: 2, maxLength: 200 })
  @StudentFullName()
  fullName: string;

  @ApiProperty({ enum: GENDERS, enumName: 'Gender' })
  @GenderField()
  gender: Gender;

  @ApiProperty({ ...DATE, description: 'Before admittedOn, at most 30 years ago' })
  @IsCalendarDate()
  dateOfBirth: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: IDENTITY_INPUT_PATTERN.source,
    description: 'B-Form, 13 digits, dashes optional. Never returned.',
  })
  @IsOptional()
  @CnicField()
  bForm?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @StudentNotes()
  notes?: string | null;

  @ApiPropertyOptional({ ...DATE, description: 'No later than today; default today' })
  @IfPresent()
  @IsCalendarDate()
  admittedOn?: string;
}

/** Exactly one of guardianId and newGuardian (checked by the service: 422 on `guardians[i]`). */
export class AdmissionGuardianDto {
  @ApiPropertyOptional(ID)
  @IfPresent()
  @IsIdString()
  guardianId?: string;

  @ApiPropertyOptional({ type: CreateGuardianDto })
  @IfPresent()
  @IsObject()
  @ValidateNested()
  @Type(() => CreateGuardianDto)
  newGuardian?: CreateGuardianDto;

  @ApiProperty({ enum: RELATIONSHIPS, enumName: 'Relationship' })
  @IsIn(RELATIONSHIPS)
  relationship: Relationship;

  @ApiProperty()
  @IsBoolean()
  isPrimaryContact: boolean;

  @ApiProperty()
  @IsBoolean()
  isFeePayer: boolean;

  @ApiProperty()
  @IsBoolean()
  canLogin: boolean;
}

export class AdmissionEnrolmentDto {
  @ApiProperty(ID)
  @IsIdString()
  classId: string;

  @ApiProperty(ID)
  @IsIdString()
  sectionId: string;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 9999 })
  @IfPresent()
  @RollNoField()
  rollNo?: number;
}

export class AdmissionDocumentDto {
  @ApiProperty(ID)
  @IsIdString()
  stagedUploadId: string;

  @ApiProperty({ enum: DOCUMENT_TYPES, enumName: 'DocumentType' })
  @IsIn(DOCUMENT_TYPES)
  type: DocumentType;
}

export class CreateAdmissionDto {
  @ApiProperty({ type: AdmissionStudentDto })
  @IsObject()
  @ValidateNested()
  @Type(() => AdmissionStudentDto)
  student: AdmissionStudentDto;

  @ApiProperty({ type: [AdmissionGuardianDto], minItems: 1, maxItems: 4 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => AdmissionGuardianDto)
  guardians: AdmissionGuardianDto[];

  @ApiProperty({ type: AdmissionEnrolmentDto })
  @IsObject()
  @ValidateNested()
  @Type(() => AdmissionEnrolmentDto)
  enrolment: AdmissionEnrolmentDto;

  @ApiPropertyOptional({ type: [AdmissionDocumentDto], maxItems: 10 })
  @IfPresent()
  @IsArray()
  @ArrayMaxSize(10)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => AdmissionDocumentDto)
  documents?: AdmissionDocumentDto[];

  @ApiPropertyOptional({
    type: [String],
    maxItems: 20,
    description:
      'Students the office confirmed are different children (ADMISSION_POSSIBLE_DUPLICATE). Not part of the request hash.',
  })
  @IfPresent()
  @IsArray()
  @ArrayMaxSize(20)
  @EachIdString()
  acknowledgedDuplicateStudentIds?: string[];

  @ApiPropertyOptional({
    type: AdmissionFeeDto,
    description:
      'The admission fee (R239): full (default), partial (the family pays amount) or free. A reduction is a fixed concession on the admission head, approved when the caller is a principal holding concession.grant, else requested; it needs charge.create.',
  })
  @IfPresent()
  @IsObject()
  @ValidateNested()
  @Type(() => AdmissionFeeDto)
  admissionFee?: AdmissionFeeDto;
}

export class GuardianLoginOfferDto {
  @ApiProperty(ID)
  guardianId: string;

  @ApiProperty()
  fullName: string;

  @ApiProperty({ description: 'A login can be issued now (CNIC recorded, no login, can_login)' })
  available: boolean;
}

export class LoginOffersDto {
  @ApiProperty({ description: 'Student logins are enabled, the student has a B-Form and no login' })
  student: boolean;

  @ApiProperty({ type: [GuardianLoginOfferDto] })
  guardians: GuardianLoginOfferDto[];
}

export class AdmissionResultDto {
  @ApiProperty({ type: StudentDetailDto })
  student: StudentDetailDto;

  @ApiProperty({ type: EnrolmentDto })
  enrolment: EnrolmentDto;

  @ApiProperty({ type: [GuardianLinkDto] })
  guardianLinks: GuardianLinkDto[];

  @ApiProperty({ type: [StudentDocumentDto] })
  documents: StudentDocumentDto[];

  @ApiProperty({ type: LoginOffersDto })
  loginOffers: LoginOffersDto;

  /** The once-head charges admission wrote (R239); empty for a caller who reads no money (R234). */
  @ApiProperty({ type: [ChargeDto] })
  charges: ChargeDto[];
}

/** One possible duplicate in ADMISSION_POSSIBLE_DUPLICATE `details.matches`. */
export interface DuplicateMatch {
  studentId: string;
  admissionNo: string;
  fullName: string;
  dateOfBirth: string;
  status: StudentStatus;
  className: string | null;
}

// ------------------------------------------------------------------------------- readmission

export class ReadmitDto {
  @ApiProperty(ID)
  @IsIdString()
  classId: string;

  @ApiProperty(ID)
  @IsIdString()
  sectionId: string;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 9999 })
  @IfPresent()
  @RollNoField()
  rollNo?: number;

  @ApiPropertyOptional({ ...DATE, description: 'No later than today; default today' })
  @IfPresent()
  @IsCalendarDate()
  readmittedOn?: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;

  @ApiPropertyOptional({
    type: AdmissionFeeDto,
    description: 'Readmission charges the admission fee again (R239) unless set partial or free.',
  })
  @IfPresent()
  @IsObject()
  @ValidateNested()
  @Type(() => AdmissionFeeDto)
  admissionFee?: AdmissionFeeDto;
}

/** The readmitted student, with the once-head charges readmission wrote (R239). */
export class ReadmissionResultDto extends StudentDetailDto {
  @ApiProperty({ type: [ChargeDto] })
  charges: ChargeDto[];
}
