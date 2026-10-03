import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { IDENTITY_INPUT_PATTERN } from '@asms/shared';
import { CnicField, NameField, PhoneField, TextField } from '../../../common/fields';

// contracts/slice-2.md §7.

export class IssuePrincipalLoginDto {
  @ApiProperty({ minLength: 2, maxLength: 200 })
  @NameField(2, 200, { collapse: false })
  fullName: string;

  /** 13 digits, dashes allowed. Never echoed, logged or returned. */
  @ApiProperty({
    description: '13 digits; dashes allowed (5-7-1).',
    pattern: IDENTITY_INPUT_PATTERN.source,
  })
  @CnicField()
  cnic: string;

  @ApiProperty({ description: 'Pakistani local or international form; stored as E.164.' })
  @PhoneField()
  phone: string;

  /** Required only while the school already has an active principal (R103). */
  @ApiPropertyOptional({ minLength: 3, maxLength: 500 })
  @IsOptional()
  @TextField(3, 500)
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
