import { ErrorCode, type RemarkCategory, type RemarkVisibility } from '@asms/shared';
import { NOT_ASSIGNED_ON_DATE, refusalMessage, type RefusalMessages } from '@/lib/api/errors';

// Pieces shared by the student's remarks tab and its dialogs (contracts/slice-13.md §5, §11).

export const remarkKeys = { student: (id: string) => ['school', 'remarks', id] as const };

export const REMARK_CATEGORY_LABELS: Record<RemarkCategory, string> = {
  academic: 'Academic',
  behaviour: 'Behaviour',
  homework: 'Homework',
  attendance: 'Attendance',
  participation: 'Participation',
  general: 'General',
};
/** Visibility is a level (R140): the student level includes guardians. */
export const REMARK_VISIBILITY_LABELS: Record<RemarkVisibility, string> = {
  internal: 'Staff only',
  guardian: 'Guardians',
  student: 'Guardians and student',
};

const REMARK_REFUSALS: RefusalMessages = {
  [ErrorCode.STUDENT_NOT_ACTIVE]: 'This student has left the school, so remarks are closed.',
  [ErrorCode.ACADEMIC_YEAR_CLOSED]: 'That academic year is closed, so its remarks cannot change.',
  [ErrorCode.SUBJECT_ARCHIVED]: 'That subject is archived. Choose another or none.',
  [ErrorCode.IDEMPOTENCY_KEY_REUSED]: 'This form was already used for a different remark. Save again to send it as a new one.',
  [`${ErrorCode.PERMISSION_DENIED}:not_assigned_on_date`]: NOT_ASSIGNED_ON_DATE,
  [`${ErrorCode.PERMISSION_DENIED}:not_author`]: 'Only the remark’s author or the principal can correct it.',
};

/** A remark refusal, in the office's words; anything else is `describeApiError`. */
export const remarkErrorMessage = (error: unknown): string => refusalMessage(error, REMARK_REFUSALS);
