/**
 * School API types for the period timetable (phase-5-extended.md slice 37, contracts/slice-37.md),
 * taken from the generated OpenAPI document (`school.d.ts`). Screens import the client and the
 * DTO, body and query types from here, so a regenerated document is checked against them by the
 * typecheck.
 */
import type { components, operations } from './school';

type Schemas = components['schemas'];
type Query<Op extends keyof operations> = NonNullable<operations[Op]['parameters']['query']>;

export { schoolApi as timetableApi } from './client';

export type SectionTimetableDto = Schemas['SectionTimetableDto'];
export type SectionTimetableDayDto = Schemas['SectionTimetableDayDto'];
export type TimetableSlotDto = Schemas['TimetableSlotDto'];
export type TimetableSlotInput = Schemas['TimetableSlotInputDto'];
export type TimetableVersionDto = Schemas['TimetableVersionDto'];
export type TimetableVersionDetailDto = Schemas['TimetableVersionDetailDto'];
export type TimetableVersionStatus = Schemas['TimetableVersionStatus'];
export type TimetableSubstitutionDto = Schemas['TimetableSubstitutionDto'];
export type TimetableGridDto = Schemas['TimetableGridDto'];
export type TimetableGridSectionDto = Schemas['TimetableGridSectionDto'];

export type CreateTimetableVersionBody = Schemas['CreateTimetableVersionDto'];
export type CreateSubstitutionBody = Schemas['CreateSubstitutionDto'];
export type TimetableVersionListQuery = Query<'TimetableVersionsController_list'>;
export type TimetableSubstitutionListQuery = Query<'TimetableSubstitutionsController_list'>;
export type TimetableGridQuery = Query<'TimetableGridController_grid'>;

// ---- `details` of this slice's refusals (§2, §4); error details are not in the OpenAPI document ----

/** 409 TIMETABLE_SLOT_CLASH: the first clash, on the draft slot at `index`. */
export type SlotClashDetails = {
  kind: 'section' | 'teacher' | 'room';
  weekday: number;
  period: number;
  index?: number;
  conflictingSlotId?: string | null;
};
/** 409 TIMETABLE_OFF_DAY. */
export type OffDayDetails = { weekday: number; index?: number };
/** 409 TIMETABLE_TEACHER_NOT_ASSIGNED. */
export type TeacherNotAssignedDetails = { staffId: string; classSubjectId: string; sectionId: string };
