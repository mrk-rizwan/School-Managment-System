import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { applyDecorators } from '@nestjs/common';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsNotIn,
  IsOptional,
  Matches,
} from 'class-validator';
import {
  CAPABILITY_GROUP_NAMES,
  CAPABILITY_SCOPES,
  CAPABILITY_SOURCE_KINDS,
  CUSTOM_ROLE_KEY_PATTERN,
  CUSTOM_ROLE_STATUSES,
  Capability,
  GRANT_EFFECTS,
  RESERVED_CUSTOM_ROLE_KEYS,
  STAFF_STATUSES,
  SYSTEM_ROLES,
  type CapabilityGroup,
  type CapabilityScope,
  type CapabilitySourceKind,
  type CustomRoleStatus,
  type GrantEffect,
  type StaffStatus,
  type SystemRole,
} from '@asms/shared';
import {
  IfPresent,
  NameField,
  NoIdentityNumber,
  QueryBoolean,
  SearchField,
  TextField,
  trim,
} from '../../common/fields';
import { ID_PATTERN } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';

// contracts/slice-7.md §2-§5.

const ID = { type: String, pattern: ID_PATTERN.source } as const;
const NULLABLE_ID = { ...ID, nullable: true } as const;
const DATE_TIME = { type: String, format: 'date-time' } as const;
const ALL_CAPABILITIES: readonly Capability[] = Object.values(Capability);
const CAPABILITY = { enum: ALL_CAPABILITIES, enumName: 'Capability' } as const;
/** Every key but role.manage, which no custom role or grant row may carry (R45, R75). */
const DELEGABLE_CAPABILITIES: readonly Capability[] = ALL_CAPABILITIES.filter(
  (key) => key !== Capability.ROLE_MANAGE,
);
const SYSTEM_ROLE = { enum: SYSTEM_ROLES, enumName: 'SystemRole' } as const;
const KEY = { pattern: CUSTOM_ROLE_KEY_PATTERN.source } as const;

const notRoleManage = '$property must be a capability other than role.manage';

// ------------------------------------------------------------------------------------ responses

export class CustomRoleDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(KEY)
  key: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ enum: CUSTOM_ROLE_STATUSES, enumName: 'CustomRoleStatus' })
  status: CustomRoleStatus;

  @ApiProperty({ ...CAPABILITY, isArray: true, description: 'Live keys, registry order' })
  capabilities: Capability[];

  @ApiProperty({ description: 'Live role rows on this role, any user or staff status' })
  holderCount: number;

  @ApiProperty(DATE_TIME)
  createdAt: Date;

  @ApiProperty(DATE_TIME)
  updatedAt: Date;
}

export class GrantDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(ID)
  userId: string;

  @ApiProperty(CAPABILITY)
  capability: Capability;

  @ApiProperty({ enum: GRANT_EFFECTS, enumName: 'GrantEffect' })
  effect: GrantEffect;

  @ApiProperty()
  reason: string;

  @ApiProperty(ID)
  grantedBy: string;

  @ApiProperty({ type: String, nullable: true, description: "The grantor's staff name" })
  grantedByName: string | null;

  @ApiProperty(DATE_TIME)
  grantedAt: Date;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  revokedAt: Date | null;

  @ApiProperty(NULLABLE_ID)
  revokedBy: string | null;

  @ApiProperty({ type: String, nullable: true })
  revokedByName: string | null;

  @ApiProperty({ type: String, nullable: true, description: '"staff left" when ended by R17' })
  endReason: string | null;
}

export class PermissionRoleDto {
  @ApiProperty(ID)
  userRoleId: string;

  @ApiProperty({ ...SYSTEM_ROLE, nullable: true })
  systemRole: SystemRole | null;

  @ApiProperty(NULLABLE_ID)
  customRoleId: string | null;

  @ApiProperty({ type: String, nullable: true })
  customRoleName: string | null;

  @ApiProperty({ enum: CUSTOM_ROLE_STATUSES, enumName: 'CustomRoleStatus', nullable: true })
  customRoleStatus: CustomRoleStatus | null;

  @ApiProperty({ ...CAPABILITY, isArray: true, description: "The role's defaults" })
  capabilities: Capability[];
}

export class CapabilitySourceDto {
  @ApiProperty({ enum: CAPABILITY_SOURCE_KINDS, enumName: 'CapabilitySourceKind' })
  kind: CapabilitySourceKind;

  @ApiProperty({ ...SYSTEM_ROLE, nullable: true })
  systemRole: SystemRole | null;

  @ApiProperty(NULLABLE_ID)
  customRoleId: string | null;

  @ApiProperty({ type: String, nullable: true })
  customRoleName: string | null;

  @ApiProperty(NULLABLE_ID)
  grantId: string | null;
}

export class EffectiveCapabilityDto {
  @ApiProperty(CAPABILITY)
  capability: Capability;

  @ApiProperty({ enum: CAPABILITY_GROUP_NAMES, enumName: 'CapabilityGroup' })
  group: CapabilityGroup;

  @ApiProperty({ enum: CAPABILITY_SCOPES, enumName: 'CapabilityScope' })
  scope: CapabilityScope;

  @ApiProperty({ type: CapabilitySourceDto, isArray: true })
  sources: CapabilitySourceDto[];
}

export class UserPermissionsDto {
  @ApiProperty(ID)
  userId: string;

  @ApiProperty(NULLABLE_ID)
  staffId: string | null;

  @ApiProperty({ enum: STAFF_STATUSES, enumName: 'StaffStatus', nullable: true })
  staffStatus: StaffStatus | null;

  @ApiProperty({ description: 'False: no staff capability at all (R59); effective is empty' })
  staffCapacity: boolean;

  @ApiProperty({ type: PermissionRoleDto, isArray: true })
  roles: PermissionRoleDto[];

  @ApiProperty({ type: GrantDto, isArray: true })
  deltas: GrantDto[];

  @ApiProperty({ type: EffectiveCapabilityDto, isArray: true })
  effective: EffectiveCapabilityDto[];
}

// ------------------------------------------------------------------------------------ requests

export const CUSTOM_ROLE_SORTS = ['name', '-name', 'createdAt', '-createdAt'] as const;
export type CustomRoleSortParam = (typeof CUSTOM_ROLE_SORTS)[number];

export class ListCustomRolesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: CUSTOM_ROLE_STATUSES, enumName: 'CustomRoleStatus' })
  @IsOptional()
  @IsIn(CUSTOM_ROLE_STATUSES)
  status?: CustomRoleStatus;

  @SearchField('Name or key contains')
  q?: string;

  @ApiPropertyOptional({ enum: CUSTOM_ROLE_SORTS, enumName: 'CustomRoleSort', default: 'name' })
  @IsOptional()
  @IsIn(CUSTOM_ROLE_SORTS)
  sort?: CustomRoleSortParam;
}

/** 0-50 distinct keys, never role.manage (R45, R52). */
const CapabilityList = (required: boolean): PropertyDecorator =>
  applyDecorators(
    (required ? ApiProperty : ApiPropertyOptional)({
      enum: DELEGABLE_CAPABILITIES,
      enumName: 'Capability',
      isArray: true,
      maxItems: DELEGABLE_CAPABILITIES.length,
    }),
    IsArray(),
    ArrayMaxSize(DELEGABLE_CAPABILITIES.length),
    ArrayUnique(),
    IsIn(DELEGABLE_CAPABILITIES, { each: true, message: notRoleManage }),
  );

export class CreateCustomRoleDto {
  // One rule with the web: customRoleKeyProblem in @asms/shared.
  @ApiProperty(KEY)
  @Transform(trim)
  @Matches(CUSTOM_ROLE_KEY_PATTERN, {
    message: '$property must be 2-32 lower-case letters, digits or underscores',
  })
  @IsNotIn(RESERVED_CUSTOM_ROLE_KEYS, { message: '$property is the name of a fixed role' })
  @NoIdentityNumber()
  key: string;

  @ApiProperty({ minLength: 2, maxLength: 100 })
  @NameField(2, 100)
  name: string;

  @CapabilityList(true)
  capabilities: Capability[];
}

/** Absent fields are unchanged; `null` is refused (422), never read as absent. */
export class UpdateCustomRoleDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 100 })
  @IfPresent()
  @NameField(2, 100)
  name?: string;

  @IfPresent()
  @CapabilityList(false)
  capabilities?: Capability[];

  @ApiPropertyOptional({
    minLength: 3,
    maxLength: 500,
    description: 'Required when removing keys, and when adding keys to a role that has holders',
  })
  @IfPresent()
  @TextField(3, 500)
  reason?: string;
}

export class ReasonDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @TextField(3, 500)
  reason: string;
}

export class CreateGrantDto {
  @ApiProperty({ enum: DELEGABLE_CAPABILITIES, enumName: 'Capability' })
  @IsIn(DELEGABLE_CAPABILITIES, { message: notRoleManage })
  capability: Capability;

  @ApiProperty({ enum: GRANT_EFFECTS, enumName: 'GrantEffect' })
  @IsIn(GRANT_EFFECTS)
  effect: GrantEffect;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @TextField(3, 500)
  reason: string;
}

export class UserPermissionsQueryDto {
  @QueryBoolean({ default: false, description: 'Include ended grant and revoke rows' })
  includeEnded?: boolean;
}
