/**
 * School API types for the audit log (Phase 5 slice 46, contracts/slice-46.md): the filtered list
 * and one entry. Taken from the generated OpenAPI document (`school.d.ts`).
 */
import type { components, operations } from './school';

type Schemas = components['schemas'];

export { schoolApi as auditApi } from './client';

export type AuditEntryDto = Schemas['AuditEntryDto'];
export type AuditLogQuery = NonNullable<operations['AuditController_list']['parameters']['query']>;
