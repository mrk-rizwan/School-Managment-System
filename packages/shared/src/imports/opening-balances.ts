/**
 * The opening-balances importer's parser (Phase 5 rule 39, §1.1 "Opening balance file"; R339,
 * R342). Columns: `admission_no`, `amount` (whole rupees, more than 0) and an optional `note`.
 * Each valid row becomes one manual charge under the seeded "Opening balance" head; a credit
 * balance is a counter payment, never an import row. A student must have a live enrolment in the
 * import's year (the roster); students the file does not list are simply not charged.
 */
import { readCsv, type CsvReadProblem } from '../csv';
import { containsIdentityNumber } from '../identity';
import { ADMISSION_NO_COLUMN, headerKey, type ImportRowError, type ImportStudent } from './kinds';

/** Whole rupees, 1 to 999,999,999 (a charge's amount is a 32-bit integer). */
const AMOUNT = /^[1-9][0-9]{0,8}$/;
const COLUMNS: readonly string[] = [ADMISSION_NO_COLUMN, 'amount', 'note'];

export interface OpeningBalancesContext {
  /** Students with a live enrolment in the import's year. */
  readonly roster: readonly ImportStudent[];
  /** Every admission number of the school the file names. */
  readonly knownAdmissionNos: ReadonlySet<string>;
}

export interface OpeningBalanceRow extends ImportStudent {
  readonly row: number;
  readonly amount: number;
  /** Null when blank. Never holds an identity number. */
  readonly note: string | null;
}

export type OpeningBalancesParse =
  | { readonly ok: false; readonly problem: CsvReadProblem; readonly line: number | null }
  | { readonly ok: true; readonly rows: readonly OpeningBalanceRow[]; readonly errors: readonly ImportRowError[] };

/** Reads and validates an opening-balances file. Rows are returned only when there is no error. */
export function parseOpeningBalances(bytes: Uint8Array, ctx: OpeningBalancesContext): OpeningBalancesParse {
  const csv = readCsv(bytes);
  if (!csv.ok) return csv;
  const errors: ImportRowError[] = [];
  const header = csv.header.map(headerKey);
  if (header[0] !== ADMISSION_NO_COLUMN) {
    errors.push({ row: 1, field: csv.header[0] ?? '', code: 'first_column' });
  }
  header.forEach((key, i) => {
    const field = csv.header[i] ?? '';
    if (!COLUMNS.includes(key)) errors.push({ row: 1, field, code: 'unknown_column' });
    else if (header.indexOf(key) !== i) errors.push({ row: 1, field, code: 'duplicate_column' });
  });
  if (!header.includes('amount')) errors.push({ row: 1, field: 'amount', code: 'missing_column' });
  if (errors.length > 0) return { ok: true, rows: [], errors };

  const at = (cells: readonly string[], column: string): string => cells[header.indexOf(column)] ?? '';
  const roster = new Map(ctx.roster.map((s) => [s.admissionNo, s]));
  const seen = new Set<string>();
  const rows: OpeningBalanceRow[] = [];
  for (const { line, cells } of csv.rows) {
    let rowOk = true;
    const refuse = (field: string, code: ImportRowError['code']) => {
      errors.push({ row: line, field, code });
      rowOk = false;
    };
    const admissionNo = at(cells, ADMISSION_NO_COLUMN);
    const student = roster.get(admissionNo);
    if (admissionNo === '') refuse(ADMISSION_NO_COLUMN, 'required');
    else if (seen.has(admissionNo)) refuse(ADMISSION_NO_COLUMN, 'duplicate');
    else if (student === undefined) {
      refuse(ADMISSION_NO_COLUMN, ctx.knownAdmissionNos.has(admissionNo) ? 'not_on_roster' : 'unknown_admission_no');
    }
    seen.add(admissionNo);
    const amount = at(cells, 'amount');
    if (amount === '') refuse('amount', 'required');
    else if (!AMOUNT.test(amount)) refuse('amount', 'invalid_amount');
    const note = header.includes('note') ? at(cells, 'note') : '';
    if (containsIdentityNumber(note)) refuse('note', 'identity_number');
    if (rowOk && student !== undefined) {
      rows.push({ ...student, row: line, amount: Number(amount), note: note === '' ? null : note });
    }
  }
  return { ok: true, rows: errors.length === 0 ? rows : [], errors };
}
