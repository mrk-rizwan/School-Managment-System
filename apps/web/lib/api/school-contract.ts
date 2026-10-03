/**
 * School API types for the slice-2 screens (contracts/slice-2.md), taken from the generated
 * OpenAPI document (`school.d.ts`, produced by `pnpm api:generate`). Screens import the client
 * and the DTO, body and query types from here, so a regenerated document is checked against them
 * by `pnpm typecheck`.
 */
import type { components, operations } from './school';

type Schemas = components['schemas'];

export { schoolApi as school } from './client';

// ---- Responses ----

/** §4.1. `roles` comes from the user's active capacities. */
export type SchoolRole = Schemas['SchoolRole'];
/** §4.1 — never carries a username or identity number. */
export type MeDto = Schemas['MeDto'];
export type UserStatus = Schemas['UserStatus'];
export type UserKind = Schemas['UserKind'];
/** §5 */
export type UserDto = Schemas['UserDto'];
/** §6 */
export type SchoolSettingsDto = Schemas['SchoolSettingsDto'];

// ---- GET /users query (§5.1) ----

export type UserListQuery = NonNullable<operations['UsersController_list']['parameters']['query']>;
export type UserSort = NonNullable<UserListQuery['sort']>;
export type UserListDto =
  operations['UsersController_list']['responses'][200]['content']['application/json'];

// ---- Request bodies ----

export type LoginBody = Schemas['SchoolLoginDto'];
export type ForgotPasswordBody = Schemas['ForgotPasswordDto'];
export type ResetPasswordBody = Schemas['ResetPasswordDto'];
export type VerifyEmailBody = Schemas['VerifyEmailDto'];
export type ChangeEmailBody = Schemas['ChangeEmailDto'];
export type ChangeSchoolPasswordBody = Schemas['ChangePasswordDto'];
export type OfficeResetBody = Schemas['OfficeResetDto'];
export type ReasonBody = Schemas['ReasonDto'];
export type UpdateSchoolSettingsBody = Schemas['UpdateSchoolSettingsDto'];
