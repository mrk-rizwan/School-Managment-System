/**
 * School API types for document verification (Phase 5 slice 40, contracts/slice-40.md): the
 * queue, the decisions, the checklist and the incomplete-admissions report. Taken from the
 * generated OpenAPI document (`school.d.ts`).
 */
import type { components, operations } from './school';

type Schemas = components['schemas'];
type Query<O extends keyof operations> = NonNullable<operations[O]['parameters']['query']>;

export { schoolApi as documentsApi } from './client';

export type DocumentStatus = Schemas['DocumentStatus'];
export type ChecklistStatus = Schemas['DocumentChecklistStatus'];
export type QueuedDocumentDto = Schemas['QueuedDocumentDto'];
export type DocumentChecklistDto = Schemas['DocumentChecklistDto'];
export type DocumentChecklistItemDto = Schemas['DocumentChecklistItemDto'];
export type IncompleteAdmissionDto = Schemas['IncompleteAdmissionDto'];

export type DocumentQueueQuery = Query<'DocumentVerificationController_queue'>;
export type IncompleteAdmissionsQuery = Query<'DocumentVerificationController_incompleteAdmissions'>;
