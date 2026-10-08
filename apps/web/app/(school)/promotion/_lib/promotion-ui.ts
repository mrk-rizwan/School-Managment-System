import { ErrorCode } from '@asms/shared';
import { refusalMessage, type RefusalMessages } from '@/lib/api/errors';
import type { PromotionOutcome } from '@/lib/api/school-promotion-contract';

// contracts/slice-35.md: the shared pieces of the Promotion pages.

export const promotionKeys = {
  all: ['promotion'] as const,
  list: (query: object) => ['promotion', 'list', query] as const,
  sheet: (id: string) => ['promotion', 'sheet', id] as const,
  sections: (yearId: string) => ['promotion', 'sections', yearId] as const,
  targets: (yearId: string) => ['promotion', 'targets', yearId] as const,
};

export const sheetHref = (id: string) => `/promotion/${id}`;

export const OUTCOME_LABELS: Record<PromotionOutcome, string> = {
  promote: 'Promote',
  detain: 'Detain (repeat)',
  complete: 'Complete (alumni)',
  not_continuing: 'Not continuing',
};

const ids = (details: Record<string, unknown>): number =>
  Array.isArray(details.enrolmentIds) ? details.enrolmentIds.length : 0;

const PROMOTION_REFUSALS: RefusalMessages = {
  [ErrorCode.PROMOTION_FINAL_NOT_APPROVED]:
    "Approve the section's final result (or its only term's result) before opening its promotion sheet.",
  [ErrorCode.PROMOTION_SHEET_OPEN]: 'This section already has an open promotion sheet.',
  [ErrorCode.PROMOTION_SHEET_NOT_OPEN]: 'This promotion sheet is no longer open: it has been applied or cancelled.',
  [ErrorCode.PROMOTION_INCOMPLETE]: (d) => `Decide every student first (${ids(d)} still undecided).`,
  [ErrorCode.PROMOTION_RESULT_SUPERSEDED]: (d) =>
    `${ids(d)} result(s) were corrected since the sheet read them: decide those students again.`,
  [`${ErrorCode.PROMOTION_TARGET_INVALID}:other_year`]:
    "The class to move into is not in the target year. Set each class's next class in the target year first.",
  [`${ErrorCode.PROMOTION_TARGET_INVALID}:archived`]: 'A class or section to move into is archived. Choose another.',
  [`${ErrorCode.PROMOTION_TARGET_INVALID}:no_target`]: 'Choose the class and section to move into.',
  [`${ErrorCode.PROMOTION_TARGET_INVALID}:not_final`]: 'Only a final class completes: decide promote or detain instead.',
  [ErrorCode.PROMOTION_ENROLMENT_AFTER_YEAR]: (d) =>
    `${ids(d)} enrolment(s) start after the year's end, so they cannot close at it: correct their dates first.`,
  [`${ErrorCode.PERMISSION_DENIED}:principal_required`]: 'Only a principal can cancel a promotion sheet.',
  [ErrorCode.STUDENT_NOT_ACTIVE]: 'A suspended student cannot be marked as not continuing: reactivate them first.',
  [ErrorCode.ACADEMIC_YEAR_CLOSED]: 'The academic year is closed.',
  [`${ErrorCode.PERMISSION_DENIED}:capability_not_held`]:
    'Marking a student as not continuing needs the student status permission.',
};

export const promotionErrorMessage = (error: unknown): string => refusalMessage(error, PROMOTION_REFUSALS);
