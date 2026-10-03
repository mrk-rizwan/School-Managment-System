/** Student values (contracts/slice-6.md), for the API and the web. */

export const STUDENT_STATUSES = ['active', 'suspended', 'withdrawn', 'transferred', 'alumni'] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];

export const GENDERS = ['male', 'female'] as const;
export type Gender = (typeof GENDERS)[number];

/** A guardian's relationship to the student (STUDENT_GUARDIAN, rule 9). */
export const RELATIONSHIPS = ['father', 'mother', 'guardian', 'other'] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

export const ENROLMENT_STATUSES = ['active', 'completed', 'left'] as const;
export type EnrolmentStatus = (typeof ENROLMENT_STATUSES)[number];

export const DOCUMENT_TYPES = ['b_form', 'photo', 'previous_school_leaving', 'guardian_cnic', 'other'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** R26: a student in one of these is readmitted, never admitted again or reactivated. */
export const READMISSIBLE_STATUSES: readonly StudentStatus[] = ['withdrawn', 'transferred', 'alumni'];

/**
 * R36 (§3.6): the changes POST /students/:id/change-status allows. Leaving withdrawn, transferred
 * or alumni is a readmission; alumni is reached only at year end; suspended → withdrawn is refused
 * (reactivate first).
 */
export const STUDENT_STATUS_TRANSITIONS: Readonly<Record<StudentStatus, readonly StudentStatus[]>> = {
  active: ['suspended', 'withdrawn', 'transferred'],
  suspended: ['active'],
  withdrawn: [],
  transferred: [],
  alumni: [],
};
