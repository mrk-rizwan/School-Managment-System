/**
 * School API types for holidays and teaching days (contracts/slice-10.md §2, §4, §5.1), and the
 * slice-10 amendments to two shipped slices: the cover assignment (slice-4 §4.3) and the
 * close-old/open-new section and class change (slice-6 §5). Taken from the generated OpenAPI
 * document (`school.d.ts`, produced by `pnpm api:generate`), so a regenerated document is checked
 * against the screens by `pnpm typecheck`.
 */
import type { components, operations } from './school';

type Schemas = components['schemas'];

export { schoolApi as calendarApi } from './client';

// ---- Holidays (§2, §4) ----

export type HolidayKind = Schemas['HolidayKind'];
export type HolidayStatus = Schemas['HolidayStatus'];
export type HolidayDto = Schemas['HolidayDto'];
export type HolidaySort = Schemas['HolidaySort'];
export type HolidayListQuery = NonNullable<operations['HolidaysController_list']['parameters']['query']>;
export type CreateHolidayBody = Schemas['CreateHolidayDto'];
/** Absent = unchanged; `description: null` clears. A published holiday takes description and appliesToStaff only. */
export type UpdateHolidayBody = Schemas['UpdateHolidayDto'];
export type CancelHolidayBody = Schemas['CancelHolidayDto'];

// ---- Teaching days (§2, §5.1) ----

export type TeachingDaysDto = Schemas['TeachingDaysDto'];

// ---- Cover assignments (§2, §6) ----

export type { TeacherAssignmentDto, CreateTeacherAssignmentBody } from './school-staff-contract';

// ---- Section and class change (§8) ----

export type SectionChangeResultDto = Schemas['SectionChangeResultDto'];
export type ChangeSectionBody = Schemas['ChangeSectionDto'];
export type ChangeClassBody = Schemas['ChangeClassDto'];

// ---- `details` of this slice's refusals; error details are not in the OpenAPI document ----

/**
 * 409 HOLIDAY_DATES_TAKEN from holidays.service.ts `datesTaken`: the oldest overlapping live
 * holiday. The same code raised by the exclusion constraint (prisma-errors.ts) has no details.
 */
export type HolidayDatesTaken = { holidayId: string };
/** 409 CAPABILITY_NOT_HELD from teacher-assignments.service.ts `assertCanMark`. */
export type CapabilityNotHeld = { capability: string };