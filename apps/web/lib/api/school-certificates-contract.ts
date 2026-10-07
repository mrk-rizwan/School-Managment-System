/**
 * School API types for certificates (phase-4-academic.md slice 34, contracts/slice-34.md), taken
 * from the generated OpenAPI document (`school.d.ts`, produced by `pnpm api:generate`). Screens
 * import the client and the DTO, body and query types from here, so a regenerated document is
 * checked against them by `pnpm typecheck`.
 */
import type { components, operations } from './school';

type Schemas = components['schemas'];
type Query<Op extends keyof operations> = NonNullable<operations[Op]['parameters']['query']>;

export { schoolApi as certificatesApi } from './client';

export type CertificateType = Schemas['CertificateType'];
export type DuesStatus = Schemas['DuesStatus'];
export type CertificateDto = Schemas['CertificateDto'];
export type CertificateSummaryDto = Schemas['CertificateSummaryDto'];
export type IssueCertificateBody = Schemas['IssueCertificateDto'];
export type CertificateListQuery = Query<'CertificatesController_list'>;

/** 409 CERTIFICATE_DUES_BLOCK. */
export type DuesBlock = { outstanding: number };
