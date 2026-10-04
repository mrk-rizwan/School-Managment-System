import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import {
  ATTENDANCE_MODES,
  CAPABILITY_SCOPES,
  CAPACITIES,
  Capability,
  type CapabilityScope,
  SESSION_CHANNELS,
  TEACHER_ROLES,
  type AttendanceMode,
  type Capacity,
  type SessionChannel,
  type TeacherRole,
  SCHOOL_STATUSES,
  SHORT_CODE_PATTERN,
  type SchoolStatus,
  RELATIONSHIPS,
  STUDENT_STATUSES,
  type Relationship,
  type StudentStatus,
} from '@asms/shared';
import { CnicField, DiffersFrom, EmailField, trimLower } from '../../common/fields';
import { SCHOOL_ROLES, type SchoolRole } from '../access/permissions.service';
import { StudentCurrentEnrolmentDto } from '../people/students/students.dto';

// contracts/slice-2.md §3 and §4.

export const PASSWORD_MAX = 128;
export const NEW_PASSWORD_MIN = 8;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

class SchoolCodeDto {
  @ApiProperty({ pattern: SHORT_CODE_PATTERN.source })
  @Transform(trimLower)
  @IsString()
  @Matches(SHORT_CODE_PATTERN, { message: 'schoolCode must be 3-12 lower-case letters or digits' })
  schoolCode: string;
}

export class SchoolLoginDto extends SchoolCodeDto {
  /** contracts/slice-9.md §3.1: bearer is the mobile app's channel and needs X-App-Version. */
  @ApiPropertyOptional({ enum: SESSION_CHANNELS, enumName: 'SessionChannel', default: 'cookie' })
  @IsOptional()
  @IsIn(SESSION_CHANNELS)
  channel?: SessionChannel;

  /** CNIC or B-Form digits, dashes allowed; normalised to 13 digits. No example (§3.9). */
  @ApiProperty({ description: '13 digits; dashes allowed (5-7-1).' })
  @CnicField()
  username: string;

  @ApiProperty({ minLength: 1, maxLength: PASSWORD_MAX, format: 'password' })
  @IsString()
  @Length(1, PASSWORD_MAX)
  password: string;
}

export class ForgotPasswordDto extends SchoolCodeDto {
  @ApiProperty({ description: '13 digits; dashes allowed (5-7-1).' })
  @CnicField()
  username: string;
}

export class VerifyEmailDto extends SchoolCodeDto {
  @ApiProperty({ pattern: TOKEN_PATTERN.source })
  @IsString()
  @Matches(TOKEN_PATTERN, { message: 'token is not valid' })
  token: string;
}

export class ResetPasswordDto extends VerifyEmailDto {
  @ApiProperty({ minLength: NEW_PASSWORD_MIN, maxLength: PASSWORD_MAX, format: 'password' })
  @IsString()
  @Length(NEW_PASSWORD_MIN, PASSWORD_MAX)
  newPassword: string;
}

export class ChangeEmailDto {
  @ApiProperty({ minLength: 1, maxLength: PASSWORD_MAX, format: 'password' })
  @IsString()
  @Length(1, PASSWORD_MAX)
  currentPassword: string;

  @ApiProperty({ minLength: 3, maxLength: 254, format: 'email' })
  @EmailField()
  email: string;
}

export class ChangePasswordDto {
  @ApiProperty({ minLength: 1, maxLength: PASSWORD_MAX, format: 'password' })
  @IsString()
  @Length(1, PASSWORD_MAX)
  currentPassword: string;

  @ApiProperty({ minLength: NEW_PASSWORD_MIN, maxLength: PASSWORD_MAX, format: 'password' })
  @IsString()
  @Length(NEW_PASSWORD_MIN, PASSWORD_MAX)
  @DiffersFrom('currentPassword')
  newPassword: string;
}

export class MeSchoolDto {
  @ApiProperty({ type: String })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  shortCode: string;

  @ApiProperty({ enum: SCHOOL_STATUSES, enumName: 'SchoolStatus' })
  status: SchoolStatus;
}

/** contracts/slice-2.md §4.1, slice-9.md §2.2. Never carries a token, username or identity number. */
/** Where an effective capability comes from, as breadth only (contracts/slice-14.md §8). */
export class MeCapabilityScopeDto {
  @ApiProperty({ enum: Object.values(Capability), enumName: 'Capability' })
  capability: Capability;

  /**
   * `all`: a school-wide source (principal or office default, custom role, grant).
   * `assigned_sections`: held only through the teacher default, so rows come from assignments (R79).
   */
  @ApiProperty({ enum: CAPABILITY_SCOPES, enumName: 'CapabilityScope' })
  scope: CapabilityScope;
}

export class MeDto {
  @ApiProperty({ type: String })
  id: string;

  @ApiProperty()
  fullName: string;

  @ApiProperty({ type: String, nullable: true })
  email: string | null;

  @ApiProperty()
  hasVerifiedEmail: boolean;

  @ApiProperty()
  passwordIsDefault: boolean;

  @ApiProperty({ type: MeSchoolDto })
  school: MeSchoolDto;

  @ApiProperty({ enum: SCHOOL_ROLES, enumName: 'SchoolRole', isArray: true })
  roles: SchoolRole[];

  @ApiProperty({ enum: Object.values(Capability), enumName: 'Capability', isArray: true })
  capabilities: Capability[];

  /** One entry per effective capability, in the same order as `capabilities` (slice-14 §8). */
  @ApiProperty({ type: () => MeCapabilityScopeDto, isArray: true })
  capabilityScopes: MeCapabilityScopeDto[];

  @ApiProperty({ type: String, format: 'date-time' })
  sessionExpiresAt: Date;

  /** Active capacities, in the order staff, guardian, student (the app composes its tabs, R156). */
  @ApiProperty({ enum: CAPACITIES, enumName: 'Capacity', isArray: true })
  capacities: Capacity[];

  /** Teacher assignments active today, cover included; [] without staff capacity (slice-9 §2.2). */
  @ApiProperty({ type: () => MeAssignmentDto, isArray: true })
  assignments: MeAssignmentDto[];

  /** The caller's staff id, so a client can tell its own authorship (contracts/slice-13.md §1.2). */
  @ApiProperty({ type: String, nullable: true })
  staffId: string | null;

  /**
   * The guardian scope's children with their current enrolment, by name; [] without guardian
   * capacity (contracts/slice-13.md §1.2, §2.2). The app composes the guardian tab from it (R156).
   */
  @ApiProperty({ type: () => MyChildDto, isArray: true })
  children: MyChildDto[];
}

/**
 * A child in the guardian's scope (contracts/slice-13.md §2.2). Nothing else: no admission number,
 * no identity number, no photo, nothing about another guardian (R165).
 */
export class MyChildDto {
  @ApiProperty({ type: String })
  studentId: string;

  @ApiProperty()
  fullName: string;

  @ApiProperty({ enum: STUDENT_STATUSES, enumName: 'StudentStatus' })
  status: StudentStatus;

  /** This guardian's own link. */
  @ApiProperty({ enum: RELATIONSHIPS, enumName: 'Relationship' })
  relationship: Relationship;

  @ApiProperty({ type: StudentCurrentEnrolmentDto, nullable: true })
  current: StudentCurrentEnrolmentDto | null;
}

// ----------------------------------------------------------- contracts/slice-9.md §2.2, §3

/** One of the caller's teacher assignments active today (cover included). */
export class MeAssignmentDto {
  @ApiProperty({ type: String })
  id: string;

  @ApiProperty({ enum: TEACHER_ROLES, enumName: 'TeacherRole' })
  role: TeacherRole;

  @ApiProperty({ type: String })
  academicYearId: string;

  @ApiProperty({ type: String })
  classId: string;

  @ApiProperty()
  className: string;

  /** Null for a whole-class subject teacher (R54). */
  @ApiProperty({ type: String, nullable: true })
  sectionId: string | null;

  @ApiProperty({ type: String, nullable: true })
  sectionName: string | null;

  @ApiProperty({ type: String, nullable: true })
  subjectId: string | null;

  @ApiProperty({ type: String, nullable: true })
  subjectName: string | null;

  @ApiProperty({ enum: ATTENDANCE_MODES, enumName: 'AttendanceMode' })
  attendanceMode: AttendanceMode;

  @ApiProperty({ type: String, format: 'date' })
  startsOn: string;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  endsOn: string | null;
}

/** Login and password change (contracts/slice-9.md §2.2, R153). */
export class LoginResultDto extends MeDto {
  /** The 43-character token only on a bearer session; null for cookie (the token is in the cookie). */
  @ApiProperty({ type: String, nullable: true, description: 'Bearer sessions only; null for cookie.' })
  bearerToken: string | null;
}
