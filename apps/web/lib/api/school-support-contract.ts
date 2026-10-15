/**
 * School API types for platform support access as the school sees it (Phase 5 slice 45,
 * contracts/slice-45.md §1): the list and the revoke. Taken from the generated OpenAPI document
 * (`school.d.ts`).
 */
import type { components } from './school';

type Schemas = components['schemas'];

export { schoolApi as schoolSupportApi } from './client';

export type SchoolSupportSessionDto = Schemas['SchoolSupportSessionDto'];
export type MeSupportSessionDto = Schemas['MeSupportSessionDto'];
