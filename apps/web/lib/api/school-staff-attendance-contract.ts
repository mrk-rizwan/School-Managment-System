/**
 * School API types for staff attendance (contracts/slice-12.md), taken from the generated OpenAPI
 * document (`school.d.ts`, produced by `pnpm api:generate`). Screens import the client and the DTO,
 * body and query types from here, so a regenerated document is checked against them by
 * `pnpm typecheck`. Section numbers below are the contract's.
 */
import type { StaffAttendanceStatus } from '@asms/shared';
import type { components, operations } from './school';

type Schemas = components['schemas'];

export { schoolApi as staffAttendanceApi } from './client';
export type { MarkOutcome } from '@asms/shared';
export type { StaffAttendanceStatus };

// ---- Shapes (§2) ----

export type StaffMarkDto = Schemas['StaffMarkDto'];
/** GET /staff-attendance (§4.1): one member on the date. */
export type StaffDayDto = Schemas['StaffDayDto'];
export type StaffSubmitResultDto = Schemas['StaffSubmitResultDto'];
/** §3, now: a mark on a day later declared a staff holiday is listed and not counted. */
export type StaffAttendanceDayDto = Schemas['StaffAttendanceDayDto'];
/** GET /staff/:id/attendance (§4.4). */
export type StaffAttendanceDto = Schemas['StaffAttendanceDto'];
/** GET /me/staff/attendance: the same without `note` and `markedByName` (decision 6). */
export type MyStaffAttendanceDayDto = Schemas['MyStaffAttendanceDayDto'];
export type MyStaffAttendanceDto = Schemas['MyStaffAttendanceDto'];

// ---- Bodies ----

/** Each item is the complete intended mark: an absent `note` means none (§4.2). */
export type StaffSubmitMarkBody = Schemas['StaffSubmitMarkDto'];
export type StaffSubmitBody = Schemas['StaffSubmitDto'];
/** §4.3: absent = unchanged, null clears. */
export type StaffAmendBody = Schemas['StaffAmendDto'];

// ---- Queries ----

export type StaffDaySort = Schemas['StaffDaySort'];
export type StaffDayQuery = operations['StaffAttendanceController_day']['parameters']['query'];

// ---- `details` of this slice's refusals (§5); error details are not in the OpenAPI document ----

/** 409 AMENDMENT_REASON_REQUIRED from staff-attendance.service.ts `submit`. */
export type StaffAmendmentDetail = {
  staffId: string;
  markId: string;
  from: StaffAttendanceStatus;
  to: StaffAttendanceStatus;
  noteChanged: boolean;
};
export type StaffAmendmentReasonRequiredDetails = { amendments: StaffAmendmentDetail[] };
/** 409 NOT_A_TEACHING_DAY from staff-attendance.service.ts `assertWritableDate` (decision 1). */
export type StaffNonWorkingDayDetails = { reason: 'weekly_off' | 'staff_holiday' };
/**
 * 409 SELF_ACTION_FORBIDDEN from staff-attendance.service.ts `selfForbidden`; the database-trigger
 * fallback in prisma-errors.ts sends no details.
 */
export type SelfActionDetails = { staffId: string };
