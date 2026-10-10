// Phase 5 groundwork (phase-5-extended.md §3.3): the pure functions in packages/shared, table-tested
// the way the Phase 4 composition functions are (test/academics/results-compose.spec.ts). Each is
// the one rule the web, the app and the API share, so a wrong answer here is wrong everywhere.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Capability,
  CAPABILITY_GROUPS,
  classRanking,
  CSV_IMPORT_LIMITS,
  CSV_MAX_ROWS,
  csvFileName,
  DEFAULT_PASSWORD_INERT_ACTIONS,
  DEFAULT_PASSWORD_INERT_CAPABILITIES,
  financialStatement,
  markFromPunch,
  NEVER_GRANTABLE,
  parseOpeningBalances,
  parsePastResults,
  punchDay,
  punchOutsideWindow,
  readCsv,
  roomKey,
  SYSTEM_ROLE_DEFAULTS,
  timetableClashes,
  toCsv,
  type StatementLine,
} from '@asms/shared';

const bytes = (text: string) => new TextEncoder().encode(text);

// ------------------------------------------------------------------------------------- csv

describe('csv.ts (R336)', () => {
  const columns = [
    { header: 'Name', value: (r: { name: string; amount: number | null }) => r.name },
    { header: 'Amount', value: (r: { name: string; amount: number | null }) => r.amount },
  ];

  it.each([
    ['plain text', 'Hira Tariq', 'Hira Tariq'],
    ['a comma is quoted', 'Tariq, Hira', '"Tariq, Hira"'],
    ['a quote is doubled', 'The "best" class', '"The ""best"" class"'],
    ['a newline is quoted', 'two\nlines', '"two\nlines"'],
    ['= is prefixed', '=HYPERLINK("x")', `"'=HYPERLINK(""x"")"`],
    ['+ is prefixed', '+92300', "'+92300"],
    ['- is prefixed', '-1+1', "'-1+1"],
    ['@ is prefixed', '@SUM(A1)', "'@SUM(A1)"],
    ['a tab is prefixed', '\tcmd', "'\tcmd"],
    ['a CR is prefixed and quoted', '\rcmd', `"'\rcmd"`],
  ])('%s', (_case, name, cell) => {
    expect(toCsv([{ name, amount: 1 }], columns)).toBe(`Name,Amount\r\n${cell},1\r\n`);
  });

  it('numbers stay numbers (a negative amount is not prefixed), null is empty', () => {
    expect(toCsv([{ name: 'A', amount: -500 }, { name: 'B', amount: null }], columns)).toBe('Name,Amount\r\nA,-500\r\nB,\r\n');
  });

  it('refuses more than CSV_MAX_ROWS rows and no columns', () => {
    const rows = Array.from({ length: CSV_MAX_ROWS + 1 }, () => ({ name: 'x', amount: 1 }));
    expect(() => toCsv(rows, columns)).toThrow(RangeError);
    expect(toCsv(rows.slice(1), columns).split('\r\n')).toHaveLength(CSV_MAX_ROWS + 2);
    expect(() => toCsv([], [])).toThrow(RangeError);
  });

  it('csvFileName is a fixed ASCII name', () => {
    expect(csvFileName('financial-statement', '2026-10-09')).toBe('financial-statement-2026-10-09.csv');
    expect(() => csvFileName('Hira Tariq', '2026-10-09')).toThrow(RangeError);
    expect(() => csvFileName('report', '9/10/2026')).toThrow(RangeError);
  });

  it('readCsv reads quotes, CRLF, a BOM and blank lines, and trims cells', () => {
    const result = readCsv(bytes('﻿admission_no , note\r\n"101","a, ""quoted"" note"\r\n\r\n102,  plain \n'));
    expect(result).toEqual({
      ok: true,
      header: ['admission_no', 'note'],
      rows: [
        { line: 2, cells: ['101', 'a, "quoted" note'] },
        { line: 4, cells: ['102', 'plain'] },
      ],
    });
  });

  it.each([
    ['empty', '', 'empty'],
    ['unterminated quote', 'a,b\n"x,1\n', 'unterminated_quote'],
    ['ragged row', 'a,b\n1\n', 'ragged_row'],
    ['too many columns', `${Array.from({ length: 65 }, (_, i) => `c${i}`).join(',')}\n`, 'too_many_columns'],
    ['cell too long', `a\n${'x'.repeat(65)}\n`, 'cell_too_long'],
    ['too many rows', `a\n${'1\n'.repeat(CSV_IMPORT_LIMITS.maxRows + 1)}`, 'too_many_rows'],
  ])('readCsv refuses: %s', (_case, text, problem) => {
    expect(readCsv(bytes(text))).toMatchObject({ ok: false, problem });
  });

  it('readCsv refuses a file over 2 MB and one that is not UTF-8', () => {
    expect(readCsv(new Uint8Array(CSV_IMPORT_LIMITS.maxBytes + 1))).toMatchObject({ ok: false, problem: 'too_large' });
    expect(readCsv(new Uint8Array([0x61, 0x0a, 0xff, 0xfe, 0x0a]))).toMatchObject({ ok: false, problem: 'not_utf8' });
  });
});

// -------------------------------------------------------------------------------- timetable

describe('timetable/clashes.ts (R302)', () => {
  const ctx = { periodsPerDay: 8, weeklyOffDays: [0] };

  it('a clean week has no clash', () => {
    expect(
      timetableClashes(
        [
          { weekday: 1, period: 1, staffId: '7', room: 'Lab' },
          { weekday: 1, period: 2, staffId: '7', room: 'Lab' },
          { weekday: 2, period: 1, staffId: '8', room: null },
        ],
        ctx,
      ),
    ).toEqual([]);
  });

  it('two slots in one section-period, an off day, and periods or weekdays out of range', () => {
    expect(
      timetableClashes(
        [
          { weekday: 1, period: 1, staffId: '7' },
          { weekday: 1, period: 1, staffId: '8' },
          { weekday: 0, period: 2, staffId: '7' },
          { weekday: 1, period: 9, staffId: '7' },
          { weekday: 1, period: 0, staffId: '7' },
          { weekday: 7, period: 1, staffId: '7' },
          { weekday: 1, period: 1.5, staffId: '7' },
        ],
        ctx,
      ).map((c) => [c.kind, c.index]),
    ).toEqual([
      ['section', 1],
      ['off_day', 2],
      ['period', 3],
      ['period', 4],
      ['weekday', 5],
      ['period', 6],
    ]);
  });

  it('periods_per_day above 12 is capped at the column limit', () => {
    expect(timetableClashes([{ weekday: 1, period: 13, staffId: '7' }], { periodsPerDay: 14, weeklyOffDays: [] })).toEqual([
      { kind: 'period', index: 0, weekday: 1, period: 13 },
    ]);
  });

  it("a teacher or a room already used by another section in that weekday and period", () => {
    const others = [
      { id: '501', sectionId: '9', weekday: 3, period: 4, staffId: '7', room: ' Science LAB ' },
      { id: '502', sectionId: '9', weekday: 3, period: 5, staffId: '8', room: null },
    ];
    expect(
      timetableClashes(
        [
          { weekday: 3, period: 4, staffId: '7', room: null },
          { weekday: 3, period: 5, staffId: '9', room: 'science lab' },
          { weekday: 3, period: 6, staffId: '7', room: 'science lab' },
        ],
        { ...ctx, others },
      ),
    ).toEqual([{ kind: 'teacher', index: 0, weekday: 3, period: 4, conflictingSlotId: '501' }]);
    expect(
      timetableClashes([{ weekday: 3, period: 4, staffId: '9', room: 'Science Lab' }], { ...ctx, others }),
    ).toEqual([{ kind: 'room', index: 0, weekday: 3, period: 4, conflictingSlotId: '501' }]);
  });

  it('roomKey lower-cases and trims; blank is no room', () => {
    expect([roomKey(' Lab 2 '), roomKey('   '), roomKey(null), roomKey(undefined)]).toEqual(['lab 2', null, null, null]);
  });
});

// ---------------------------------------------------------------------------------- ranking

describe('results/ranking.ts (R333)', () => {
  it('standard competition ranking across sections, ties shared, the unassessed last and unranked', () => {
    const ranked = classRanking([
      { resultId: '1', studentId: 's1', percentBp: 7000 },
      { resultId: '2', studentId: 's2', percentBp: 9150 },
      { resultId: '3', studentId: 's3', percentBp: null },
      { resultId: '4', studentId: 's4', percentBp: 9150 },
      { resultId: '5', studentId: 's5', percentBp: 4000 },
    ]);
    expect(ranked.map((r) => [r.studentId, r.classPosition, r.positionOf])).toEqual([
      ['s2', 1, 4],
      ['s4', 1, 4],
      ['s1', 3, 4],
      ['s5', 4, 4],
      ['s3', null, null],
    ]);
  });

  it('an empty class ranks nobody', () => {
    expect(classRanking([])).toEqual([]);
  });
});

// -------------------------------------------------------------------------------- statement

describe('reports/statement.ts (R332)', () => {
  const period = { from: '2026-10-01', to: '2026-10-31' };
  const line = (kind: StatementLine['kind'], amount: number, occurredOn: string, verifiedOn: string | null = occurredOn): StatementLine => ({
    kind,
    amount,
    occurredOn,
    verifiedOn,
  });
  const lines: StatementLine[] = [
    line('receipt', 50_000, '2026-10-05'),
    line('receipt', 8_000, '2026-10-30', '2026-11-02'),
    line('receipt', 999, '2026-09-30'),
    line('refund', 2_000, '2026-10-12'),
    line('refund_reversal', 500, '2026-10-20'),
    line('expense', 7_000, '2026-10-10', '2026-10-15'),
    line('expense', 3_000, '2026-10-31', null),
    line('shortfall_write_off', 250, '2026-10-18'),
    line('salary', 30_000, '2026-10-01'),
    line('advance_paid', 5_000, '2026-10-03'),
    line('advance_recovery', 1_000, '2026-10-01'),
  ];

  it('on the received basis: the day it happened', () => {
    expect(financialStatement(lines, 'received', period)).toEqual({
      receipts: 58_000,
      refundReversals: 500,
      refunds: 2_000,
      netReceipts: 56_500,
      expenses: 10_000,
      shortfallWriteOffs: 250,
      salaries: 30_000,
      advancesPaid: 5_000,
      advanceRecoveries: 1_000,
      staff: 35_000,
      expenditure: 45_250,
      net: 11_250,
    });
  });

  it('on the verified basis: the day it was verified or decided; undecided rows left out', () => {
    const s = financialStatement(lines, 'verified', period);
    expect([s.receipts, s.expenses, s.net]).toEqual([50_000, 7_000, 50_000 + 500 - 2_000 - (7_000 + 250 + 35_000)]);
  });

  it('the identities hold for every line set: net = receipts + reversals - refunds - expenditure', () => {
    for (const basis of ['received', 'verified'] as const) {
      const s = financialStatement(lines, basis, period);
      expect(s.netReceipts).toBe(s.receipts + s.refundReversals - s.refunds);
      expect(s.staff).toBe(s.salaries + s.advancesPaid);
      expect(s.expenditure).toBe(s.expenses + s.shortfallWriteOffs + s.staff);
      expect(s.net).toBe(s.netReceipts - s.expenditure);
    }
  });

  it('an empty period is all zeros; a bad period or amount throws', () => {
    expect(financialStatement([], 'received', period).net).toBe(0);
    expect(() => financialStatement(lines, 'received', { from: '2026-10-31', to: '2026-10-01' })).toThrow(RangeError);
    expect(() => financialStatement([line('receipt', -1, '2026-10-02')], 'received', period)).toThrow(RangeError);
    expect(() => financialStatement([line('receipt', 1.5, '2026-10-02')], 'received', period)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------- punches

describe('attendance/punches.ts (R345)', () => {
  const TZ = 'Asia/Karachi';
  // 03:00Z is 08:00 in Karachi (UTC+5).
  it.each([
    ['no late time: present', '2026-10-09T05:00:00.000Z', null, 'present'],
    ['before the late time', '2026-10-09T02:59:59.000Z', '08:00', 'present'],
    ['exactly at it', '2026-10-09T03:00:00.000Z', '08:00:00', 'present'],
    ['one second after', '2026-10-09T03:00:01.000Z', '08:00', 'late'],
    ['a time column with seconds', '2026-10-09T03:16:00.000Z', '08:15:30', 'late'],
  ])('markFromPunch: %s', (_case, at, lateAfter, mark) => {
    expect(markFromPunch(new Date(at), lateAfter, TZ)).toBe(mark);
  });

  it('markFromPunch refuses a malformed time', () => {
    expect(() => markFromPunch(new Date(), '8am', TZ)).toThrow(RangeError);
  });

  it('punchDay is the school-local day', () => {
    expect(punchDay(new Date('2026-10-08T19:30:00.000Z'), TZ)).toBe('2026-10-09');
    expect(punchDay(new Date('2026-10-08T18:59:59.000Z'), TZ)).toBe('2026-10-08');
  });

  it('a punch is accepted from 7 days before receipt to 5 minutes after', () => {
    const received = new Date('2026-10-09T10:00:00.000Z');
    const at = (ms: number) => new Date(received.getTime() + ms);
    expect(punchOutsideWindow(at(-7 * 86_400_000), received)).toBe(false);
    expect(punchOutsideWindow(at(-7 * 86_400_000 - 1), received)).toBe(true);
    expect(punchOutsideWindow(at(5 * 60_000), received)).toBe(false);
    expect(punchOutsideWindow(at(5 * 60_000 + 1), received)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------- imports

describe('imports/past-results.ts (R339)', () => {
  const subjects = [
    { classSubjectId: '11', name: 'English', examMaxMarks: 100 },
    { classSubjectId: '12', name: 'Islamiyat', examMaxMarks: 50 },
  ];
  const roster = [
    { admissionNo: '101', studentId: '1', enrolmentId: '91' },
    { admissionNo: '102', studentId: '2', enrolmentId: '92' },
  ];
  const ctx = { subjects, roster, knownAdmissionNos: new Set(['101', '102', '300']) };

  it('a valid file gives one row per roster student, marks in subject order, Ab as absent', () => {
    const result = parsePastResults(bytes('Admission_No,islamiyat,ENGLISH\n101,45,88\n102,ab,0\n'), ctx);
    expect(result).toEqual({
      ok: true,
      errors: [],
      rows: [
        { admissionNo: '101', studentId: '1', enrolmentId: '91', row: 2, marks: [{ classSubjectId: '11', obtained: 88 }, { classSubjectId: '12', obtained: 45 }] },
        { admissionNo: '102', studentId: '2', enrolmentId: '92', row: 3, marks: [{ classSubjectId: '11', obtained: 0 }, { classSubjectId: '12', obtained: null }] },
      ],
    });
  });

  it('header problems are row 1 and stop there', () => {
    const result = parsePastResults(bytes('roll,English,Urdu,English\n101,1,2,3\n'), ctx);
    expect(result).toMatchObject({ ok: true, rows: [] });
    expect(result.ok && result.errors.map((e) => [e.row, e.field, e.code])).toEqual([
      [1, 'roll', 'first_column'],
      [1, 'Urdu', 'unknown_column'],
      [1, 'English', 'duplicate_column'],
      [1, 'Islamiyat', 'missing_column'],
    ]);
  });

  it('every row error is reported with its line; a missing roster student is an error, never an absence', () => {
    const result = parsePastResults(bytes('admission_no,English,Islamiyat\n101,101,7.5\n300,1,1\n999,1,1\n101,1,1\n,1,\n'), ctx);
    expect(result.ok && result.errors.map((e) => [e.row, e.field, e.code, e.admissionNo])).toEqual([
      [2, 'English', 'over_max', undefined],
      [2, 'Islamiyat', 'invalid_mark', undefined],
      [3, 'admission_no', 'not_on_roster', undefined],
      [4, 'admission_no', 'unknown_admission_no', undefined],
      [5, 'admission_no', 'duplicate', undefined],
      [6, 'admission_no', 'required', undefined],
      [6, 'Islamiyat', 'required', undefined],
      [0, 'admission_no', 'missing_from_file', '102'],
    ]);
    expect(result.ok && result.rows).toEqual([]);
  });

  it('two rows with a blank admission number are each "required", never "duplicate" (wave R review)', () => {
    const result = parsePastResults(bytes('admission_no,English,Islamiyat\n101,1,1\n102,1,1\n,1,1\n,2,2\n'), ctx);
    expect(result.ok && result.errors.map((e) => [e.row, e.field, e.code])).toEqual([
      [4, 'admission_no', 'required'],
      [5, 'admission_no', 'required'],
    ]);
  });

  it('a file that cannot be read says why', () => {
    expect(parsePastResults(bytes(''), ctx)).toEqual({ ok: false, problem: 'empty', line: null });
  });
});

describe('imports/opening-balances.ts (R339, R342)', () => {
  const roster = [
    { admissionNo: '101', studentId: '1', enrolmentId: '91' },
    { admissionNo: '102', studentId: '2', enrolmentId: '92' },
  ];
  const ctx = { roster, knownAdmissionNos: new Set(['101', '102', '300']) };

  it('a valid file: whole rupees above 0, an optional note; unlisted roster students are not charged', () => {
    expect(parseOpeningBalances(bytes('admission_no,amount,note\n101,12500,Arrears 2025-26\n'), ctx)).toEqual({
      ok: true,
      errors: [],
      rows: [{ admissionNo: '101', studentId: '1', enrolmentId: '91', row: 2, amount: 12_500, note: 'Arrears 2025-26' }],
    });
    expect(parseOpeningBalances(bytes('admission_no,amount\n102,1\n'), ctx)).toMatchObject({ ok: true, rows: [{ amount: 1, note: null }] });
  });

  it('refuses amounts that are not whole rupees above 0, identity numbers in a note, and the usual row problems', () => {
    const result = parseOpeningBalances(
      bytes('admission_no,amount,note\n101,0,\n102,1.50,\n300,5,\n999,5,\n101,5,\n,,\n102,5,CNIC 42101-1234567-1\n'),
      ctx,
    );
    expect(result.ok && result.errors.map((e) => [e.row, e.field, e.code])).toEqual([
      [2, 'amount', 'invalid_amount'],
      [3, 'amount', 'invalid_amount'],
      [4, 'admission_no', 'not_on_roster'],
      [5, 'admission_no', 'unknown_admission_no'],
      [6, 'admission_no', 'duplicate'],
      [7, 'admission_no', 'required'],
      [7, 'amount', 'required'],
      [8, 'admission_no', 'duplicate'],
      [8, 'note', 'identity_number'],
    ]);
    expect(result.ok && result.rows).toEqual([]);
  });

  it('two rows with a blank admission number are each "required", never "duplicate" (wave R review)', () => {
    const result = parseOpeningBalances(bytes('admission_no,amount,note\n,5,First\n,6,Second\n'), ctx);
    expect(result.ok && result.errors.map((e) => [e.row, e.field, e.code])).toEqual([
      [2, 'admission_no', 'required'],
      [3, 'admission_no', 'required'],
    ]);
  });

  it('header: admission_no first, amount required, nothing unknown or repeated', () => {
    const result = parseOpeningBalances(bytes('amount,admission_no,balance,amount\n1,101,2,3\n'), ctx);
    expect(result.ok && result.errors.map((e) => [e.field, e.code])).toEqual([
      ['amount', 'first_column'],
      ['balance', 'unknown_column'],
      ['amount', 'duplicate_column'],
    ]);
  });
});

// ------------------------------------------------------------------------- capabilities, rule 24

describe('capabilities.ts and rule24.ts (§0.36, R325, R354, R355)', () => {
  const ALL = Object.values(Capability);

  it('53 keys, each in exactly one group; audit.view under access and transport.manage under setup', () => {
    expect(ALL).toHaveLength(53);
    const grouped = Object.values(CAPABILITY_GROUPS).flat();
    expect([...grouped].sort()).toEqual([...ALL].sort());
    expect(CAPABILITY_GROUPS.access).toContain(Capability.AUDIT_VIEW);
    expect(CAPABILITY_GROUPS.setup).toContain(Capability.TRANSPORT_MANAGE);
  });

  it('defaults: the principal holds every key; office staff verify documents and manage transport; neither key is a teacher’s', () => {
    expect(SYSTEM_ROLE_DEFAULTS.principal).toEqual(ALL);
    expect(SYSTEM_ROLE_DEFAULTS.office_staff).toEqual(expect.arrayContaining([Capability.DOCUMENT_VERIFY, Capability.TRANSPORT_MANAGE]));
    expect(SYSTEM_ROLE_DEFAULTS.office_staff).not.toContain(Capability.AUDIT_VIEW);
    expect(SYSTEM_ROLE_DEFAULTS.teacher).not.toContain(Capability.AUDIT_VIEW);
    expect(SYSTEM_ROLE_DEFAULTS.teacher).not.toContain(Capability.TRANSPORT_MANAGE);
    // audit.view is grantable (R354); role.manage stays the one key that never is.
    expect(NEVER_GRANTABLE).toEqual([Capability.ROLE_MANAGE]);
  });

  it('the two inert keys are unchanged; the inert actions name routes that exist or belong to a Phase 5 slice', () => {
    expect(DEFAULT_PASSWORD_INERT_CAPABILITIES).toEqual([Capability.USER_ACCOUNT_MANAGE, Capability.ROLE_MANAGE]);
    const document = JSON.parse(readFileSync(join(__dirname, '../../openapi/school.json'), 'utf8')) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const LATER = new Set(['import.opening_balances', 'device_token.rotate', 'audit_log.view']);
    for (const [action, route] of Object.entries(DEFAULT_PASSWORD_INERT_ACTIONS)) {
      const path = `/api/v1${route.path.replace(/:([a-zA-Z]+)/g, '{$1}')}`;
      const exists = document.paths[path]?.[route.method.toLowerCase()] !== undefined;
      expect([action, exists]).toEqual([action, !LATER.has(action)]);
    }
  });
});
