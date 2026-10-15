/**
 * School API types for the family's, the student's and the student page's results and the result
 * reports (contracts/slice-33.md), taken from the generated OpenAPI document (`school.d.ts`).
 * Screens import the client and the DTOs from here, so a regenerated document is checked against
 * them by the typecheck.
 */
import type { components, operations } from './school';

type Schemas = components['schemas'];

export { schoolApi as myResultsApi } from './client';

export type ResultDto = Schemas['ResultDto'];
export type ResultCardSubjectDto = Schemas['ResultCardSubjectDto'];
export type MyChildResultsDto = Schemas['MyChildResultsDto'];
export type MyResultSummaryDto = Schemas['MyResultSummaryDto'];
export type MyResultDto = Schemas['MyResultDto'];
export type MyAssessmentMarkDto = Schemas['MyAssessmentMarkDto'];
export type SectionSummaryReportDto = Schemas['SectionSummaryReportDto'];
export type SubjectReportDto = Schemas['SubjectReportDto'];

// Phase 5 slice 42 (contracts/slice-42.md §2.2): the class merit list.
export type MeritListDto = Schemas['MeritListDto'];
export type MeritListRowDto = Schemas['MeritListRowDto'];
export type MeritListQuery = NonNullable<operations['ResultReportsController_meritList']['parameters']['query']>;
