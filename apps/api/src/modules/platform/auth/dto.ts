import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches } from 'class-validator';
import {
  PLATFORM_SESSION_STAGES,
  type PlatformSessionStage,
} from '../../../common/auth/platform-session';
import { DiffersFrom, EmailField } from '../../../common/fields';
import {
  PLATFORM_EMAIL_OPTIONS,
  PLATFORM_PASSWORD_MAX,
  PLATFORM_PASSWORD_MIN,
} from '../../../config/env';

const TOTP_CODE = /^[0-9]{6}$/;

export class PlatformLoginDto {
  @ApiProperty({ minLength: 3, maxLength: 254, format: 'email' })
  @EmailField(PLATFORM_EMAIL_OPTIONS)
  email: string;

  /** No policy at login: only the bounds. */
  @ApiProperty({ minLength: 1, maxLength: PLATFORM_PASSWORD_MAX, format: 'password' })
  @IsString()
  @Length(1, PLATFORM_PASSWORD_MAX)
  password: string;

  @ApiProperty({ required: false, pattern: TOTP_CODE.source })
  @IsOptional()
  @IsString()
  @Matches(TOTP_CODE)
  totpCode?: string;
}

export class ConfirmTotpDto {
  @ApiProperty({ pattern: TOTP_CODE.source })
  @IsString()
  @Matches(TOTP_CODE)
  code: string;
}

export class ChangePlatformPasswordDto {
  @ApiProperty({ minLength: 1, maxLength: PLATFORM_PASSWORD_MAX, format: 'password' })
  @IsString()
  @Length(1, PLATFORM_PASSWORD_MAX)
  currentPassword: string;

  @ApiProperty({
    minLength: PLATFORM_PASSWORD_MIN,
    maxLength: PLATFORM_PASSWORD_MAX,
    format: 'password',
  })
  @IsString()
  @Length(PLATFORM_PASSWORD_MIN, PLATFORM_PASSWORD_MAX)
  @DiffersFrom('currentPassword')
  newPassword: string;
}

export class PlatformMeDto {
  @ApiProperty({ type: String })
  id: string;

  @ApiProperty()
  email: string;

  @ApiProperty({ enum: PLATFORM_SESSION_STAGES, enumName: 'PlatformSessionStage' })
  sessionStage: PlatformSessionStage;

  @ApiProperty()
  totpEnrolled: boolean;

  @ApiProperty()
  mustChangePassword: boolean;

  /** The session's absolute expiry. */
  @ApiProperty({ type: String, format: 'date-time' })
  sessionExpiresAt: Date;
}

/** Returned once by enrol. Never logged, no OpenAPI example. */
export class TotpEnrolmentDto {
  @ApiProperty()
  otpauthUri: string;

  @ApiProperty({ description: 'Base32, for manual entry.' })
  secret: string;
}
