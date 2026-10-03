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

/** A level: `student` implies `guardian`. Register item 26's default is `guardian`. */
export const REMARK_VISIBILITIES = ['internal', 'guardian', 'student'] as const;
export type RemarkVisibility = (typeof REMARK_VISIBILITIES)[number];
