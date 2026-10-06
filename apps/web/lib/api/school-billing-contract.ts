/**
 * School API types for the school's own platform bill (contracts/slice-26.md §1.4, A18), taken
 * from the generated OpenAPI document (`school.d.ts`, produced by `pnpm api:generate`).
 */
import type { components } from './school';

export { schoolApi as schoolBillingApi } from './client';

export type BillingStatusDto = components['schemas']['BillingStatusDto'];
