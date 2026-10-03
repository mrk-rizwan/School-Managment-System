import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, Length, ValidateBy } from 'class-validator';
import { containsIdentityNumber, SYSTEM_ROLES, type SystemRole } from '@asms/shared';
import { QueryBoolean, TextField, trim } from '../../common/fields';
import { PageQueryDto } from '../../common/pagination';

// contracts/slice-2.md §5.

/** `reason`: trimmed, 3-500 characters, no identity number. */
const ReasonField = (): PropertyDecorator =>
  applyDecorators(ApiProperty({ minLength: 3, maxLength: 500 }), TextField(3, 500));

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];
const USER_KINDS = ['staff', 'guardian', 'student'] as const;
const USER_SORTS = ['fullName', '-fullName', 'lastLoginAt', '-lastLoginAt', 'createdAt', '-createdAt'] as const;

export class ListUsersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: USER_STATUSES, enumName: 'UserStatus' })
  @IsOptional()
  @IsIn(USER_STATUSES)
  status?: UserStatus;

  @QueryBoolean()
  passwordIsDefault?: boolean;

  @QueryBoolean()
  hasEmail?: boolean;

  @ApiPropertyOptional({ enum: USER_KINDS, enumName: 'UserKind' })
  @IsOptional()
  @IsIn(USER_KINDS)
  kind?: (typeof USER_KINDS)[number];

  /**
   * Full name, 2-100 characters. An identity number is refused, written plain, dashed or split by
   * spaces or `+` (`35202 1234567 1`): identity lookups are POST (§3.6), never a URL. Stricter
   * than SearchField's NoIdentityNumber, which does not see the split forms, so it stays local.
   */
  @ApiPropertyOptional({ minLength: 2, maxLength: 100 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  @ValidateBy({
    name: 'noIdentityNumber',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && !containsIdentityNumber(value.replace(/[\s+-]/g, '')),
      defaultMessage: () => '$property must not contain an identity number',
    },
  })
  q?: string;

  @ApiPropertyOptional({ enum: USER_SORTS, default: 'fullName' })
  @IsOptional()
  @IsIn(USER_SORTS)
  sort?: (typeof USER_SORTS)[number];
}

export class UserDto {
  @ApiProperty({ type: String })
  id: string;

  @ApiProperty({ type: String, nullable: true })
  staffId: string | null;

  @ApiProperty({ type: String, nullable: true })
  guardianId: string | null;

  @ApiProperty({ type: String, nullable: true })
  studentId: string | null;

  @ApiProperty()
  fullName: string;

  @ApiProperty({ enum: SYSTEM_ROLES, enumName: 'SystemRole', isArray: true })
  systemRoles: SystemRole[];

  @ApiProperty({ type: String, isArray: true, description: 'Names of the live custom roles' })
  customRoleNames: string[];

  @ApiProperty({ enum: USER_STATUSES, enumName: 'UserStatus' })
  status: UserStatus;

  /** `a***@example.com`. */
  @ApiProperty({ type: String, nullable: true })
  emailMasked: string | null;

  @ApiProperty()
  hasEmail: boolean;

  @ApiProperty()
  hasVerifiedEmail: boolean;

  @ApiProperty()
  passwordIsDefault: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastLoginAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

export class OfficeResetDto {
  @ReasonField()
  reason: string;

  /** Required: the clerk must choose to keep or clear the address (plan §5 slice 2). */
  @ApiProperty()
  @IsBoolean()
  clearEmail: boolean;
}

export class ReasonDto {
  @ReasonField()
  reason: string;
}
