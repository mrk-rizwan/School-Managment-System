/**
 * School API types for the Approvals page (phase-3-financial.md slice 27, contracts/slice-27.md),
 * taken from the generated OpenAPI document (`school.d.ts`). GET /me/approvals answers only the
 * sections whose key the caller holds; each is the queue's first page of ten with its total.
 */
import type { components } from './school';

type Schemas = components['schemas'];

export { schoolApi as approvalsApi } from './client';

export type ApprovalsDto = Schemas['ApprovalsDto'];
