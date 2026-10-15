// Phase 5 slice 42 (contracts/slice-42.md §2.1, §3; R332, R336, R338): the financial statement's
// lines beyond the R228 year (test/finance-reports/reconciliation.e2e-spec.ts reconciles that
// year on both bases) — an advance recorded as an expense counted once, as an advance; its
// recovery shown, never subtracted; the windows and the school's default basis; refusals — and the
// finance reports' CSV: each one's rows equal the JSON's, injection-safe, audited, same-site only,
// page and limit refused, five hits in the finance-reports bucket.
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { ErrorCode, newIdempotencyKey } from '@asms/shared';
import { API, ORIGIN, type ErrorBody } from '../payments/payments-support';
import { createTestApp } from '../core/app';
import { closeTestDb } from '../support/schools';
import { isoDay } from '../support/students';
import { db, karachi, pupil, runMonth } from '../fees/charges-support';
import { monthOf, reportsHttp, shiftMonth } from '../finance-reports/support';
import { csvGet, expectCsvHeaders, parseCsv } from './support';

interface Figures {
  period: string;
  from: string;
  to: string;
  receipts: number;
  refundReversals: number;
  refunds: number;
  netReceipts: number;
  expenses: number;
  shortfallWriteOffs: number;
  salaries: number;
  advancesPaid: number;
  advanceRecoveries: number;
  staff: number;
  expenditure: number;
  net: number;
}

/** A text cell as toCsv writes it: a formula start prefixed with an apostrophe. */
const asCell = (value: string): string => (/^[=+\-@\t\r]/.test(value) ? `'${value}` : value);

type Row = Record<string, unknown>;

interface Statement {
  basis: string;
  from: string;
  to: string;
  months: Figures[];
  total: Figures;
}

describe('R332, R336: the financial statement and the finance reports CSV (e2e)', () => {
  let app: NestExpressApplication;
  const h = reportsHttp(() => app);
  const { get, post } = h;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('R332: an advance recorded as an expense is counted once, as an advance; its recovery is shown, not subtracted; windows and the default basis', async () => {
    const w = await h.world();
    const P = w.principal;
    const schoolId = w.school.id;
    const staffId = w.teacher.user.staffId;
    const month = shiftMonth(monthOf(0), -1);
    await post(
      `/staff/${staffId}/salary-structure`,
      { basic: 30000, components: [], effectiveFrom: `${monthOf(-150)}-01`, reason: 'Appointment' },
      P,
      newIdempotencyKey(),
    ).expect(201);
    // An advance of 6,000 granted last month, recorded as an expense (above the threshold, so
    // approved on record), recovered 2,000 a month from that month's payslip.
    await post(
      '/salary-advances',
      {
        staffId: staffId.toString(),
        amount: 6000,
        grantedOn: `${month}-05`,
        recoverFrom: month,
        instalmentAmount: 2000,
        paidMethod: 'cash',
        recordAsExpense: true,
      },
      P,
      newIdempotencyKey(),
    ).expect(201);
    const advanceExpense = await db().expense.findFirstOrThrow({ where: { schoolId, category: 'salary_advance_cash' } });
    expect([advanceExpense.amount, advanceExpense.status]).toEqual([6000, 'approved']);
    const run = (await post('/payroll-runs', { yearMonth: month }, P).expect(201)).body as { id: string };
    await post(`/payroll-runs/${run.id}/finalise`, {}, P).expect(200);
    const slip = await db().payslip.findFirstOrThrow({ where: { schoolId, runId: BigInt(run.id), staffId } });
    expect(slip.advanceRecovery).toBe(2000);
    await post(`/payslips/${slip.id}/mark-paid`, { paidOn: isoDay(0), paidMethod: 'cash' }, P).expect(200);

    const from = `${month}-01`;
    const to = isoDay(0);
    const statementOf = async (query: string) =>
      (await get(`/finance-reports/financial-statement?${query}`, P).expect(200)).body as Statement;
    for (const basis of ['received', 'verified']) {
      const s = await statementOf(`from=${from}&to=${to}&basis=${basis}`);
      expect(s).toMatchObject({ basis, from, to });
      expect(s.total).toMatchObject({
        period: 'total',
        expenses: 0,
        advancesPaid: 6000,
        salaries: slip.net,
        advanceRecoveries: 2000,
        staff: slip.net + 6000,
        expenditure: slip.net + 6000,
      });
      expect(s.total.net).toBe(s.total.netReceipts - s.total.expenditure);
      // A row per calendar month, clipped to the window, summing to the total.
      expect(s.months.map((m) => m.period)).toEqual([month, monthOf(0)]);
      expect(s.months[0]?.from).toBe(from);
      expect(s.months.at(-1)?.to).toBe(to);
      expect(s.months.reduce((sum, m) => sum + m.advancesPaid + m.salaries, 0)).toBe(6000 + slip.net);
    }
    // The expenses report still lists the advance's expense row (it is an expense there); the
    // statement moved it to advances paid, so the money leaves once.
    const expenses = (await get(`/finance-reports/expenses?spentFrom=${from}&spentTo=${to}`, P).expect(200)).body as { total: number };
    expect(expenses.total).toBe(6000);
    // Received: the advance falls in the month granted; verified: the day it was recorded (today).
    const byMonth = (s: Statement, period: string) => s.months.find((m) => m.period === period)?.advancesPaid;
    const received = await statementOf(`from=${from}&to=${to}&basis=received`);
    const verified = await statementOf(`from=${from}&to=${to}&basis=verified`);
    expect([byMonth(received, month), byMonth(verified, month)]).toEqual([6000, 0]);

    // The academic year's window, and the school's default basis (received, then verified).
    const year = await statementOf(`academicYearId=${w.year.id}`);
    expect(year).toMatchObject({ basis: 'received', from: w.year.startsOn, to: w.year.endsOn });
    expect(year.total.receipts).toBeGreaterThanOrEqual(0);
    const patched = await request(app.getHttpServer())
      .patch(`${API}/school/settings`)
      .set('Cookie', P.cookie)
      .set('Origin', ORIGIN)
      .send({ financialStatementBasis: 'verified' });
    expect([patched.status, (patched.body as { financialStatementBasis: string }).financialStatementBasis]).toEqual([200, 'verified']);
    expect((await statementOf(`from=${from}&to=${to}`)).basis).toBe('verified');
    expect((await db().schoolSettings.findFirstOrThrow({ where: { schoolId } })).financialStatementBasis).toBe('verified');

    // Refusals: no window, two windows, reversed, longer than 366 days, an unknown term or year.
    const refused = async (query: string, field: string, code: string = ErrorCode.INVALID_VALUE) => {
      const res = await get(`/finance-reports/financial-statement?${query}`, P).expect(422);
      expect((res.body as ErrorBody).error.details?.fields).toEqual([
        expect.objectContaining({ path: field, code }),
      ]);
    };
    await refused('', 'from');
    await refused(`from=${from}&to=${to}&academicYearId=${w.year.id}`, 'from');
    await refused(`from=${to}&to=${from}`, 'to');
    await refused(`from=2025-01-01&to=2026-01-03`, 'to');
    await refused(`from=${from}`, 'to');
    await refused('termId=999999999', 'termId', ErrorCode.REFERENCE_NOT_FOUND);
    await refused('academicYearId=999999999', 'academicYearId', ErrorCode.REFERENCE_NOT_FOUND);
    // R338: the key, not the role: the teacher and the office are 403.
    for (const who of [w.teacher, w.office]) {
      await get(`/finance-reports/financial-statement?from=${from}&to=${to}`, who).expect(403);
    }
  });

  it('R336: every finance report CSV holds exactly the JSON rows, injection-safe, audited with its filters; page/limit and cross-site refused', async () => {
    const w = await h.world();
    const P = w.principal;
    const schoolId = w.school.id;
    // A pupil whose name a spreadsheet would read as a formula, charged the world's past month.
    await pupil(w.school, w.section, { startedOn: w.year.startsOn, fullName: '=HYPERLINK("http://x","y")', guardianId: w.g2 });
    await runMonth(app, w.school, w.year, w.past, karachi(`${w.past}-01`));
    await h.pay(w, w.office, { guardianId: w.g1, studentIds: [w.a.studentId], amount: 1000 });
    const from = isoDay(-60);
    const to = isoDay(0);
    const cases: { path: string; report: string; rows: (body: unknown) => Row[]; first: (row: Row) => string }[] = [
      {
        path: '/finance-reports/defaulters?sort=studentName',
        report: 'defaulters',
        rows: (b) => (b as { data: Row[] }).data,
        first: (r) => String(r.studentName),
      },
      {
        path: `/finance-reports/collections?receivedFrom=${from}&receivedTo=${to}&groupBy=method`,
        report: 'collections',
        rows: (b) => (b as { rows: Row[] }).rows,
        first: (r) => String(r.label),
      },
      {
        path: `/finance-reports/outstanding?academicYearId=${w.year.id}&groupBy=feeHead`,
        report: 'outstanding',
        rows: (b) => (b as { rows: Row[] }).rows,
        first: (r) => String(r.label),
      },
      {
        path: `/finance-reports/concessions?academicYearId=${w.year.id}`,
        report: 'concessions',
        rows: (b) => (b as { rows: Row[] }).rows,
        first: (r) => String(r.label),
      },
      {
        path: `/finance-reports/expenses?spentFrom=${from}&spentTo=${to}`,
        report: 'expenses',
        rows: (b) => (b as { rows: Row[] }).rows,
        first: (r) => String(r.label),
      },
      {
        path: `/finance-reports/payroll?from=${monthOf(-60)}&to=${monthOf(0)}`,
        report: 'payroll',
        rows: (b) => [...(b as { rows: Row[] }).rows, { yearMonth: 'Total' }],
        first: (r) => String(r.yearMonth),
      },
      {
        path: `/finance-reports/financial-statement?from=${from}&to=${to}`,
        report: 'financial-statement',
        rows: (b) => [...(b as { months: Row[] }).months, { period: 'Total' }],
        first: (r) => String(r.period),
      },
    ];
    // Each report read by its own principal: the finance-reports bucket is 30 hits a minute and an
    // export costs five (the last test below).
    for (const c of cases) {
      const who = await h.signIn(w.school, 'principal');
      const json = (await get(c.path, who).expect(200)).body as unknown;
      const res = await csvGet(app, `${c.path}&format=csv`, who.cookie);
      expectCsvHeaders(res, c.report);
      const [header, ...records] = parseCsv(res.text);
      const rows = c.rows(json);
      expect(header?.length).toBeGreaterThan(1);
      expect(records).toHaveLength(rows.length);
      expect(records.map((r) => r[0])).toEqual(rows.map((r) => asCell(c.first(r))));
      const audit = await db().auditLog.findFirstOrThrow({
        where: { schoolId, action: 'finance_report.exported' },
        orderBy: { id: 'desc' },
      });
      expect(audit).toMatchObject({ actorUserId: who.user.userId, subjectType: 'report', subjectId: null });
      expect(audit.metadata).toMatchObject({ report: c.report, rowCount: rows.length });
    }

    // Daily cash: its summary lines, the identity's figures among them.
    const cash = (await get(`/finance-reports/daily-cash?date=${to}`, P).expect(200)).body as { cashReceived: number };
    const cashCsv = await csvGet(app, `/finance-reports/daily-cash?date=${to}&format=csv`, P.cookie);
    expectCsvHeaders(cashCsv, 'daily-cash');
    const lines = parseCsv(cashCsv.text);
    expect(lines[0]).toEqual(['Line', 'Amount']);
    expect(lines[1]).toEqual(['Cash received', String(cash.cashReceived)]);

    // Injection: the formula name is written with a leading apostrophe (and quoted: it holds commas).
    const defaulters = await csvGet(app, '/finance-reports/defaulters?format=csv', P.cookie);
    const named = parseCsv(defaulters.text).find((r) => r[0]?.includes('HYPERLINK'));
    expect(named?.[0]).toBe(`'=HYPERLINK("http://x","y")`);
    expect(parseCsv(defaulters.text).every((r) => !/^[=+\-@]/.test(r[0] ?? ''))).toBe(true);
    // The filters audited are the query's, paging and format left out.
    const collectionsAudit = await db().auditLog.findFirstOrThrow({
      where: { schoolId, action: 'finance_report.exported', metadata: { path: ['report'], equals: 'collections' } },
    });
    expect(collectionsAudit.metadata).toMatchObject({ filters: { receivedFrom: from, receivedTo: to, groupBy: 'method' } });

    // page/limit refused with format=csv; a cross-site request refused; no header (the app) allowed.
    const Q = await h.signIn(w.school, 'principal');
    const paged = await csvGet(app, '/finance-reports/defaulters?format=csv&page=1', Q.cookie);
    expect(paged.status).toBe(422);
    expect((paged.body as ErrorBody).error.details?.fields?.[0]?.path).toBe('page');
    expect((await csvGet(app, '/finance-reports/defaulters?format=csv&limit=10', Q.cookie)).status).toBe(422);
    const R = await h.signIn(w.school, 'principal');
    const cross = await csvGet(app, '/finance-reports/defaulters?format=csv', R.cookie, 'cross-site');
    expect([cross.status, (cross.body as ErrorBody).error.code]).toEqual([403, ErrorCode.ORIGIN_REJECTED]);
    expect((await csvGet(app, '/finance-reports/defaulters?format=csv', R.cookie, null)).status).toBe(200);
    // An unknown format is a validation error; without the key the export is 403 and writes nothing.
    expect((await get('/finance-reports/defaulters?format=xlsx', R)).status).toBe(422);
    const before = await db().auditLog.count({ where: { schoolId, action: 'finance_report.exported' } });
    expect((await csvGet(app, '/finance-reports/defaulters?format=csv', w.teacher.cookie)).status).toBe(403);
    expect(await db().auditLog.count({ where: { schoolId, action: 'finance_report.exported' } })).toBe(before);
  });

  it('R336: a CSV export costs five hits in the finance-reports bucket (30 a minute)', async () => {
    const w = await h.world();
    const fresh = await h.signIn(w.school, 'principal');
    for (let i = 0; i < 6; i += 1) {
      expect((await csvGet(app, '/finance-reports/defaulters?format=csv', fresh.cookie)).status).toBe(200);
    }
    // 6 × 5 = 30: the bucket is spent; the next request, JSON or CSV, is 429.
    const next = await get('/finance-reports/defaulters', fresh);
    expect(next.status).toBe(429);
    expect(next.headers['retry-after']).toBeDefined();
    // Another user's bucket is untouched.
    await get('/finance-reports/defaulters', w.principal).expect(200);
  });
});
