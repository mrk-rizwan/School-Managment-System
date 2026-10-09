/**
 * Commencement imports (Phase 5 rule 39, phase-5-extended.md §1.1, §3.2, §3.3; R339-R343): the
 * value sets, and the row error every importer reports. Each set mirrors the Postgres enum of the
 * same name (migration 20261009120100_phase5_groundwork; shared-enums.e2e-spec.ts compares them).
 */

/** `imports.kind`: one CSV per section and term of past results, or one of opening balances. */
export const IMPORT_KINDS = ['past_results', 'opening_balances'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

/** previewed -> committed | failed; a preview expires (failed, "expired") after 24 h. */
export const IMPORT_STATUSES = ['previewed', 'committed', 'failed'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/** At most this many row errors travel in `IMPORT_ROWS_INVALID` (with the full `errorCount`). */
export const IMPORT_ERRORS_SHOWN = 100;

/** Why a row (or the header, row 1) is refused. A failed row fails the whole file (§0.34). */
export type ImportRowErrorCode =
  | 'first_column'
  | 'unknown_column'
  | 'missing_column'
  | 'duplicate_column'
  | 'required'
  | 'unknown_admission_no'
  | 'not_on_roster'
  | 'duplicate'
  | 'missing_from_file'
  | 'invalid_mark'
  | 'over_max'
  | 'invalid_amount'
  | 'identity_number';

export interface ImportRowError {
  /** The file line (header = 1); 0 for a roster student the file does not list. */
  readonly row: number;
  /** The column: `admission_no`, a subject's name, `amount`, `note`. */
  readonly field: string;
  readonly code: ImportRowErrorCode;
  /** On `missing_from_file`: the roster student's admission number. */
  readonly admissionNo?: string;
}

/** A student the file may name: the school's own admission number and ids (strings, as the API's). */
export interface ImportStudent {
  readonly admissionNo: string;
  readonly studentId: string;
  readonly enrolmentId: string;
}

/** The header cell `admission_no`, compared case-insensitively. */
export const ADMISSION_NO_COLUMN = 'admission_no';

/** A header cell as the importers compare it: trimmed, inner spaces collapsed, lower-cased. */
export const headerKey = (cell: string): string => cell.trim().replace(/\s+/g, ' ').toLowerCase();
