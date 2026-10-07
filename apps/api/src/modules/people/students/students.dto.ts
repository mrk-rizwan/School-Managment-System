import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  CONTACT_CAPABILITIES,
  ENROLMENT_STATUSES,
  GENDERS,
  IDENTITY_INPUT_PATTERN,
  RELATIONSHIPS,
  STUDENT_STATUSES,
  type ContactCapability,
  type EnrolmentStatus,
  type Gender,
  type Relationship,
  type StudentStatus,
} from '@asms/shared';
import {
  CnicField,
  IfPresent,
  IsCalendarDate,
  NameField,
  NoIdentityNumber,
  NoticeTextField,
  QueryBoolean,
  TextField,
  trim,
} from '../../../common/fields';
import { ID_PATTERN, IsIdString } from '../../../common/ids';
import { PageQueryDto } from '../../../common/pagination';

// contracts/slice-6.md §2-§5. B-Form digits are accepted in bodies only, never echoed: a response
// carries the masked form, and only to a caller holding student.update. The field decorators
// below are exported for the admission and readmission DTOs (slice 6B) so a student field is
// checked the same way on every route.

const ID = { type: String, pattern: ID_PATTERN.source } as const;
const NULLABLE_ID = { ...ID, nullable: true } as const;
const DATE = { type: String, format: 'date' } as const;
const DATE_TIME = { type: String, format: 'date-time' } as const;

// --------------------------------------------------------------------------- student fields

export const StudentFullName = (): PropertyDecorator => NameField(2, 200);
export const GenderField = (): PropertyDecorator => IsIn(GENDERS);
export const StudentNotes = (): PropertyDecorator => TextField(0, 2000);
export const Reason = (): PropertyDecorator => TextField(3, 500);
export const RollNoField = (): PropertyDecorator => applyDecorators(IsInt(), Min(1), Max(9999));

// ------------------------------------------------------------------------------------ responses

export class StudentCurrentEnrolmentDto {
  @ApiProperty(ID)
  enrolmentId: string;

  @ApiProperty(ID)
  academicYearId: string;

  @ApiProperty()
  academicYearName: string;

  @ApiProperty(ID)
  classId: string;

  @ApiProperty()
  className: string;

  @ApiProperty(ID)
  sectionId: string;

  @ApiProperty()
  sectionName: string;

  @ApiProperty({ type: Number, nullable: true })
  rollNo: number | null;
}

export class StudentDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty({ description: 'Digits' })
  admissionNo: string;

  @ApiProperty()
  fullName: string;

  @ApiProperty({ enum: GENDERS, enumName: 'Gender' })
  gender: Gender;

  @ApiProperty(DATE)
  dateOfBirth: string;

  @ApiProperty()
  hasBForm: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Masked, e.g. 35201-*****-1; null unless the caller holds student.update',
  })
  bFormMasked: string | null;

  @ApiProperty({ enum: STUDENT_STATUSES, enumName: 'StudentStatus' })
  status: StudentStatus;

  @ApiProperty(DATE)
  admittedOn: string;

  @ApiProperty({ type: StudentCurrentEnrolmentDto, nullable: true })
  current: StudentCurrentEnrolmentDto | null;

  @ApiProperty(NULLABLE_ID)
  userId: string | null;

  @ApiProperty(DATE_TIME)
  createdAt: Date;

  @ApiProperty(DATE_TIME)
  updatedAt: Date;
}

export class StudentDetailDto extends StudentDto {
  @ApiProperty({ type: String, nullable: true, description: 'Null unless student.update' })
  notes: string | null;

  @ApiProperty({ ...NULLABLE_ID, description: 'Latest photo; null unless document.view' })
  photoDocumentId: string | null;
}

export class StudentLookupHitDto {
  @ApiProperty({ type: StudentDto })
  student: StudentDto;

  @ApiProperty({ description: 'withdrawn, transferred or alumni: readmit instead (R26)' })
  readmissible: boolean;
}

export class StudentLookupResultDto {
  @ApiProperty({ type: [StudentLookupHitDto] })
  data: StudentLookupHitDto[];

  @ApiProperty({ description: 'Always false: a B-Form matches at most one student' })
  truncated: boolean;
}

export class GuardianLinkDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(ID)
  studentId: string;

  @ApiProperty(ID)
  guardianId: string;

  @ApiProperty()
  guardianFullName: string;

  @ApiProperty({ enum: RELATIONSHIPS, enumName: 'Relationship' })
  relationship: Relationship;

  @ApiProperty()
  isPrimaryContact: boolean;

  @ApiProperty()
  isFeePayer: boolean;

  @ApiProperty()
  canLogin: boolean;

  @ApiProperty({ type: String, nullable: true, description: 'E.164' })
  phone: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  endedAt: Date | null;

  @ApiProperty({
    enum: CONTACT_CAPABILITIES,
    enumName: 'ContactCapability',
    nullable: true,
    description: 'Null unless guardian.manage',
  })
  contactCapability: ContactCapability | null;

  @ApiProperty({ type: String, nullable: true, description: 'Masked; null unless guardian.manage' })
  guardianCnicMasked: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Null unless guardian.manage' })
  guardianAddress: string | null;

  @ApiProperty({ ...NULLABLE_ID, description: 'Null unless guardian.manage' })
  guardianUserId: string | null;
}

export class EnrolmentDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(ID)
  studentId: string;

  @ApiProperty(ID)
  academicYearId: string;

  @ApiProperty()
  academicYearName: string;

  @ApiProperty(ID)
  classId: string;

  @ApiProperty()
  className: string;

  @ApiProperty(ID)
  sectionId: string;

  @ApiProperty()
  sectionName: string;

  @ApiProperty({ type: Number, nullable: true })
  rollNo: number | null;

  @ApiProperty({ enum: ENROLMENT_STATUSES, enumName: 'EnrolmentStatus' })
  status: EnrolmentStatus;

  @ApiProperty(DATE)
  startedOn: string;

  @ApiProperty({ ...DATE, nullable: true })
  endedOn: string | null;
}

export class StatusChangeDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty({
    enum: STUDENT_STATUSES,
    enumName: 'StudentStatus',
    nullable: true,
    description: 'Null for the admission row',
  })
  fromStatus: StudentStatus | null;

  @ApiProperty({ enum: STUDENT_STATUSES, enumName: 'StudentStatus' })
  toStatus: StudentStatus;

  @ApiProperty({ type: String, nullable: true })
  reason: string | null;

  @ApiProperty(DATE)
  effectiveOn: string;

  @ApiProperty({ ...ID, description: 'The user who made the change' })
  changedBy: string;

  @ApiProperty()
  changedByName: string;

  @ApiProperty(DATE_TIME)
  createdAt: Date;
}

// --------------------------------------------------------------------------------------- inputs

export const STUDENT_SORTS = [
  'fullName',
  '-fullName',
  'admissionNo',
  '-admissionNo',
  'admittedOn',
  '-admittedOn',
  'rollNo',
] as const;
export type StudentSortParam = (typeof STUDENT_SORTS)[number];

export class ListStudentsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: STUDENT_STATUSES, enumName: 'StudentStatus' })
  @IsOptional()
  @IsIn(STUDENT_STATUSES)
  status?: StudentStatus;

  @ApiPropertyOptional({ ...ID, description: 'Of the active enrolment' })
  @IsOptional()
  @IsIdString()
  academicYearId?: string;

  @ApiPropertyOptional({ ...ID, description: 'Of the active enrolment' })
  @IsOptional()
  @IsIdString()
  classId?: string;

  @ApiPropertyOptional({ ...ID, description: 'Of the active enrolment' })
  @IsOptional()
  @IsIdString()
  sectionId?: string;

  @ApiPropertyOptional({ enum: GENDERS, enumName: 'Gender' })
  @IsOptional()
  @GenderField()
  gender?: Gender;

  @QueryBoolean()
  hasBForm?: boolean;

  @QueryBoolean()
  hasLogin?: boolean;

  @ApiPropertyOptional(DATE)
  @IsOptional()
  @IsCalendarDate()
  admittedOnFrom?: string;

  @ApiPropertyOptional(DATE)
  @IsOptional()
  @IsCalendarDate()
  admittedOnTo?: string;

  @ApiPropertyOptional({
    minLength: 2,
    maxLength: 100,
    description:
      'Name contains, or admission number starts with. A B-Form is refused: use POST /students/lookup.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  @NoIdentityNumber({
    ignoreSeparators: true,
    message: '$property must not be a B-Form number: use POST /students/lookup to find by B-Form',
  })
  q?: string;

  @ApiPropertyOptional({ enum: STUDENT_SORTS, enumName: 'StudentSort', default: 'fullName' })
  @IsOptional()
  @IsIn(STUDENT_SORTS)
  sort?: StudentSortParam;
}

export class StudentLookupDto {
  @ApiProperty({
    type: String,
    pattern: IDENTITY_INPUT_PATTERN.source,
    description: 'Never returned',
  })
  @CnicField()
  bForm: string;
}

/** Absent = unchanged; null = clear. fullName, gender and dateOfBirth cannot be cleared. */
export class UpdateStudentDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 200 })
  @IfPresent()
  @StudentFullName()
  fullName?: string;

  @ApiPropertyOptional({ enum: GENDERS, enumName: 'Gender' })
  @IfPresent()
  @GenderField()
  gender?: Gender;

  @ApiPropertyOptional({ ...DATE, description: 'No later than today, at most 30 years ago' })
  @IfPresent()
  @IsCalendarDate()
  dateOfBirth?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: IDENTITY_INPUT_PATTERN.source,
    description: 'Refused with 409 STUDENT_BFORM_LOCKED once the student has a login',
  })
  @IsOptional()
  @CnicField()
  bForm?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @StudentNotes()
  notes?: string | null;
}

export class ChangeStatusDto {
  @ApiProperty({ enum: STUDENT_STATUSES, enumName: 'StudentStatus' })
  @IsIn(STUDENT_STATUSES)
  status: StudentStatus;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;

  @ApiProperty({ ...DATE, description: 'No later than today' })
  @IsCalendarDate()
  effectiveOn: string;
}

export class ListGuardianLinksQueryDto extends PageQueryDto {
  @QueryBoolean({ default: false })
  includeEnded?: boolean;
}

export class CreateGuardianLinkDto {
  @ApiProperty(ID)
  @IsIdString()
  guardianId: string;

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

/** Absent = unchanged; null is refused on every field. */
export class UpdateGuardianLinkDto {
  @ApiPropertyOptional({ enum: RELATIONSHIPS, enumName: 'Relationship' })
  @IfPresent()
  @IsIn(RELATIONSHIPS)
  relationship?: Relationship;

  @ApiPropertyOptional()
  @IfPresent()
  @IsBoolean()
  isPrimaryContact?: boolean;

  @ApiPropertyOptional()
  @IfPresent()
  @IsBoolean()
  isFeePayer?: boolean;

  @ApiPropertyOptional()
  @IfPresent()
  @IsBoolean()
  canLogin?: boolean;
}

/** `rollNo` is required; null clears it. */
export class UpdateEnrolmentDto {
  @ApiProperty({ type: Number, nullable: true, minimum: 1, maximum: 9999 })
  @ValidateIf((_object, value) => value !== null)
  @RollNoField()
  rollNo: number | null;
}

/** contracts/slice-10.md §8.2: close-old/open-new from `effectiveOn` (R174). */
export class ChangeSectionDto {
  @ApiProperty({ ...ID, description: 'Another section of the same class' })
  @IsIdString()
  sectionId: string;

  @ApiProperty({
    ...DATE,
    description:
      'The first day in the new section: on or after the current enrolment started, no later than today. The current enrolment ends the day before.',
  })
  @IsCalendarDate()
  effectiveOn: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @NoticeTextField(3, 500)
  reason: string;
}

/** The closed enrolment and the one opened in its place (contracts/slice-10.md §2, §8). */
export class SectionChangeResultDto {
  @ApiProperty({ type: EnrolmentDto })
  closed: EnrolmentDto;

  @ApiProperty({ type: EnrolmentDto })
  opened: EnrolmentDto;
}

export class ChangeClassDto {
  @ApiProperty(ID)
  @IsIdString()
  classId: string;

  @ApiProperty(ID)
  @IsIdString()
  sectionId: string;

  @ApiProperty({
    ...DATE,
    description:
      'The first day in the new class: on or after the current enrolment started, no later than today. The current enrolment ends the day before.',
  })
  @IsCalendarDate()
  effectiveOn: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;
}
