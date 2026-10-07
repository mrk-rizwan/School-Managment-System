/**
 * School API types for assessments and the marks grid (contracts/slice-30.md), taken from the
 * generated OpenAPI document (`school.d.ts`). Screens import the client and the DTO, body and
 * query types from here, so a regenerated document is checked against them by the typecheck.
 */
import type { components, operations } from './school';

type Schemas = components['schemas'];

export { schoolApi as assessmentsApi } from './client';

// ---- Enums ----

export type AssessmentKind = Schemas['AssessmentKind'];
export type TestType = Schemas['TestType'];
export type MarkEntryOutcome = Schemas['MarkEntryOutcome'];

// ---- Shapes ----

export type AssessmentDto = Schemas['AssessmentDto'];
export type AssessmentMarksDto = Schemas['AssessmentMarksDto'];
export type AssessmentMarkRowDto = Schemas['AssessmentMarkRowDto'];
export type AssessmentMarkDto = Schemas['AssessmentMarkDto'];
export type AssessmentSubmitMarksResultDto = Schemas['AssessmentSubmitMarksResultDto'];
export type MarkEntryResultDto = Schemas['MarkEntryResultDto'];
export type ExamSetUpResultDto = Schemas['ExamSetUpResultDto'];

// ---- Bodies and queries ----

export type CreateAssessmentBody = Schemas['CreateAssessmentDto'];
export type MarkEntryBody = Schemas['MarkEntryDto'];
export type AssessmentListQuery = NonNullable<
  operations['AssessmentsController_list']['parameters']['query']
>;

// ---- `details` of this slice's refusals (§6); error details are not in the OpenAPI document ----

/** 409 MARK_EXCEEDS_MAX (marks.service.ts `markExceedsMax`): the whole request was refused. */
export type MarkExceedsMaxDetails = { enrolmentId: string; max: number };
