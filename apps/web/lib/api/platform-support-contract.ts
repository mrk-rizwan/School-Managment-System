/**
 * Platform API types for support access (Phase 5 slice 45, contracts/slice-45.md): the sessions
 * and the closed set of read views. Taken from the generated OpenAPI document (`platform.d.ts`).
 */
import type { components, operations } from './platform';

type Schemas = components['schemas'];

export { platformApi as supportApi } from './client';

export type SupportSessionDto = Schemas['SupportSessionDto'];
export type SupportSessionStatus = Schemas['SupportSessionStatus'];
export type OpenSupportSessionBody = Schemas['OpenSupportSessionDto'];
export type SupportSessionListQuery = NonNullable<operations['SupportSessionsController_list']['parameters']['query']>;
export type SupportSchoolSettingsDto = Schemas['SupportSchoolSettingsDto'];
export type SupportStudentSummaryDto = Schemas['SupportStudentSummaryDto'];
export type SupportStudentDto = Schemas['SupportStudentDto'];
export type SupportChargeDto = Schemas['SupportChargeDto'];
export type SupportPaymentDto = Schemas['SupportPaymentDto'];
export type SupportAuditEntryDto = Schemas['AuditEntryDto'];
export type SupportAuditQuery = NonNullable<operations['SupportViewsController_auditLog']['parameters']['query']>;
