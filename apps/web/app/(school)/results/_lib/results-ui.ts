import { ErrorCode, formatPercentBp } from '@asms/shared';
import { refusalMessage, type RefusalMessages } from '@/lib/api/errors';
import type {
  OwnChildRole,
  ResultSheetDto,
  ResultSheetStatus,
} from '@/lib/api/school-results-contract';

// Shared by the result-sheet screens (contracts/slice-31.md §9): query keys, labels, refusals.

export const resultKeys = {
  all: ['result-sheets'] as const,
  list: (query: object) => ['result-sheets', 'list', query] as const,
  detail: (id: string) => ['result-sheets', 'detail', id] as const,
  terms: (yearId: string) => ['result-sheets', 'terms', yearId] as const,
};

export const sheetHref = (id: string) => `/results/sheets/${id}`;

export const SHEET_STATUS_LABELS: Record<ResultSheetStatus, string> = {
  draft: 'Draft',
  submitted: 'Waiting for approval',
  returned: 'Returned',
  approved: 'Approved',
  published: 'Published',
};

export const sheetStatusVariant = (
  status: ResultSheetStatus,
): 'default' | 'secondary' | 'outline' | 'destructive' =>
  status === 'published'
    ? 'default'
    : status === 'returned'
      ? 'destructive'
      : status === 'draft'
        ? 'outline'
        : 'secondary';

export const ROLE_LABELS: Record<OwnChildRole, string> = {
  mark_author: 'entered marks',
  remark_author: 'wrote the remark',
  submitter: 'submitted the sheet',
  approver: 'approves the sheet',
};

/** "Mid-term", "Final result". */
export const sheetTermLabel = (s: Pick<ResultSheetDto, 'termName' | 'isFinal'>): string =>
  s.isFinal ? 'Final result' : (s.termName ?? '');

/** 7850 → "78.50 %"; null → "—". */
export const percentLabel = (bp: number | null | undefined): string =>
  bp === null || bp === undefined ? '—' : `${formatPercentBp(bp)} %`;

const RESULT_REFUSALS: RefusalMessages = {
  [ErrorCode.MARKS_INCOMPLETE]: (details) => {
    const missing = Array.isArray(details.missing) ? details.missing.length : 0;
    return `Some marks are missing (${missing}${missing === 100 ? '+' : ''}). Enter a mark or an absence for every student first.`;
  },
  [ErrorCode.EXAM_NOT_SET_UP]: 'The term exam is not set up for every subject of this section.',
  [ErrorCode.RESULT_SHEET_NOT_DRAFT]: 'The sheet has already been submitted.',
  [ErrorCode.RESULT_SHEET_NOT_SUBMITTED]: 'The sheet is not waiting for a decision.',
  [ErrorCode.RESULT_SHEET_NOT_APPROVED]: 'Only an approved sheet can be published.',
  [ErrorCode.RESULT_SHEET_PUBLISHED]: 'This term’s sheet is already published.',
  [ErrorCode.RESULT_SHEET_VERSION_OPEN]: 'This section already has an open sheet for the term.',
  [ErrorCode.RESULT_SHEET_TERMS_UNPUBLISHED]:
    'Publish every held term of the year for this section first.',
  [ErrorCode.SELF_ACTION_FORBIDDEN]: 'You submitted this sheet: another principal decides it.',
  [ErrorCode.ACADEMIC_YEAR_CLOSED]: 'The academic year is closed.',
};

export const resultErrorMessage = (error: unknown): string =>
  refusalMessage(error, RESULT_REFUSALS);
