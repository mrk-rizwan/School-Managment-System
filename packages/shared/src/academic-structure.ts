/** Status and setting values of the academic structure (contracts/slice-3.md), for the API and the web. */

/** planned → active → closed; closed is final (contract §2). */
export const ACADEMIC_YEAR_STATUSES = ['planned', 'active', 'closed'] as const;
export type AcademicYearStatus = (typeof ACADEMIC_YEAR_STATUSES)[number];

export const CLASS_STATUSES = ['active', 'archived'] as const;
export type ClassStatus = (typeof CLASS_STATUSES)[number];

/** Rule 14: each class records attendance daily or per period. */
export const ATTENDANCE_MODES = ['daily', 'period'] as const;
export type AttendanceMode = (typeof ATTENDANCE_MODES)[number];
