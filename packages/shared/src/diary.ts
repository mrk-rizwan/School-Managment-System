/** Diary and remark values (phase-2-daily-operations.md §4.5, §5, slice 13). */

export const REMARK_CATEGORIES = [
  'academic',
  'behaviour',
  'homework',
  'attendance',
  'participation',
  'general',
] as const;
export type RemarkCategory = (typeof REMARK_CATEGORIES)[number];

/** Display labels, shared by the web and the mobile app. */
export const REMARK_CATEGORY_LABELS: Record<RemarkCategory, string> = {
  academic: 'Academic',
  behaviour: 'Behaviour',
  homework: 'Homework',
  attendance: 'Attendance',
  participation: 'Participation',
  general: 'General',
};

/** A level: `student` implies `guardian`. Register item 26's default is `guardian`. */
export const REMARK_VISIBILITIES = ['internal', 'guardian', 'student'] as const;
export type RemarkVisibility = (typeof REMARK_VISIBILITIES)[number];

/** Visibility as a level (contracts/slice-13.md §2.1, R140): `student` implies `guardian`. */
export const REMARK_VISIBILITY_LEVEL = { internal: 0, guardian: 1, student: 2 } as const;
/** The lowest visibility a capacity may read: guardians read guardian-or-above, students student. */
export const MIN_REMARK_VISIBILITY = { guardian: 'guardian', student: 'student' } as const;
export const remarkVisibleTo = (v: RemarkVisibility, c: 'guardian' | 'student'): boolean =>
  REMARK_VISIBILITY_LEVEL[v] >= REMARK_VISIBILITY_LEVEL[MIN_REMARK_VISIBILITY[c]];
/** The visibilities a capacity may read, for a query filter (never filtered in a serialiser). */
export const remarkVisibilitiesFor = (c: 'guardian' | 'student'): RemarkVisibility[] =>
  REMARK_VISIBILITIES.filter((v) => remarkVisibleTo(v, c));
