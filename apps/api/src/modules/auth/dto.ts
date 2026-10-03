import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length, Matches, ValidateBy, type ValidationArguments } from 'class-validator';
import {
  Capability,
  IDENTITY_INPUT_PATTERN,
  normaliseIdentityDigits,
  SCHOOL_STATUSES,
  SHORT_CODE_PATTERN,
  type SchoolStatus,
} from '@asms/shared';
import { SCHOOL_ROLES, type SchoolRole } from '../access/permissions.service';

// contracts/slice-2.md §3 and §4.

export const PASSWORD_MAX = 128;
export const NEW_PASSWORD_MIN = 8;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const trimLower = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/** Dashes and spaces stripped; anything that is not 13 digits passes through to fail the pattern. */
const identityDigits = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && IDENTITY_INPUT_PATTERN.test(value.trim())
    ? (normaliseIdentityDigits(value) ?? value)
    : value;

/** The value must differ from the named sibling property. */
export const DiffersFrom = (property: string): PropertyDecorator =>
  ValidateBy({
    name: 'differsFrom',
    constraints: [property],
    validator: {
      validate: (value: unknown, args?: ValidationArguments) => {
        const object: unknown = args?.object;
        const other: unknown =
          typeof object === 'object' && object !== null ? Reflect.get(object, property) : undefined;
        return value !== other;
      },
      defaultMessage: () => `$property must differ from ${property}`,
    },
  });

class SchoolCodeDto {
  @ApiProperty({ pattern: SHORT_CODE_PATTERN.source })
  @Transform(trimLower)
  @IsString()
  @Matches(SHORT_CODE_PATTERN, { message: 'schoolCode must be 3-12 lower-case letters or digits' })
  schoolCode: string;
}

export class SchoolLoginDto extends SchoolCodeDto {
  /** CNIC or B-Form digits, dashes allowed; normalised to 13 digits. No example (§3.9). */
  @ApiProperty({ description: '13 digits; dashes allowed (5-7-1).' })
  @Transform(identityDigits)
  @IsString()
  @Matches(/^[0-9]{13}$/, { message: 'username must be 13 digits' })
  username: string;

  @ApiProperty({ minLength: 1, maxLength: PASSWORD_MAX, format: 'password' })
  @IsString()
  @Length(1, PASSWORD_MAX)
  password: string;
}

export class ForgotPasswordDto extends SchoolCodeDto {
  @ApiProperty({ description: '13 digits; dashes allowed (5-7-1).' })
  @Transform(identityDigits)
  @IsString()
  @Matches(/^[0-9]{13}$/, { message: 'username must be 13 digits' })
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
  @Transform(trimLower)
  @IsString()
  @Length(3, 254)
  @IsEmail()
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

/** contracts/slice-2.md §4.1. Never carries a username or identity number. */
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

  @ApiProperty({ type: String, format: 'date-time' })
  sessionExpiresAt: Date;
}
