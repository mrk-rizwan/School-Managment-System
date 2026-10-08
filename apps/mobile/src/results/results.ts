import { ApiError, ErrorCode, formatPercentLabel, resultTermLabel } from '@asms/shared';
import { api, isNetworkError, unwrap } from '../api/client';
import type {
  ResultPreviewRowDto,
  ResultSheetDetailDto,
  ResultSheetDto,
  TermDto,
} from '../api/contracts';

// Result sheets on the phone (phase-4-academic.md slice 31, §3.8, §0.30): the class teacher's
// sheet under the Marks tab (preview, remarks, submit) and the principal's under Approvals
// (preview, approve, return). Every action is online-only: called directly, never the outbox, and
// nothing is cached on the phone. Secure: the preview names children with their figures.

export const fetchSheet = (id: string): Promise<ResultSheetDetailDto> =>
  unwrap(api.GET('/api/v1/result-sheets/{id}', { params: { path: { id } } }));

export const fetchTerms = async (yearId: string): Promise<TermDto[]> =>
  (
    await unwrap(
      api.GET('/api/v1/academic-years/{id}/terms', {
        params: { path: { id: yearId }, query: { limit: 10 } },
      }),
    )
  ).data;

export const STATUS_WORDS: Record<ResultSheetDto['status'], string> = {
  draft: 'Draft',
  submitted: 'Waiting for approval',
  returned: 'Returned',
  approved: 'Approved',
  published: 'Published',
};

export const sheetTitle = (
  s: Pick<ResultSheetDto, 'className' | 'sectionName' | 'termName' | 'isFinal'>,
): string => `${s.className} ${s.sectionName} · ${resultTermLabel(s)}`;

/** One row's line: "74.50 % · B · 1 / 2", "Not assessed", with a gap or fail note. */
export function rowLine(r: ResultPreviewRowDto): string {
  const parts = [formatPercentLabel(r.percentBp)];
  if (r.grade) parts.push(r.grade);
  if (r.position !== null) parts.push(`${r.position} / ${r.positionOf}`);
  if (r.passed === false) parts.push('fail');
  if (r.missing > 0) parts.push(`${r.missing} missing`);
  return parts.join(' · ');
}

/** The own-child note of a sheet, or null (R276: flagged, never blocked). */
export function ownChildNote(s: Pick<ResultSheetDto, 'ownChildFlags'>): string | null {
  if (s.ownChildFlags.length === 0) return null;
  const names = [...new Set(s.ownChildFlags.map((f) => f.userName))].join(', ');
  return `${names} is a guardian of a student on this sheet.`;
}

const REFUSALS: Partial<Record<string, string>> = {
  [ErrorCode.MARKS_INCOMPLETE]:
    'Some marks are missing. Enter a mark or an absence for every student first.',
  [ErrorCode.EXAM_NOT_SET_UP]: 'The term exam is not set up for every subject of this section.',
  [ErrorCode.SELF_ACTION_FORBIDDEN]: 'You submitted this sheet: another principal decides it.',
  [ErrorCode.RESULT_SHEET_TERMS_UNPUBLISHED]:
    'Publish every held term of the year for this section first.',
};

/** What to tell the user when a sheet action fails; `stale` reads the sheet again. */
export function sheetFailure(error: unknown): { message: string; stale: boolean } {
  if (isNetworkError(error))
    return { message: 'No connection. Nothing was sent; try again when connected.', stale: false };
  if (!(error instanceof ApiError))
    return { message: 'This could not be sent. Try again.', stale: false };
  const known = REFUSALS[error.code];
  if (known) return { message: known, stale: false };
  if (error.status === 409 || error.status === 404) return { message: error.message, stale: true };
  return { message: error.fieldErrors[0]?.message ?? error.message, stale: false };
}
