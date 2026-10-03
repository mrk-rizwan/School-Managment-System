/**
 * School API types for custom roles, grants and revokes and the permissions view
 * (contracts/slice-7.md §2–§5), taken from the generated OpenAPI document (`school.d.ts`, produced
 * by `pnpm api:generate`). Screens import the client and the DTO, body and query types from here,
 * so a regenerated document is checked against them by `pnpm typecheck`.
 */
import type { components, operations } from './school';

type Schemas = components['schemas'];

export { schoolApi as rolesApi } from './client';

// ---- Enums ----

export type Capability = Schemas['Capability'];
export type CapabilityScope = Schemas['CapabilityScope'];
export type CustomRoleStatus = Schemas['CustomRoleStatus'];
export type GrantEffect = Schemas['GrantEffect'];
export type SystemRole = Schemas['SystemRole'];

// ---- Responses (§2) ----

export type CustomRoleDto = Schemas['CustomRoleDto'];
export type GrantDto = Schemas['GrantDto'];
/** Slice-4 `UserRoleDto`; slice 7 adds `customRoleName`. */
export type UserRoleDto = Schemas['UserRoleDto'];
export type PermissionRoleDto = Schemas['PermissionRoleDto'];
export type CapabilitySourceDto = Schemas['CapabilitySourceDto'];
export type EffectiveCapabilityDto = Schemas['EffectiveCapabilityDto'];
export type UserPermissionsDto = Schemas['UserPermissionsDto'];

// ---- Queries ----

export type CustomRoleSort = Schemas['CustomRoleSort'];
export type CustomRoleListQuery = NonNullable<operations['CustomRolesController_list']['parameters']['query']>;
export type UserPermissionsQuery = NonNullable<operations['GrantsController_view']['parameters']['query']>;

// ---- Bodies ----

export type CreateCustomRoleBody = Schemas['CreateCustomRoleDto'];
/** `capabilities` is the complete new set; `reason` is required when it removes any key (R95). */
export type UpdateCustomRoleBody = Schemas['UpdateCustomRoleDto'];
export type ReasonBody = Schemas['ReasonDto'];
export type CreateGrantBody = Schemas['CreateGrantDto'];
/** Exactly one of `systemRole`, `customRoleId` (§3.6); the API refuses both or neither. */
export type AssignRoleBody = Schemas['AssignRoleDto'];

// ---- `details` of this slice's refusals; error details are not in the OpenAPI document ----

/** 403 PERMISSION_DENIED from access.errors.ts `capabilityNotHeld`. */
export type CapabilityNotHeldDetails = { reason: 'capability_not_held'; capabilities: Capability[] };
/** 409 CUSTOM_ROLE_KEY_TAKEN from access.errors.ts `customRoleKeyTaken`. */
export type CustomRoleKeyTakenDetails = { customRoleId: string };
/** 409 CUSTOM_ROLE_IN_USE from custom-roles.service.ts `archive`. */
export type CustomRoleInUseDetails = { holderCount: number };
/** 409 STAFF_NOT_ACTIVE from grants.service.ts `staffNotActive`; slice-4 callers send no details. */
export type StaffNotActiveDetails = { reason: 'staff_not_active' | 'no_staff_role' };
