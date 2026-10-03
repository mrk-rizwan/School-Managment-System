/** Attendance values (phase-2-daily-operations.md §1.1, §5, slices 11-12), for the API and the clients. */

/** One mark: a period, or the day's single period in daily mode (rule 14). */
export const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'on_leave'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** The derived status of an enrolment-day (R127): `partial` mixes absent or on-leave periods. */
export const DAY_STATUSES = [...ATTENDANCE_STATUSES, 'partial'] as const;
export type DayStatus = (typeof DAY_STATUSES)[number];

/** Register item 23: how a late day counts in the percentage. `school_settings.late_counts_as`. */
export const LATE_COUNTS_AS = ['present', 'half_day', 'absent_after_cutoff'] as const;
export type LateCountsAs = (typeof LATE_COUNTS_AS)[number];

/** Authorised absence: excused leaves the denominator. `school_settings.leave_counts_as`. */
export const LEAVE_COUNTS_AS = ['excused', 'absent'] as const;
export type LeaveCountsAs = (typeof LEAVE_COUNTS_AS)[number];

/** Its own set, so payroll can add a value without touching student attendance (slice 12). */
export const STAFF_ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'on_leave'] as const;
export type StaffAttendanceStatus = (typeof STAFF_ATTENDANCE_STATUSES)[number];
