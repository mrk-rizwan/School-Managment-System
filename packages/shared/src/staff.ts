/** Staff values (contracts/slice-4.md), for the API and the web. */

export const STAFF_STATUSES = ['active', 'suspended', 'left'] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];

/**
 * Rule 13: teacher is one role; class teacher and subject teacher are assignments. `cover` is a
 * dated class-teacher scope for a section (contracts/slice-10.md §6, R132).
 */
export const TEACHER_ROLES = ['class_teacher', 'subject_teacher', 'cover'] as const;
export type TeacherRole = (typeof TEACHER_ROLES)[number];
