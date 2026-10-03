/**
 * School API types for the guardian screens (contracts/slice-5.md), taken from the generated
 * OpenAPI document (`school.d.ts`, produced by `pnpm api:generate`). Screens import the client
 * and the DTO, body and query types from here, so a regenerated document is checked against them
 * by `pnpm typecheck`.
 */
import type { components, operations } from './school';

type Schemas = components['schemas'];

export { schoolApi as guardiansApi } from './client';

/** contracts/slice-2.md §5 — the response of issue-login. */
export type { UserDto } from './school-contract';

// ---- Enums (contract §2) ----

/** Rule 17: no "unknown" value; the office must pick one. */
export type ContactCapability = Schemas['ContactCapability'];
export type GuardianStatus = Schemas['GuardianStatus'];

// ---- Responses ----

export type GuardianDto = Schemas['GuardianDto'];
export type GuardianDetailDto = Schemas['GuardianDetailDto'];
export type GuardianStudentDto = Schemas['GuardianStudentDto'];
export type GuardianLookupHitDto = Schemas['GuardianLookupHitDto'];
export type GuardianLookupResultDto = Schemas['GuardianLookupResultDto'];

// ---- Queries ----

export type GuardianSort = Schemas['GuardianSort'];
export type GuardianListQuery = NonNullable<
  operations['GuardiansController_list']['parameters']['query']
>;

// ---- Bodies ----

export type CreateGuardianBody = Schemas['CreateGuardianDto'];
/** Absent = unchanged, `null` = clear (not allowed for fullName and contactCapability). */
export type UpdateGuardianBody = Schemas['UpdateGuardianDto'];
/** The API requires exactly one of the two (§3.3). */
export type GuardianLookupBody = Schemas['GuardianLookupDto'];
