/**
 * School API types for commencement imports (Phase 5 slice 43, contracts/slice-43.md), taken from
 * the generated OpenAPI document (`school.d.ts`). The two previews are multipart: the CSV as
 * `file` and the form's fields as text parts.
 */
import type { components, operations } from './school';
import { schoolApi, unwrap } from './client';

type Schemas = components['schemas'];

export { schoolApi as importsApi } from './client';

export type ImportDto = Schemas['ImportDto'];
export type ImportDetailDto = Schemas['ImportDetailDto'];
export type ImportRowDto = Schemas['ImportRowDto'];
export type ImportRowErrorDto = Schemas['ImportRowErrorDto'];
export type ImportRowErrorCode = Schemas['ImportRowErrorCode'];
export type ImportKind = Schemas['ImportKind'];
export type ImportStatus = Schemas['ImportStatus'];
export type ImportListQuery = NonNullable<operations['ImportsController_list']['parameters']['query']>;

/** The CSV limit the API reads (CSV_IMPORT_LIMITS.maxBytes). */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/** POST /imports/past-results: the section, the term and the file. */
export function previewPastResults(
  fields: { sectionId: string; termId: string },
  file: File,
  idempotencyKey: string,
): Promise<ImportDetailDto> {
  const body = new FormData();
  body.append('sectionId', fields.sectionId);
  body.append('termId', fields.termId);
  body.append('file', file);
  // The generated body type names the fields and `file: string`; openapi-fetch sends FormData as is.
  return unwrap(
    schoolApi.POST('/api/v1/imports/past-results', {
      params: { header: { 'Idempotency-Key': idempotencyKey } },
      body: body as unknown as Schemas['PastResultsUploadDto'],
    }),
  );
}

/** POST /imports/opening-balances: the year, the due date and the file (a principal; rule-24 inert). */
export function previewOpeningBalances(
  fields: { academicYearId: string; dueOn: string },
  file: File,
  idempotencyKey: string,
): Promise<ImportDetailDto> {
  const body = new FormData();
  body.append('academicYearId', fields.academicYearId);
  body.append('dueOn', fields.dueOn);
  body.append('file', file);
  return unwrap(
    schoolApi.POST('/api/v1/imports/opening-balances', {
      params: { header: { 'Idempotency-Key': idempotencyKey } },
      body: body as unknown as Schemas['OpeningBalancesUploadDto'],
    }),
  );
}

/** POST /imports/:id/commit. */
export function commitImport(id: string, idempotencyKey: string): Promise<ImportDetailDto> {
  return unwrap(
    schoolApi.POST('/api/v1/imports/{id}/commit', {
      params: { path: { id }, header: { 'Idempotency-Key': idempotencyKey } },
    }),
  );
}
