import type { LateCountsAs, LeaveCountsAs, MessageType, RemarkVisibility } from '@asms/shared';

// Labels shared by the settings and messaging screens (contracts/slice-9.md §4, §7.2) and the
// calendar (weekdays, 0 = Sunday … 6 = Saturday).

export const WEEKDAY_LABELS: Record<number, string> = {
  0: 'Sunday',
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
};
/** Monday first, as a school week is read. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export const LATE_COUNTS_AS_LABELS: Record<LateCountsAs, string> = {
  present: 'Present',
  half_day: 'Half a day',
  absent_after_cutoff: 'Absent, if after a cut-off time',
};

export const LEAVE_COUNTS_AS_LABELS: Record<LeaveCountsAs, string> = {
  excused: 'Excused (left out of the attendance percentage)',
  absent: 'Absent',
};

export const REMARK_VISIBILITY_LABELS: Record<RemarkVisibility, string> = {
  internal: 'Staff only',
  guardian: 'Guardians',
  student: 'Guardians and the student',
};

export const MESSAGE_TYPE_LABELS: Record<MessageType, string> = {
  absence_alert: 'Absence alerts',
  late_advice: 'Late arrival advice',
  attendance_corrected: 'Attendance corrections',
  announcement_urgent: 'Urgent announcements',
  announcement_normal: 'Ordinary announcements',
  holiday_notice: 'Holiday notices',
  diary_posted: 'Diary entries',
  remark_posted: 'Teacher remarks',
  register_unrecorded: 'Unrecorded register reminders',
  sms_cap_reached: 'SMS limit reached',
  messaging_test: 'Test messages',
  whatsapp_session_down: 'WhatsApp down alerts',
  cover_assigned: 'Cover assignments',
};

/** `HH:MM`, 00:00–23:59 (the API's pattern). */
export const isTime = (value: string) => /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
