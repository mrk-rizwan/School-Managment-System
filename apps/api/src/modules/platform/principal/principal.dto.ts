import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Length, Matches, ValidateBy } from 'class-validator';
import { IDENTITY_INPUT_PATTERN, normaliseIdentityDigits, normalisePhone } from '@asms/shared';
import { NoIdentityNumber } from '../../users/users.dto';

// contracts/slice-2.md §7.

const NO_CONTROL = /^[^\p{Cc}]*$/u;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const identityDigits = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && IDENTITY_INPUT_PATTERN.test(value.trim())
    ? (normaliseIdentityDigits(value) ?? value)
    : value;

/** A phone in any accepted local form becomes E.164; anything else is left to fail. */
const phone = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? (normalisePhone(value) ?? value) : value;

const IsE164 = (): PropertyDecorator =>
  ValidateBy({
    name: 'isE164',
    validator: {
      validate: (value: unknown) => typeof value === 'string' && /^\+[1-9][0-9]{7,14}$/.test(value),
      defaultMessage: () => '$property must be a phone number',
    },
  });

export class IssuePrincipalLoginDto {
  @ApiProperty({ minLength: 2, maxLength: 200 })
  @Transform(trim)
  @IsString()
  @Length(2, 200)
  @Matches(NO_CONTROL, { message: '$property must not contain control characters' })
  @NoIdentityNumber()
  fullName: string;

  /** 13 digits, dashes allowed. Never echoed, logged or returned. */
  @ApiProperty({ description: '13 digits; dashes allowed (5-7-1).' })
  @Transform(identityDigits)
  @IsString()
  @Matches(/^[0-9]{13}$/, { message: 'cnic must be 13 digits' })
  cnic: string;

  @ApiProperty({ description: 'Pakistani local or international form; stored as E.164.' })
  @Transform(phone)
  @IsString()
  @IsE164()
  phone: string;

  /** Required only while the school already has an active principal (R103). */
  @ApiPropertyOptional({ minLength: 3, maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(3, 500)
  @NoIdentityNumber()
  reason?: string;

  /**
   * Required (true) when a login with this CNIC already exists at the school: linking it resets
   * its password to the default, clears its email and ends its sessions. Absent → 409
   * LINK_EXISTING_LOGIN_UNCONFIRMED.
   */
  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  confirmLinkExisting?: boolean;
}

export class IssuedPrincipalLoginDto {
  @ApiProperty({ type: String })
  userId: string;

  @ApiProperty({ type: String })
  staffId: string;

  @ApiProperty()
  fullName: string;

  /** True when an existing login with the same CNIC (a guardian, say) was linked (R22). */
  @ApiProperty()
  linkedExistingUser: boolean;
}
