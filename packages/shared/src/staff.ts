/** Staff values (contracts/slice-4.md), for the API and the web. */

export const STAFF_STATUSES = ['active', 'suspended', 'left'] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];

/**
 * Rule 13: teacher is one role; class teacher and subject teacher are assignments. `cover` is a
 * dated class-teacher scope for a section (contracts/slice-10.md §6, R132).
 */
export const TEACHER_ROLES = ['class_teacher', 'subject_teacher', 'cover'] as const;
export type TeacherRole = (typeof TEACHER_ROLES)[number];

/**
 * Phase 5 rule 35 (phase-5-extended.md §1.1): `staff_contracts.type`. A permanent contract has no
 * end date; the others must have one.
 */
export const CONTRACT_TYPES = ['permanent', 'fixed_term', 'probation'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

/** Rule 35's *default* warning lead (`school_settings.contract_warning_days`, 1-90). */
export const DEFAULT_CONTRACT_WARNING_DAYS = 30;
