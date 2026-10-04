/**
 * School API types for student attendance (contracts/slice-11.md), taken from the generated OpenAPI
 * document (`school.d.ts`, produced by `pnpm api:generate`). Screens import the client and the DTO,
 * body and query types from here, so a regenerated document is checked against them by
 * `pnpm typecheck`. Section numbers below are the contract's.
 */
import type { AttendanceStatus } from '@asms/shared';
import type { components, operations } from './school';

type Schemas = components['schemas'];

export { schoolApi as attendanceApi } from './client';
export type { MarkOutcome } from '@asms/shared';

// ---- Enums ----

export type { AttendanceStatus };
export type AttendanceMode = Schemas['AttendanceMode'];
export type DayStatus = Schemas['DayStatus'];
export type CallerRole = Schemas['RegisterCallerRole'];

// ---- Shapes (§2.2) ----

export type RegisterDto = Schemas['RegisterDto'];
export type AttendanceMarkDto = Schemas['AttendanceMarkDto'];
export type AlertSummaryDto = Schemas['AlertSummaryDto'];
export type RosterRowDto = Schemas['RosterRowDto'];
/** GET /sections/:id/register (§4.1). */
export type RegisterViewDto = Schemas['RegisterViewDto'];
export type RegisterCountsDto = Schemas['RegisterCountsDto'];
export type RegisterSubmitResultDto = Schemas['RegisterSubmitResultDto'];
export type MarkChangeDto = Schemas['MarkChangeDto'];
/** GET /attendance-registers (§10.1): one section-day. */
export type SectionDayDto = Schemas['SectionDayDto'];
/** GET /attendance-reports/daily-summary (§10.2). */
export type DailySummaryDto = Schemas['DailySummaryDto'];
export type StudentDayDto = Schemas['StudentDayDto'];
/** GET /students/:id/attendance (§10.4): no note, no teacher, no alert state (R165). */
export type StudentAttendanceDto = Schemas['StudentAttendanceDto'];
/** `/absentees`, `/late` rows (§2.2, §10.3). */
export type AbsenteeRowDto = Schemas['AbsenteeRowDto'];
/** `/percentage` rows (§10.5); the place is the current active enrolment's, null when none. */
export type PercentageRowDto = Schemas['PercentageRowDto'];

// ---- Bodies ----

/** Each item is the complete intended mark: an absent `note` means none (§4.2, decision 7). */
export type SubmitMarkBody = Schemas['SubmitMarkDto'];
export type SubmitRegisterBody = Schemas['SubmitRegisterDto'];
/** §4.3: absent = unchanged, null clears. */
export type AmendMarkBody = Schemas['AmendMarkDto'];
export type ArrivalBody = Schemas['RecordArrivalDto'];

// ---- Queries ----

export type RegisterListSort = Schemas['SectionDaySort'];
export type RegisterListQuery = operations['AttendanceController_list']['parameters']['query'];
export type DailySummarySort = Schemas['DailySummarySort'];
export type DailySummaryQuery = operations['AttendanceController_dailySummary']['parameters']['query'];
export type AbsenteeSort = Schemas['AttendanceDayListSort'];
export type LateQuery = operations['AttendanceController_late']['parameters']['query'];
export type AbsenteesQuery = operations['AttendanceController_absentees']['parameters']['query'];
export type PercentageSort = Schemas['PercentageSort'];
export type PercentageQuery = operations['AttendanceController_percentage']['parameters']['query'];

// ---- `details` of this slice's refusals (§11.1); error details are not in the OpenAPI document ----

/**
 * 409 AMENDMENT_REASON_REQUIRED from registers.service.ts `submit`: also how a racing teacher sees
 * the first one's marks. Only items that change an existing mark are listed, so each has one.
 */
export type MarkAmendmentDetail = {
  enrolmentId: string;
  markId: string;
  from: AttendanceStatus;
  to: AttendanceStatus;
  noteChanged: boolean;
};
export type AmendmentReasonRequiredDetails = { amendments: MarkAmendmentDetail[] };
/** 409 ATTENDANCE_LOCKED from attendance-access.ts `attendanceLocked`. */
export type AttendanceLockedDetails = { date: string; windowDays: number };
/** 422 ROSTER_INCOMPLETE from registers.service.ts `submit`: the enrolment ids not marked. */
export type RosterIncompleteDetails = { missing: string[] };
/** 409 STALE_STATUS from marks.service.ts `amend`. */
export type StaleStatusDetails = { currentStatus: AttendanceStatus };
/** 409 ARRIVAL_NOT_ABSENT from marks.service.ts `arrivalNotAbsent`. */
export type ArrivalNotAbsentDetails = { status: AttendanceStatus | null };
