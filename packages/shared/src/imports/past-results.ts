/**
 * The past-results importer's parser (Phase 5 rule 39, §1.1 "Past results file"; R339). One CSV
 * per section and term: the admission number, then one column per class subject (by the subject's
 * name) holding the exam's obtained mark or `Ab`. Tests are not imported. The roster is the
 * section's enrolments live on the term's last day; a roster student missing from the file is an
 * error, never an absence (§0.34).
 */
import { readCsv, type CsvReadProblem } from '../csv';
import { ADMISSION_NO_COLUMN, headerKey, type ImportRowError, type ImportStudent } from './kinds';

export interface PastResultsSubject {
  readonly classSubjectId: string;
  /** The subject's name, as the header names it. */
  readonly name: string;
  readonly examMaxMarks: number;
}

export interface PastResultsContext {
  /** The class's subjects for the year, each a required column. */
  readonly subjects: readonly PastResultsSubject[];
  /** The section's enrolments live on the term's last day. */
  readonly roster: readonly ImportStudent[];
  /** Every admission number of the school the file names (to tell "unknown" from "not on roster"). */
  readonly knownAdmissionNos: ReadonlySet<string>;
}

export interface PastResultsRow extends ImportStudent {
  readonly row: number;
  /** In `subjects` order; `obtained` null is `Ab` (absent, counts 0, prints "Ab"). */
  readonly marks: readonly { readonly classSubjectId: string; readonly obtained: number | null }[];
}

export type PastResultsParse =
  | { readonly ok: false; readonly problem: CsvReadProblem; readonly line: number | null }
  | { readonly ok: true; readonly rows: readonly PastResultsRow[]; readonly errors: readonly ImportRowError[] };

type MarkRead = { readonly obtained: number | null } | 'required' | 'invalid_mark' | 'over_max';

/** `Ab` (any case) is absent; else a whole number from 0 to `max`. */
function readMark(cell: string, max: number): MarkRead {
  if (cell === '') return 'required';
  if (cell.toLowerCase() === 'ab') return { obtained: null };
  if (!/^[0-9]{1,4}$/.test(cell)) return 'invalid_mark';
  const obtained = Number(cell);
  return obtained > max ? 'over_max' : { obtained };
}

/**
 * Reads and validates a past-results file against the section's roster and the class's subjects.
 * Every error is returned (the caller shows the first IMPORT_ERRORS_SHOWN); rows are returned only
 * when there is none, since a failed row fails the file.
 */
export function parsePastResults(bytes: Uint8Array, ctx: PastResultsContext): PastResultsParse {
  const csv = readCsv(bytes);
  if (!csv.ok) return csv;
  const errors: ImportRowError[] = [];
  const header = csv.header.map(headerKey);
  if (header[0] !== ADMISSION_NO_COLUMN) {
    errors.push({ row: 1, field: csv.header[0] ?? '', code: 'first_column' });
  }
  // The header cell index of each class subject, matched by name.
  const columnOf = new Map<string, number>();
  header.slice(1).forEach((key, i) => {
    const subject = ctx.subjects.find((s) => headerKey(s.name) === key);
    const field = csv.header[i + 1] ?? '';
    if (subject === undefined) errors.push({ row: 1, field, code: 'unknown_column' });
    else if (columnOf.has(subject.classSubjectId)) errors.push({ row: 1, field, code: 'duplicate_column' });
    else columnOf.set(subject.classSubjectId, i + 1);
  });
  for (const subject of ctx.subjects) {
    if (!columnOf.has(subject.classSubjectId)) {
      errors.push({ row: 1, field: subject.name, code: 'missing_column' });
    }
  }
  if (errors.length > 0) return { ok: true, rows: [], errors };

  const roster = new Map(ctx.roster.map((s) => [s.admissionNo, s]));
  const seen = new Set<string>();
  const rows: PastResultsRow[] = [];
  for (const { line, cells } of csv.rows) {
    let rowOk = true;
    const refuse = (field: string, code: ImportRowError['code']) => {
      errors.push({ row: line, field, code });
      rowOk = false;
    };
    const admissionNo = cells[0] ?? '';
    const student = roster.get(admissionNo);
    if (admissionNo === '') refuse(ADMISSION_NO_COLUMN, 'required');
    else if (seen.has(admissionNo)) refuse(ADMISSION_NO_COLUMN, 'duplicate');
    else if (student === undefined) {
      refuse(ADMISSION_NO_COLUMN, ctx.knownAdmissionNos.has(admissionNo) ? 'not_on_roster' : 'unknown_admission_no');
    }
    if (admissionNo !== '') seen.add(admissionNo);
    const marks = ctx.subjects.map((subject) => {
      const read = readMark(cells[columnOf.get(subject.classSubjectId) ?? -1] ?? '', subject.examMaxMarks);
      if (typeof read === 'string') {
        refuse(subject.name, read);
        return { classSubjectId: subject.classSubjectId, obtained: null };
      }
      return { classSubjectId: subject.classSubjectId, obtained: read.obtained };
    });
    if (rowOk && student !== undefined) rows.push({ ...student, row: line, marks });
  }
  for (const student of ctx.roster) {
    if (!seen.has(student.admissionNo)) {
      errors.push({ row: 0, field: ADMISSION_NO_COLUMN, code: 'missing_from_file', admissionNo: student.admissionNo });
    }
  }
  return { ok: true, rows: errors.length === 0 ? rows : [], errors };
}
