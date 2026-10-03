/** Staff values (contracts/slice-4.md), for the API and the web. */

export const STAFF_STATUSES = ['active', 'suspended', 'left'] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];

/** Rule 13: teacher is one role; class teacher and subject teacher are assignments. */
export const TEACHER_ROLES = ['class_teacher', 'subject_teacher'] as const;
export type TeacherRole = (typeof TEACHER_ROLES)[number];
