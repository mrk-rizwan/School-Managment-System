/**
 * School API types for the academic-structure screens (contracts/slice-3.md), taken from the
 * generated OpenAPI document (`school.d.ts`, produced by `pnpm api:generate`). Screens import the
 * client and the DTO, body and query types from here, so a regenerated document is checked
 * against them by `pnpm typecheck`.
 */
import type { components, operations } from './school';

type Schemas = components['schemas'];
type Query<Op extends keyof operations> = NonNullable<operations[Op]['parameters']['query']>;

export { schoolApi as academics } from './client';

// ---- Enums (contract §2, §3) ----

export type AcademicYearStatus = Schemas['AcademicYearStatus'];
export type AttendanceMode = Schemas['AttendanceMode'];
export type ClassStatus = Schemas['ClassStatus'];

// ---- Responses ----

export type AcademicYearDto = Schemas['AcademicYearDto'];
export type ClassDto = Schemas['ClassDto'];
export type SectionDto = Schemas['SectionDto'];
export type SubjectDto = Schemas['SubjectDto'];
export type CopySectionsResultDto = Schemas['CopySectionsResultDto'];

// ---- Queries ----

export type AcademicYearSort = Schemas['AcademicYearSort'];
export type AcademicYearListQuery = Query<'AcademicYearsController_list'>;
export type ClassSort = Schemas['ClassSort'];
export type ClassListQuery = Query<'ClassesController_list'>;
export type SectionSort = Schemas['SectionSort'];
export type SectionListQuery = Query<'SectionsController_list'>;
export type SubjectSort = Schemas['SubjectSort'];
export type SubjectListQuery = Query<'SubjectsController_list'>;

// ---- Bodies ----

export type UpdateAcademicYearBody = Schemas['UpdateAcademicYearDto'];
export type UpdateClassBody = Schemas['UpdateClassDto'];
export type CopySectionsBody = Schemas['CopySectionsDto'];
export type UpdateSectionBody = Schemas['UpdateSectionDto'];
export type UpdateSubjectBody = Schemas['UpdateSubjectDto'];

// ---- Phase 4 slice 29: terms, result settings, class subjects (contracts/slice-29.md) ----

export type PassRule = Schemas['PassRule'];
export type TermDto = Schemas['TermDto'];
export type TermSkipDto = Schemas['TermSkipDto'];
export type ResultSettingsDto = Schemas['ResultSettingsDto'];
export type GradeBandDto = Schemas['GradeBandDto'];
export type ClassSubjectDto = Schemas['ClassSubjectDto'];
export type ClassSubjectEntry = Schemas['ClassSubjectEntryDto'];
export type CreateTermBody = Schemas['CreateTermDto'];
export type UpdateTermBody = Schemas['UpdateTermDto'];
export type SkipClassBody = Schemas['SkipClassDto'];
export type UpdateResultSettingsBody = Schemas['UpdateResultSettingsDto'];
