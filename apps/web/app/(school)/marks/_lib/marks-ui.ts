import { ErrorCode } from '@asms/shared';
import { refusalMessage, type RefusalMessages } from '@/lib/api/errors';
import type { AssessmentDto, TestType } from '@/lib/api/school-assessments-contract';

// Shared by the marks screens (contracts/slice-30.md §8): query keys, labels and refusals.

export const marksKeys = {
  all: ['assessments'] as const,
  list: (query: object) => ['assessments', 'list', query] as const,
  grid: (id: string) => ['assessments', 'grid', id] as const,
  classSubjects: (classId: string) => ['assessments', 'class-subjects', classId] as const,
};

export const marksHref = (id: string) => `/marks/${id}`;

export const TEST_TYPE_LABELS: Record<TestType, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  other: 'Other',
};

/** "Weekly test", "Exam". */
export const kindLabel = (a: Pick<AssessmentDto, 'kind' | 'testType'>): string =>
  a.kind === 'exam' ? 'Exam' : `${TEST_TYPE_LABELS[a.testType ?? 'other']} test`;

const MARKS_REFUSALS: RefusalMessages = {
  [ErrorCode.ASSESSMENT_LOCKED]: 'This test is locked: its result sheet has been submitted.',
  [ErrorCode.ASSESSMENT_VOIDED]: 'This assessment has been voided.',
  [ErrorCode.ASSESSMENT_OUTSIDE_TERM]: 'The date is not inside a term of the academic year.',
  [ErrorCode.SUBJECT_NOT_ASSIGNED]: 'You do not teach this subject in this section on that date.',
  [ErrorCode.MARK_EXCEEDS_MAX]: (details) =>
    `A mark cannot be more than the maximum of ${String(details.max)}.`,
  [ErrorCode.ACADEMIC_YEAR_CLOSED]: 'The academic year is closed.',
};

export const marksErrorMessage = (error: unknown): string => refusalMessage(error, MARKS_REFUSALS);
