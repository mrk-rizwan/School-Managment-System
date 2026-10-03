/** Lifecycle of a school's subscription, owned by the platform (contracts/slice-1.md). */
export const SCHOOL_STATUSES = ['trial', 'active', 'suspended', 'terminated'] as const;
export type SchoolStatus = (typeof SCHOOL_STATUSES)[number];

/**
 * Allowed status changes, declared once for the API service and the web dialog.
 * Nothing returns to trial; terminated is final. Changing to the current status is a no-op
 * handled by the caller, not a transition.
 */
export const SCHOOL_STATUS_TRANSITIONS: Readonly<Record<SchoolStatus, readonly SchoolStatus[]>> = {
  trial: ['active', 'suspended', 'terminated'],
  active: ['suspended', 'terminated'],
  suspended: ['active', 'terminated'],
  terminated: [],
};

export function canChangeSchoolStatus(from: SchoolStatus, to: SchoolStatus): boolean {
  return SCHOOL_STATUS_TRANSITIONS[from].includes(to);
}
