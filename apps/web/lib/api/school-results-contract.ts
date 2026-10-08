/**
 * School API types for result sheets (contracts/slice-31.md), taken from the generated OpenAPI
 * document (`school.d.ts`). Screens import the client and the DTO, body and query types from
 * here, so a regenerated document is checked against them by the typecheck.
 */
import type { components, operations } from './school';

type Schemas = components['schemas'];

export { schoolApi as resultsApi } from './client';

export type ResultSheetStatus = Schemas['ResultSheetStatus'];
export type OwnChildRole = Schemas['OwnChildRole'];

export type ResultSheetDto = Schemas['ResultSheetDto'];
export type ResultSheetDetailDto = Schemas['ResultSheetDetailDto'];
export type ResultPreviewRowDto = Schemas['ResultPreviewRowDto'];
export type ResultPreviewSubjectDto = Schemas['ResultPreviewSubjectDto'];
export type OwnChildFlagDto = Schemas['OwnChildFlagDto'];

export type CreateResultSheetBody = Schemas['CreateResultSheetDto'];
export type UpdateResultSheetBody = Schemas['UpdateResultSheetDto'];
export type ResultSheetListQuery = NonNullable<
  operations['ResultsController_list']['parameters']['query']
>;

// ---- `details` of this slice's refusals (§6); error details are not in the OpenAPI document ----

/** 409 MARKS_INCOMPLETE: the first 100 gaps. */
export type MarksIncompleteDetails = { missing: { enrolmentId: string; assessmentId: string }[] };
