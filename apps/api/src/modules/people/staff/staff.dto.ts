import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, Length } from 'class-validator';
import {
  IDENTITY_INPUT_PATTERN,
  STAFF_STATUSES,
  SYSTEM_ROLES,
  TEACHER_ROLES,
  type StaffStatus,
  type SystemRole,
  type TeacherRole,
} from '@asms/shared';
import {
  CnicField,
  IfPresent,
  IfPresentNotNull,
  IsCalendarDate,
  NameField,
  NoIdentityNumber,
  PhoneField,
  QueryBoolean,
  TextField,
  trim,
} from '../../../common/fields';
import { ID_PATTERN, IsIdString } from '../../../common/ids';
import { PageQueryDto } from '../../../common/pagination';

// contracts/slice-4.md §2-§5. Identity numbers are accepted in bodies only, never echoed: every
// response carries the masked form.

const ID = { type: String, pattern: ID_PATTERN.source } as const;
const NULLABLE_ID = { ...ID, nullable: true } as const;
const DATE = { type: String, format: 'date' } as const;
const DATE_TIME = { type: String, format: 'date-time' } as const;
const STATUS = { enum: STAFF_STATUSES, enumName: 'StaffStatus' } as const;
const SYSTEM_ROLE = { enum: SYSTEM_ROLES, enumName: 'SystemRole' } as const;

/** `reason`: trimmed, 3-500 characters, no identity number. */
const ReasonField = (): PropertyDecorator =>
  applyDecorators(ApiProperty({ minLength: 3, maxLength: 500 }), TextField(3, 500));

// ------------------------------------------------------------------------------------ responses

export class StaffDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty()
  fullName: string;

  @ApiProperty({ type: String, nullable: true, description: 'Masked, e.g. 35201-*****-1' })
  cnicMasked: string | null;

  @ApiProperty()
  hasCnic: boolean;

  @ApiProperty({ description: 'E.164' })
  phone: string;

  @ApiProperty({ type: String, nullable: true })
  designation: string | null;

  @ApiProperty({ ...DATE, nullable: true })
  joinedOn: string | null;

  @ApiProperty(STATUS)
  status: StaffStatus;

  @ApiProperty({ ...NULLABLE_ID, description: 'The login whose staff_id is this row, if any' })
  userId: string | null;

  @ApiProperty({ ...SYSTEM_ROLE, isArray: true, description: 'Live roles of that login' })
  systemRoles: SystemRole[];

  @ApiProperty({ type: String, isArray: true, description: 'Names of the live custom roles of that login' })
  customRoleNames: string[];

  @ApiProperty(DATE_TIME)
  createdAt: Date;

  @ApiProperty(DATE_TIME)
  updatedAt: Date;
}

export class TeacherAssignmentDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(ID)
  staffId: string;

  @ApiProperty()
  staffFullName: string;

  @ApiProperty(ID)
  academicYearId: string;

  @ApiProperty()
  academicYearName: string;

  @ApiProperty(ID)
  classId: string;

  @ApiProperty()
  className: string;

  @ApiProperty(NULLABLE_ID)
  sectionId: string | null;

  @ApiProperty({ type: String, nullable: true })
  sectionName: string | null;

  @ApiProperty(NULLABLE_ID)
  subjectId: string | null;

  @ApiProperty({ type: String, nullable: true })
  subjectName: string | null;

  @ApiProperty({ enum: TEACHER_ROLES, enumName: 'TeacherRole' })
  role: TeacherRole;

  @ApiProperty(DATE)
  startsOn: string;

  @ApiProperty({ ...DATE, nullable: true })
  endsOn: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  voidedAt: Date | null;

  @ApiProperty({ description: 'Counts today in the school’s time zone' })
  activeToday: boolean;

  @ApiProperty(DATE_TIME)
  createdAt: Date;
}

export class UserRoleDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(ID)
  userId: string;

  @ApiProperty({ ...SYSTEM_ROLE, nullable: true })
  systemRole: SystemRole | null;

  @ApiProperty({ ...NULLABLE_ID, description: 'Set exactly when systemRole is null' })
  customRoleId: string | null;

  @ApiProperty({ type: String, nullable: true })
  customRoleName: string | null;

  @ApiProperty({ ...NULLABLE_ID, description: 'Null when issued by the platform' })
  assignedBy: string | null;

  @ApiProperty(DATE_TIME)
  assignedAt: Date;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  endedAt: Date | null;

  @ApiProperty(NULLABLE_ID)
  endedBy: string | null;
}

// ------------------------------------------------------------------------------------ staff

export const STAFF_SORTS = [
  'fullName',
  '-fullName',
  'joinedOn',
  '-joinedOn',
  'createdAt',
  '-createdAt',
] as const;
export type StaffSortParam = (typeof STAFF_SORTS)[number];

export class ListStaffQueryDto extends PageQueryDto {
  @ApiPropertyOptional(STATUS)
  @IsOptional()
  @IsIn(STAFF_STATUSES)
  status?: StaffStatus;

  @ApiPropertyOptional({ ...SYSTEM_ROLE, description: 'Staff whose login holds this live role' })
  @IsOptional()
  @IsIn(SYSTEM_ROLES)
  role?: SystemRole;

  @QueryBoolean()
  hasLogin?: boolean;

  @QueryBoolean()
  hasCnic?: boolean;

  @ApiPropertyOptional({
    minLength: 2,
    maxLength: 100,
    description: 'Name or designation contains; a 4-12 digit run also matches phone. A CNIC is refused.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  @NoIdentityNumber({ ignoreSeparators: true, message: '$property must not contain a CNIC' })
  q?: string;

  @ApiPropertyOptional({ enum: STAFF_SORTS, enumName: 'StaffSort', default: 'fullName' })
  @IsOptional()
  @IsIn(STAFF_SORTS)
  sort?: StaffSortParam;
}

export class CreateStaffDto {
  @ApiProperty({ minLength: 2, maxLength: 200 })
  @NameField(2, 200)
  fullName: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: IDENTITY_INPUT_PATTERN.source,
    description: 'CNIC, 13 digits, dashes optional. Never returned.',
  })
  @IsOptional()
  @CnicField()
  cnic?: string | null;

  @ApiProperty({ description: 'Normalised to E.164 (+92 default)' })
  @PhoneField()
  phone: string;

  @ApiPropertyOptional({ type: String, nullable: true, minLength: 1, maxLength: 100 })
  @IsOptional()
  @NameField(1, 100)
  designation?: string | null;

  @ApiPropertyOptional({ ...DATE, description: 'At most 366 days ahead' })
  @IfPresent()
  @IsCalendarDate()
  joinedOn?: string;
}

/** Absent = unchanged; null = clear. fullName and phone cannot be cleared. */
export class UpdateStaffDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 200 })
  @IfPresent()
  @NameField(2, 200)
  fullName?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: IDENTITY_INPUT_PATTERN.source,
    description: 'Refused with 409 STAFF_CNIC_LOCKED once the staff member has a login',
  })
  @IsOptional()
  @CnicField()
  cnic?: string | null;

  @ApiPropertyOptional()
  @IfPresent()
  @PhoneField()
  phone?: string;

  @ApiPropertyOptional({ type: String, nullable: true, minLength: 1, maxLength: 100 })
  @IsOptional()
  @NameField(1, 100)
  designation?: string | null;

  @ApiPropertyOptional({ ...DATE, nullable: true })
  @IfPresentNotNull()
  @IsCalendarDate()
  joinedOn?: string | null;
}

export class ChangeStaffStatusDto {
  @ApiProperty(STATUS)
  @IsIn(STAFF_STATUSES)
  status: StaffStatus;

  @ReasonField()
  reason: string;
}

export class IssueStaffLoginDto {
  @ApiProperty(SYSTEM_ROLE)
  @IsIn(SYSTEM_ROLES)
  systemRole: SystemRole;

  /**
   * Must be true when a login with this CNIC already exists at the school: linking it resets its
   * password to the default, clears its email and ends its sessions.
   */
  @ApiPropertyOptional({ type: Boolean })
  @IfPresent()
  @IsBoolean()
  confirmLinkExisting?: boolean;
}

// ----------------------------------------------------------------------- teacher assignments

export const TEACHER_ASSIGNMENT_SORTS = ['-startsOn', 'startsOn', 'className'] as const;
export type TeacherAssignmentSortParam = (typeof TEACHER_ASSIGNMENT_SORTS)[number];

export class ListTeacherAssignmentsQueryDto extends PageQueryDto {
  @QueryBoolean({ default: false, description: 'Include rows voided or ended before today' })
  includeEnded?: boolean;

  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  academicYearId?: string;

  @ApiPropertyOptional({
    enum: TEACHER_ASSIGNMENT_SORTS,
    enumName: 'TeacherAssignmentSort',
    default: '-startsOn',
  })
  @IsOptional()
  @IsIn(TEACHER_ASSIGNMENT_SORTS)
  sort?: TeacherAssignmentSortParam;
}

/** Role-dependent presence (section, subject, replaceCurrent) is checked by the service. */
export class CreateTeacherAssignmentDto {
  @ApiProperty({ enum: TEACHER_ROLES, enumName: 'TeacherRole' })
  @IsIn(TEACHER_ROLES)
  role: TeacherRole;

  @ApiProperty({ ...ID, description: 'The academic year is the class’s' })
  @IsIdString()
  classId: string;

  @ApiPropertyOptional({
    ...NULLABLE_ID,
    description: 'Required for a class teacher; null for a subject teacher = every section',
  })
  @IfPresentNotNull()
  @IsIdString()
  sectionId?: string | null;

  @ApiPropertyOptional({ ...NULLABLE_ID, description: 'Required for a subject teacher only' })
  @IfPresentNotNull()
  @IsIdString()
  subjectId?: string | null;

  @ApiPropertyOptional({ ...DATE, description: 'Default max(today, year start); not before today' })
  @IfPresent()
  @IsCalendarDate()
  startsOn?: string;

  @ApiPropertyOptional({ ...DATE, nullable: true })
  @IfPresentNotNull()
  @IsCalendarDate()
  endsOn?: string | null;

  @ApiPropertyOptional({ type: Boolean, description: 'Class teacher only: end or void the current one' })
  @IfPresent()
  @IsBoolean()
  replaceCurrent?: boolean;
}

export class EndTeacherAssignmentDto {
  @ApiPropertyOptional({ ...DATE, description: 'A planned last day; absent = stop counting today' })
  @IfPresent()
  @IsCalendarDate()
  endsOn?: string;

  @ApiPropertyOptional({ minLength: 3, maxLength: 500 })
  @IfPresent()
  @TextField(3, 500)
  reason?: string;
}

// ----------------------------------------------------------------------------- system roles

export class ListUserRolesQueryDto extends PageQueryDto {
  @QueryBoolean({ default: false })
  includeEnded?: boolean;

  @ApiPropertyOptional({ enum: ['-assignedAt'], default: '-assignedAt' })
  @IsOptional()
  @IsIn(['-assignedAt'])
  sort?: '-assignedAt';
}

/** Exactly one of systemRole / customRoleId (contracts/slice-7.md §3.6; checked by the service). */
export class AssignRoleDto {
  @ApiPropertyOptional(SYSTEM_ROLE)
  @IfPresent()
  @IsIn(SYSTEM_ROLES)
  systemRole?: SystemRole;

  @ApiPropertyOptional(ID)
  @IfPresent()
  @IsIdString()
  customRoleId?: string;

  @ReasonField()
  reason: string;
}

export class RemoveRoleDto {
  @ReasonField()
  reason: string;
}
