/**
 * CSV export and import primitives (Phase 5 rule 38, phase-5-extended.md §1.1 "CSV", §3.3; R336).
 * One writer for every report's `?format=csv` and one reader for the commencement imports, so the
 * escaping and the bounds are written once.
 */

/** R336: a report's CSV holds at most this many rows (the API refuses a larger export). */
export const CSV_MAX_ROWS = 10_000;

/**
 * Spreadsheet formula injection (OWASP "CSV injection"): a text cell starting with one of these is
 * read as a formula by Excel, LibreOffice and Sheets. Such a cell is written with a leading `'`.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/** A column of an export: its header and how a row gives its cell. */
export interface CsvColumn<Row> {
  readonly header: string;
  readonly value: (row: Row) => string | number | boolean | null | undefined;
}

/** One cell as written: text is injection-prefixed and quoted when needed; numbers as they are. */
function cell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError('a CSV number must be finite');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * The rows as CSV text (RFC 4180, CRLF line ends, a header row, no byte-order mark): exactly the
 * columns given, in order. Text cells beginning `= + - @ TAB CR` are prefixed with `'` (headers
 * too); numbers are written as numbers, so a negative amount stays a number. Throws above
 * CSV_MAX_ROWS rows: the caller refuses the export first.
 */
export function toCsv<Row>(rows: readonly Row[], columns: readonly CsvColumn<Row>[]): string {
  if (rows.length > CSV_MAX_ROWS) throw new RangeError(`a CSV export holds at most ${CSV_MAX_ROWS} rows`);
  if (columns.length === 0) throw new RangeError('a CSV export needs at least one column');
  const lines = [columns.map((c) => cell(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(c.value(row))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * A fixed ASCII download name (R336): `<report>-<YYYY-MM-DD>.csv`, where `report` is a lower-case
 * slug the server chooses. Never a student's or school's name (a header value must stay ASCII).
 */
export function csvFileName(report: string, day: string): string {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(report)) throw new RangeError(`not a report slug: ${report}`);
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day)) throw new RangeError(`not a calendar date: ${day}`);
  return `${report}-${day}.csv`;
}

// ------------------------------------------------------------------------------------ reading

/** §1.1 / §3.3: the bounds every imported file is read within. */
export const CSV_IMPORT_LIMITS = {
  /** UTF-8 bytes. */
  maxBytes: 2 * 1024 * 1024,
  /** Data rows, the header excluded. */
  maxRows: 5_000,
  maxColumns: 64,
  /** Characters per cell, after trimming. */
  maxCellChars: 64,
} as const;

/** Why a file could not be read at all (each row's own problems are the importer's). */
export type CsvReadProblem =
  | 'too_large'
  | 'not_utf8'
  | 'empty'
  | 'unterminated_quote'
  | 'too_many_rows'
  | 'too_many_columns'
  | 'cell_too_long'
  | 'ragged_row';

export type CsvReadResult =
  | {
      readonly ok: true;
      /** The header's cells, trimmed. */
      readonly header: readonly string[];
      /** Each data row's cells, trimmed; `line` is the row's 1-based line in the file (header = 1). */
      readonly rows: readonly { readonly line: number; readonly cells: readonly string[] }[];
    }
  | { readonly ok: false; readonly problem: CsvReadProblem; readonly line: number | null };

/**
 * Reads a CSV import file (RFC 4180: `"` quotes, `""` escapes, CRLF or LF, an optional UTF-8
 * byte-order mark, an optional final newline). Blank lines are skipped. Every row must have the
 * header's number of cells. Bounds per CSV_IMPORT_LIMITS. `bytes` is the raw upload, decoded here
 * as strict UTF-8 so a file in another encoding is refused, not mangled.
 */
export function readCsv(bytes: Uint8Array, limits = CSV_IMPORT_LIMITS): CsvReadResult {
  if (bytes.byteLength > limits.maxBytes) return { ok: false, problem: 'too_large', line: null };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return { ok: false, problem: 'not_utf8', line: null };
  }
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let current = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  // Every cell is trimmed, quoted or not: no imported value has meaningful edge whitespace.
  const endCell = () => {
    cells.push(current.trim());
    current = '';
  };
  const endRecord = () => {
    endCell();
    if (!(cells.length === 1 && cells[0] === '')) records.push({ line: recordLine, cells });
    cells = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        if (char === '\n') line += 1;
        current += char;
      }
      continue;
    }
    if (char === '"' && current.trim() === '') {
      quoted = true;
      current = '';
    } else if (char === ',') {
      endCell();
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      endRecord();
      line += 1;
      recordLine = line;
    } else {
      current += char;
    }
  }
  if (quoted) return { ok: false, problem: 'unterminated_quote', line: recordLine };
  if (current !== '' || cells.length > 0) endRecord();

  const [head, ...data] = records;
  if (head === undefined) return { ok: false, problem: 'empty', line: null };
  if (head.cells.length > limits.maxColumns) return { ok: false, problem: 'too_many_columns', line: head.line };
  if (data.length > limits.maxRows) return { ok: false, problem: 'too_many_rows', line: null };
  for (const record of records) {
    if (record.cells.length !== head.cells.length) return { ok: false, problem: 'ragged_row', line: record.line };
    if (record.cells.some((c) => [...c].length > limits.maxCellChars)) {
      return { ok: false, problem: 'cell_too_long', line: record.line };
    }
  }
  return { ok: true, header: head.cells, rows: data };
}
