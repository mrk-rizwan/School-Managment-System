import { markDraftProblem } from '@asms/shared';
import type {
  AssessmentMarkRowDto,
  AssessmentMarksDto,
  AssessmentSubmitMarksDto,
  MarkEntryResultDto,
} from '../api/contracts';
import type { LocalAssessmentMark, MarkInput } from '../db/local-marks.repository';

// The marks grid, pure (plan §3.8, contracts/slice-30.md §9): what a row shows (the server's mark
// overlaid with the device's own latest intent), what Save sends (only the rows typed, each with
// the live mark the phone saw), and the server's per-row answer laid over the cached grid.

/** What a row holds: a mark, an absence, or nothing yet. */
export type RowValue = { obtained: number | null; absent: boolean };

/** A row typed on the screen and not yet saved: the text as typed (validated on save). */
export type Draft = { text: string; absent: boolean };

/** The device's rows that still say something the server's grid does not. */
const PENDING: ReadonlySet<LocalAssessmentMark['state']> = new Set(['waiting', 'queued', 'failed']);

export function serverValue(row: AssessmentMarkRowDto): RowValue {
  return { obtained: row.obtained, absent: row.absent };
}

/** The value a row shows: the device's latest unsent intent, else the server's mark. */
export function rowValue(
  row: AssessmentMarkRowDto,
  local: LocalAssessmentMark | undefined,
): RowValue {
  if (local !== undefined && PENDING.has(local.state))
    return { obtained: local.obtained, absent: local.absent };
  return serverValue(row);
}

export const sameValue = (a: RowValue, b: RowValue): boolean =>
  a.absent === b.absent && (a.absent || a.obtained === b.obtained);

export const draftOf = (value: RowValue): Draft => ({
  text: value.absent || value.obtained === null ? '' : String(value.obtained),
  absent: value.absent,
});

/** A draft as a value, or the problem with it. Blank and not absent is "nothing to send". */
export function parseDraft(
  draft: Draft,
  max: number,
): { value: RowValue | null; error: string | null } {
  if (draft.absent) return { value: { obtained: null, absent: true }, error: null };
  const text = draft.text.trim();
  if (text === '') return { value: null, error: null };
  const error = markDraftProblem(text, max);
  if (error !== null) return { value: null, error };
  return { value: { obtained: Number(text), absent: false }, error: null };
}

/**
 * What Save sends: the rows whose draft differs from what they show, each based on the server's
 * live mark (null when it has none) — never on a mark the device made up (R262).
 */
export function marksToSave(
  rows: readonly AssessmentMarkRowDto[],
  drafts: Readonly<Record<string, Draft>>,
  locals: ReadonlyMap<string, LocalAssessmentMark>,
  max: number,
): { marks: MarkInput[]; errors: Record<string, string> } {
  const marks: MarkInput[] = [];
  const errors: Record<string, string> = {};
  for (const row of rows) {
    const draft = drafts[row.enrolmentId];
    if (draft === undefined) continue;
    const { value, error } = parseDraft(draft, max);
    if (error !== null) {
      errors[row.enrolmentId] = error;
      continue;
    }
    if (value === null || sameValue(value, rowValue(row, locals.get(row.enrolmentId)))) continue;
    marks.push({ enrolmentId: row.enrolmentId, ...value, basedOnMarkId: row.markId });
  }
  return { marks, errors };
}

/**
 * The server's answer laid over a cached grid: each entry that landed (or was already so) now
 * shows the sent value with its live mark id; a changed-elsewhere entry is left for the refetch.
 */
export function applyMarkResults(
  grid: AssessmentMarksDto,
  sent: AssessmentSubmitMarksDto,
  results: readonly Pick<
    MarkEntryResultDto,
    'clientEntryKey' | 'enrolmentId' | 'markId' | 'outcome'
  >[],
): AssessmentMarksDto {
  const byKey = new Map(sent.entries.map((entry) => [entry.clientEntryKey, entry]));
  const landed = new Map<string, { markId: string; obtained: number | null; absent: boolean }>();
  for (const result of results) {
    const entry = byKey.get(result.clientEntryKey);
    if (entry === undefined || result.outcome === 'changed_elsewhere' || result.markId === null)
      continue;
    const absent = entry.absent === true;
    landed.set(result.enrolmentId, {
      markId: result.markId,
      obtained: absent ? null : (entry.obtained ?? null),
      absent,
    });
  }
  const rows = grid.rows.map((row) => {
    const mark = landed.get(row.enrolmentId);
    if (mark === undefined) return row;
    return {
      ...row,
      markId: mark.markId,
      obtained: mark.obtained,
      absent: mark.absent,
      excused: false,
      status: 'live' as const,
    };
  });
  return {
    ...grid,
    rows,
    assessment: { ...grid.assessment, markedCount: rows.filter((r) => r.status === 'live').length },
  };
}

/** "18 of 30 marked": the rows showing a mark or an absence. */
export function markedLine(
  rows: readonly AssessmentMarkRowDto[],
  valueOf: (row: AssessmentMarkRowDto) => RowValue,
): string {
  const marked = rows.filter((row) => {
    const value = valueOf(row);
    return value.absent || value.obtained !== null;
  }).length;
  return `${marked} of ${rows.length} marked`;
}

/** Entries based on the mark a landed entry replaced are now based on the mark it made. */
export function rebaseEntries(
  body: AssessmentSubmitMarksDto,
  rebases: readonly { enrolmentId: string; from: string | null; to: string }[],
): AssessmentSubmitMarksDto {
  return {
    entries: body.entries.map((entry) => {
      const rebase = rebases.find(
        (r) => r.enrolmentId === entry.enrolmentId && r.from === (entry.basedOnMarkId ?? null),
      );
      return rebase ? { ...entry, basedOnMarkId: rebase.to } : entry;
    }),
  };
}
