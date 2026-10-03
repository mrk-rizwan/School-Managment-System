/**
 * Platform API types for the platform console, taken from the generated OpenAPI document
 * (`platform.d.ts`, produced by `pnpm api:generate`). Platform screens import the client and
 * the DTO, body and query types from here, so a regenerated document is checked against them by
 * `pnpm typecheck`.
 */
import type { components, operations } from './platform';

type Schemas = components['schemas'];

export { platformApi as platform } from './client';

// ---- Responses (contracts/slice-1.md §3.2, §4) ----

export type PlatformMeDto = Schemas['PlatformMeDto'];
export type SchoolDto = Schemas['SchoolDto'];

// ---- GET /schools query (§4.1) ----

/** The sort allowlist of `GET /schools`. */
export type SchoolSort = Schemas['SchoolSort'];
export type SchoolListQuery = NonNullable<
  operations['SchoolsController_list']['parameters']['query']
>;

// ---- Request bodies ----

export type PlatformLoginBody = Schemas['PlatformLoginDto'];
export type ChangePasswordBody = Schemas['ChangePlatformPasswordDto'];
export type CreateSchoolBody = Schemas['CreateSchoolDto'];
/** `shortCode` is declared by the API only to be refused (§4.4); the console never sends it. */
export type UpdateSchoolBody = Omit<Schemas['UpdateSchoolDto'], 'shortCode'>;
export type ChangeSchoolStatusBody = Schemas['ChangeSchoolStatusDto'];
/** contracts/slice-2.md §7. */
export type IssuePrincipalLoginBody = Schemas['IssuePrincipalLoginDto'];
export type IssuePrincipalLoginDto = Schemas['IssuedPrincipalLoginDto'];
