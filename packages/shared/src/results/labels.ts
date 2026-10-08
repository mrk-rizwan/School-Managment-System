// How a result is labelled on every surface (the API prints, the web, the app): one definition, so
// a card reads the same wherever it is shown (phase-4-academic.md §3.4, rule 26).
import { formatPercentBp } from './compose';

/** 7850 → "78.50 %"; null → "—". */
export const formatPercentLabel = (bp: number | null | undefined): string =>
  bp === null || bp === undefined ? '—' : `${formatPercentBp(bp)} %`;

/** "Mid-term"; "Final result" for the final result of the year. */
export const resultTermLabel = (r: { readonly isFinal: boolean; readonly termName: string | null }): string =>
  r.isFinal ? 'Final result' : (r.termName ?? '');

/**
 * The exam marker of a subject on a card (rule 26): `Ab` when the student was absent from the term
 * exam and it was not excused (it counted 0), `Ex` when the absence was excused (the subject is
 * composed from the tests taken). "—" is not used: it already means "not assessed".
 */
export type ExamMarker = 'Ab' | 'Ex';

export const examMarker = (s: {
  readonly examAbsent?: boolean;
  readonly examExcused?: boolean;
}): ExamMarker | null => (s.examAbsent ? (s.examExcused ? 'Ex' : 'Ab') : null);

/** The card's legend line, printed when any subject carries a marker. */
export const EXAM_MARKER_LEGEND =
  'Ab: absent from the exam, counted as 0. Ex: absence from the exam excused; the subject is composed from the tests taken.';
