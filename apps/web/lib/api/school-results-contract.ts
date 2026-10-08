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

// ---- slice 32 (contracts/slice-32.md): the report card, the prints and mark corrections ----

export type ResultDto = Schemas['ResultDto'];
export type ResultCardSubjectDto = Schemas['ResultCardSubjectDto'];
export type MarkCorrectionDto = Schemas['MarkCorrectionDto'];
export type MarkCorrectionState = Schemas['MarkCorrectionState'];
export type MarkCorrectionDecisionDto = Schemas['MarkCorrectionDecisionDto'];
export type CorrectMarkBody = Schemas['CorrectMarkDto'];
export type MarkCorrectionListQuery = NonNullable<
  operations['MarkCorrectionsController_list']['parameters']['query']
>;

/** The print views (R283): opened in a new tab, never fetched into this page's state. */
export const resultCardPrintPath = (resultId: string) => `/api/v1/results/${resultId}/print`;
export const resultSheetPrintPath = (sheetId: string) => `/api/v1/result-sheets/${sheetId}/print`;
