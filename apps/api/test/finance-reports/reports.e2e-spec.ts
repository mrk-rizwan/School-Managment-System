// Slice 22 over HTTP (phase-3-financial.md slice 22, contracts/slice-22.md): the defaulters list
// (R203), collections on either date (R205) with refunds, voids and carry-forwards as their own
// lines (§0.20), outstanding, daily cash with its identity, concessions, expenses with the
// sub-threshold totals (R208), payroll, the ranges, and who may read them (R234). The real
// AppModule and database; the year runs around today.
import { NestExpressApplication } from '@nestjs/platform-express';
import { newIdempotencyKey } from '@asms/shared';
import { createTestApp } from '../core/app';
import { closeTestDb } from '../support/schools';
import { createAcademicYear, createClass, createSection, enrol, isoDay } from '../support/students';
import { db, karachi, runMonth } from '../fees/charges-support';
import { monthOf, reportsHttp, type ReportsWorld } from './support';

interface Defaulter {
  studentId: string;
  studentName: string;
  className: string | null;
  outstanding: number;
  overdue: number;
  oldestDueOn: string;
  openCharges: number;
  feePayer: { name: string; contactCapability: string } | null;
  lastPaymentOn: string | null;
  lastReminderAt: string | null;
  pendingClaim: boolean;
}
interface Row {
  key: string;
  label: string;
  amount: number;
  count: number;
}
interface Collections {
  basis: string;
  rows: Row[];
  total: number;
  count: number;
  refunds: { amount: number; count: number };
  refundReversals: { amount: number; count: number };
  net: number;
  voided: { amount: number; count: number };
  carriedForward: { amount: number; count: number };
}

describe('slice 22: finance reports over HTTP (e2e)', () => {
  let app: NestExpressApplication;
  const h = reportsHttp(() => app);
  const { get, post, err } = h;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const today = isoDay(0);
  const window = (w: ReportsWorld, groupBy: string, basis?: string, from = isoDay(-60), to = today) =>
    get(
      `/finance-reports/collections?receivedFrom=${from}&receivedTo=${to}&groupBy=${groupBy}${basis === undefined ? '' : `&basis=${basis}`}`,
      w.principal,
    );

  // ----------------------------------------------------------------------------- defaulters

  it('R203: defaulters from the open charges, filters, sorts, the fee payer, last payment, reminder and claim', async () => {
    const w = await h.world();
    const page = async (query = '') =>
      (await get(`/finance-reports/defaulters${query}`, w.principal).expect(200)).body as { data: Defaulter[]; total: number };

    let list = await page();
    expect(list.total).toBe(3);
    expect(list.data.map((d) => [d.studentName, d.outstanding, d.overdue, d.openCharges])).toEqual([
      ['Hamza Tariq', 3000, 3000, 1],
      ['Hira Tariq', 3000, 3000, 1],
      ['Zainab Khan', 3000, 3000, 1],
    ]);
    expect(list.data[0]?.oldestDueOn).toBe(`${w.past}-10`);
    expect(list.data[0]?.feePayer).toEqual({ name: 'Tariq Mehmood', contactCapability: 'keypad' });
    expect(list.data[0]?.className).not.toBeNull();

    // A part payment for Hamza, an upcoming charge for Zainab: outstanding moves, overdue only for the past.
    await h.pay(w, w.office, { guardianId: w.g1, studentIds: [w.a.studentId], amount: 1000 });
    await h.manualCharge(w, w.c, 2500, isoDay(5));
    list = await page();
    expect(list.data.map((d) => [d.studentName, d.outstanding, d.overdue, d.openCharges])).toEqual([
      ['Zainab Khan', 5500, 3000, 2],
      ['Hira Tariq', 3000, 3000, 1],
      ['Hamza Tariq', 2000, 2000, 1],
    ]);
    const hamza = list.data.find((d) => d.studentName === 'Hamza Tariq');
    expect(hamza?.lastPaymentOn).toBe(today);
    expect(hamza?.lastReminderAt).toBeNull();

    expect((await page('?sort=studentName')).data.map((d) => d.studentName)).toEqual(['Hamza Tariq', 'Hira Tariq', 'Zainab Khan']);
    expect((await page('?minOutstanding=3000')).total).toBe(2);
    expect((await page('?minOutstanding=3000&limit=1&page=2')).data.map((d) => d.studentName)).toEqual(['Hira Tariq']);
    expect((await page('?classId=999999')).total).toBe(0);
    expect((await page(`?classId=${w.classId}&overdueOnly=true`)).total).toBe(3);

    // The reminder and a pending claim show on the row.
    await h.reminders(w);
    await db().studentGuardian.updateMany({ where: { schoolId: w.school.id, studentId: w.c.studentId }, data: { canLogin: true } });
    await db().paymentClaim.create({
      data: {
        schoolId: w.school.id,
        studentId: w.c.studentId,
        guardianId: w.g2,
        method: 'bank_transfer',
        claimedAmount: 1000,
        paidOn: new Date(`${today}T00:00:00.000Z`),
        reference: 'TRX-1001',
      },
    });
    list = await page('?sort=-outstanding');
    expect(list.data.find((d) => d.studentName === 'Hira Tariq')?.lastReminderAt).not.toBeNull();
    expect(list.data.find((d) => d.studentName === 'Zainab Khan')?.pendingClaim).toBe(true);

    // 422 on a bad filter or sort.
    expect(err(await get('/finance-reports/defaulters?minOutstanding=1e3', w.principal).expect(422)).error.code).toBe('VALIDATION_FAILED');
    await get('/finance-reports/defaulters?sort=outstanding', w.principal).expect(422);
  });

  // ---------------------------------------------------------------------------- collections

  it('R205, §0.20: collections by basis and grouping; voids, refunds, refund reversals and carry-forwards apart', async () => {
    const w = await h.world();
    // A deposit slip the office records weeks after the parent paid: received then, verified now.
    await h.pay(w, w.office, {
      guardianId: w.g2,
      studentIds: [w.c.studentId],
      amount: 3000,
      method: 'bank_transfer',
      reference: 'SLIP-77',
      receivedOn: isoDay(-40),
    });
    const family = await h.pay(w, w.office, { guardianId: w.g1, studentIds: [w.a.studentId, w.b.studentId], amount: 8000, advanceForStudentId: w.a.studentId });
    const mistake = await h.pay(w, w.office, { guardianId: w.g1, studentIds: [w.a.studentId], amount: 500, advanceForStudentId: w.a.studentId });
    await post(`/payments/${mistake.id}/void`, { reason: 'Typed twice' }, w.principal).expect(200);
    const refund = await post(
      `/payments/${family.id}/refund`,
      { amount: 1000, reason: 'Returned part of the advance', method: 'cash' },
      w.principal,
      newIdempotencyKey(),
    ).expect(201);
    await post(`/payments/${family.id}/reverse-refund`, { reversalId: (refund.body as { id: string }).id, reason: 'Parent kept it as advance' }, w.principal, newIdempotencyKey()).expect(201);
    // Carry 500 of the advance to the next year, where Hamza is enrolled.
    const next = await createAcademicYear(db(), w.school, { startsOn: isoDay(161), endsOn: isoDay(500) });
    const nextClass = await createClass(db(), w.school, next);
    await enrol(db(), w.school, { id: w.a.studentId }, await createSection(db(), w.school, nextClass), {
      startedOn: isoDay(161),
      status: 'left',
      endedOn: isoDay(170),
    });
    await post(`/payments/${family.id}/carry-forward`, { academicYearId: next.id.toString(), amount: 500, reason: 'Into next year' }, w.office, newIdempotencyKey()).expect(201);

    const verified = (await window(w, 'method').expect(200)).body as Collections;
    expect(verified.basis).toBe('verified');
    expect([verified.total, verified.count]).toEqual([11000, 2]);
    expect(verified.rows).toEqual([
      { key: 'cash', label: 'cash', amount: 8000, count: 1 },
      { key: 'bank_transfer', label: 'bank_transfer', amount: 3000, count: 1 },
    ]);
    expect(verified.voided).toEqual({ amount: 500, count: 1 });
    expect(verified.refunds).toEqual({ amount: 1000, count: 1 });
    expect(verified.refundReversals).toEqual({ amount: 1000, count: 1 });
    expect(verified.net).toBe(11000);
    expect(verified.carriedForward).toEqual({ amount: 500, count: 1 });

    // The same window on the received date: the slip falls 40 days back; a window of the last
    // week has only the counter's cash.
    const lastWeek = (await window(w, 'day', 'received', isoDay(-7)).expect(200)).body as Collections;
    expect([lastWeek.total, lastWeek.rows]).toEqual([8000, [{ key: today, label: today, amount: 8000, count: 1 }]]);
    const verifiedLastWeek = (await window(w, 'day', 'verified', isoDay(-7)).expect(200)).body as Collections;
    expect(verifiedLastWeek.total).toBe(11000);

    const byHead = (await window(w, 'feeHead').expect(200)).body as Collections;
    expect(byHead.rows.reduce((s, r) => s + r.amount, 0)).toBe(11000);
    expect(byHead.rows.find((r) => r.key === 'Advance')?.amount).toBe(2000);
    const byClass = (await window(w, 'class').expect(200)).body as Collections;
    expect(byClass.rows).toEqual([{ key: w.classId.toString(), label: expect.any(String) as string, amount: 11000, count: 2 }]);
    const byCollector = (await window(w, 'collector').expect(200)).body as Collections;
    expect(byCollector.rows).toEqual([{ key: w.office.user.userId.toString(), label: expect.any(String) as string, amount: 11000, count: 2 }]);

    // Ranges: at most 92 days, and in order.
    expect(err(await window(w, 'day', undefined, isoDay(-93)).expect(422)).error.details?.fields?.[0]?.path).toBe('receivedTo');
    await window(w, 'day', undefined, today, isoDay(-1)).expect(422);
    await get(`/finance-reports/collections?receivedFrom=${today}&receivedTo=${today}&groupBy=week`, w.principal).expect(422);
  });

  // ---------------------------------------------------------------------------- outstanding

  it('outstanding today by class, head and period, with the credits as their own line', async () => {
    const w = await h.world();
    await h.pay(w, w.office, { guardianId: w.g1, studentIds: [w.a.studentId], amount: 1000 });
    const [hira] = await db().charge.findMany({ where: { schoolId: w.school.id, studentId: w.b.studentId } });
    await post(`/charges/${hira?.id}/adjust`, { amount: 500, reason: 'Goodwill' }, w.principal, newIdempotencyKey()).expect(201);
    const read = async (groupBy: string) =>
      (await get(`/finance-reports/outstanding?academicYearId=${w.year.id}&groupBy=${groupBy}`, w.principal).expect(200)).body as {
        asOf: string;
        rows: Row[];
        total: number;
        adjustments: { amount: number; count: number };
      };
    const byClass = await read('class');
    expect([byClass.asOf, byClass.total, byClass.adjustments]).toEqual([today, 7500, { amount: 500, count: 1 }]);
    expect(byClass.rows).toEqual([{ key: w.classId.toString(), label: expect.any(String) as string, amount: 7500, count: 3 }]);
    expect((await read('period')).rows).toEqual([{ key: w.past, label: w.past, amount: 7500, count: 3 }]);
    expect((await read('feeHead')).rows.map((r) => [r.key, r.amount])).toEqual([[w.heads.tuition.toString(), 7500]]);
    await get('/finance-reports/outstanding?academicYearId=999999', w.principal).expect(422);
  });

  // ----------------------------------------------------------------------------- daily cash

  it('§0.20: the daily cash identity — received − voided before handover = with collectors + handed over', async () => {
    const w = await h.world();
    const second = await h.signIn(w.school, 'office_staff');
    await h.pay(w, w.office, { guardianId: w.g1, studentIds: [w.a.studentId], amount: 3000 });
    const typo = await h.pay(w, w.office, { guardianId: w.g2, studentIds: [w.c.studentId], amount: 2000 });
    await post(`/payments/${typo.id}/void`, { reason: 'Wrong amount' }, w.principal).expect(200);
    await h.pay(w, second, { guardianId: w.g1, studentIds: [w.b.studentId], amount: 1500 });
    // The first clerk hands over; the principal counts 200 short and writes it off.
    const handover = (await post('/me/staff/cash-handovers', {}, w.office).expect(201)).body as { id: string; expectedAmount: number };
    expect(handover.expectedAmount).toBe(3000);
    await post(`/cash-handovers/${handover.id}/confirm`, { countedAmount: 2800 }, w.principal).expect(200);
    await post(`/cash-handovers/${handover.id}/resolve-shortfall`, { resolution: 'written_off', reason: 'Could not trace it' }, w.principal).expect(200);

    const cash = (await get(`/finance-reports/daily-cash?date=${today}`, w.principal).expect(200)).body as {
      cashReceived: number;
      voidedBeforeHandover: number;
      withCollectors: { collectorUserId: string; amount: number }[];
      handedOver: { expected: number; counted: number; shortfall: number; surplus: number; fromDay: number; shortfallResolution: string }[];
      voidedAfterHandover: number;
      cashExpenses: number;
      shortfallWrittenOff: number;
      refundsPaidCash: number;
      salariesPaidCash: number;
    };
    expect([cash.cashReceived, cash.voidedBeforeHandover, cash.voidedAfterHandover]).toEqual([6500, 2000, 0]);
    expect(cash.withCollectors.map((c) => [c.collectorUserId, c.amount])).toEqual([[second.user.userId.toString(), 1500]]);
    expect(cash.handedOver).toEqual([
      expect.objectContaining({ expected: 3000, counted: 2800, shortfall: 200, surplus: 0, fromDay: 3000, shortfallResolution: 'written_off' }),
    ]);
    const held = cash.withCollectors.reduce((s, c) => s + c.amount, 0) + cash.handedOver.reduce((s, x) => s + x.fromDay, 0);
    expect(cash.cashReceived - cash.voidedBeforeHandover).toBe(held);
    for (const x of cash.handedOver) expect(x.counted - x.expected).toBe(x.surplus - x.shortfall);
    // A written-off shortfall is a cash expense of the day (slice 20 §8).
    expect([cash.cashExpenses, cash.shortfallWrittenOff, cash.refundsPaidCash, cash.salariesPaidCash]).toEqual([200, 200, 0, 0]);
  });

  // ---------------------------------------------------------------- concessions, expenses, payroll

  it('concessions by head and class: the reductions at birth and the credits a concession wrote', async () => {
    const w = await h.world();
    const request = await post(
      '/concessions',
      { studentId: w.a.studentId.toString(), academicYearId: w.year.id.toString(), kind: 'percentage', value: 10, feeHeadIds: [w.heads.tuition.toString()], effectiveFrom: w.past, reason: 'Staff child' },
      w.office,
      newIdempotencyKey(),
    ).expect(201);
    await post(`/concessions/${(request.body as { id: string }).id}/approve`, { applyToOpenCharges: true }, w.principal).expect(200);
    const next = monthOf(-15);
    if (next !== w.past) await runMonth(app, w.school, w.year, next, karachi(`${next}-01`));
    const byHead = (await get(`/finance-reports/concessions?academicYearId=${w.year.id}`, w.principal).expect(200)).body as {
      rows: { key: string; students: number; reduction: number }[];
      total: number;
    };
    const expected = next !== w.past ? 600 : 300;
    expect(byHead.rows).toEqual([{ key: w.heads.tuition.toString(), label: expect.any(String) as string, students: 1, reduction: expected }]);
    expect(byHead.total).toBe(expected);
    const byClass = (await get(`/finance-reports/concessions?academicYearId=${w.year.id}&groupBy=class`, w.principal).expect(200)).body as {
      rows: { key: string; reduction: number }[];
    };
    expect(byClass.rows.map((r) => [r.key, r.reduction])).toEqual([[w.classId.toString(), expected]]);
  });

  it('R208: expenses recorded and approved, pending apart, sub-threshold totals per recorder', async () => {
    const w = await h.world();
    const record = (by: typeof w.office, amount: number, category = 'stationery') =>
      post('/expenses', { category, amount, spentOn: today, description: 'Chalk and registers', method: 'cash' }, by, newIdempotencyKey()).expect(201);
    await record(w.office, 1200);
    await record(w.office, 800, 'water');
    await record(w.office, 9000); // above the threshold: pending approval
    await record(w.principal, 7000, 'repairs'); // a principal's own: approved on record
    const report = (await get(`/finance-reports/expenses?spentFrom=${isoDay(-1)}&spentTo=${today}`, w.principal).expect(200)).body as {
      rows: Row[];
      total: number;
      pendingApproval: { amount: number; count: number };
      subThresholdByRecorder: { recorderUserId: string; amount: number; count: number }[];
    };
    expect(report.rows.map((r) => [r.key, r.amount, r.count])).toEqual([
      ['repairs', 7000, 1],
      ['stationery', 1200, 1],
      ['water', 800, 1],
    ]);
    expect([report.total, report.pendingApproval]).toEqual([9000, { amount: 9000, count: 1 }]);
    expect(report.subThresholdByRecorder.map((r) => [r.recorderUserId, r.amount, r.count])).toEqual([[w.office.user.userId.toString(), 2000, 2]]);
    const byRecorder = (await get(`/finance-reports/expenses?spentFrom=${today}&spentTo=${today}&groupBy=recorder`, w.principal).expect(200)).body as { rows: Row[] };
    expect(byRecorder.rows.map((r) => [r.key, r.amount])).toEqual([
      [w.principal.user.userId.toString(), 7000],
      [w.office.user.userId.toString(), 2000],
    ]);
    await get(`/finance-reports/expenses?spentFrom=${isoDay(-93)}&spentTo=${today}`, w.principal).expect(422);
  });

  it('payroll: finalised runs only, gross − deductions + adjustments = net, paid and unpaid', async () => {
    const w = await h.world();
    const month = monthOf(-35);
    await post(
      `/staff/${w.office.user.staffId}/salary-structure`,
      { basic: 30000, components: [{ kind: 'allowance', name: 'Transport', amount: 2000 }, { kind: 'deduction', name: 'Provident fund', amount: 1500 }], effectiveFrom: `${monthOf(-90)}-01`, reason: 'Appointment' },
      w.principal,
      newIdempotencyKey(),
    ).expect(201);
    const run = (await post('/payroll-runs', { yearMonth: month }, w.principal).expect(201)).body as { id: string };
    const read = async () =>
      (await get(`/finance-reports/payroll?from=${monthOf(-120)}&to=${monthOf(0)}`, w.principal).expect(200)).body as {
        rows: { yearMonth: string; staffCount: number; gross: number; deductions: number; adjustments: number; net: number; paid: number; unpaid: number }[];
        total: { net: number };
      };
    expect((await read()).rows).toEqual([]); // a draft is not in the report
    await post(`/payroll-runs/${run.id}/finalise`, {}, w.principal).expect(200);
    const report = await read();
    expect(report.rows).toHaveLength(1);
    const [row] = report.rows;
    expect(row?.yearMonth).toBe(month);
    expect(row?.staffCount).toBeGreaterThanOrEqual(1);
    expect(row!.gross - row!.deductions + row!.adjustments).toBe(row!.net);
    expect([row!.paid + row!.unpaid, report.total.net]).toEqual([row!.net, row!.net]);
    await get(`/finance-reports/payroll?from=${monthOf(-800)}&to=${monthOf(0)}`, w.principal).expect(422);
    await get(`/finance-reports/payroll?from=${monthOf(0)}&to=${monthOf(-40)}`, w.principal).expect(422);
  });

  // ----------------------------------------------------------------------------------- access

  it('R234: the reports need finance.report.view; office and teacher are refused, the principal reads', async () => {
    const w = await h.world();
    for (const path of [
      '/finance-reports/defaulters',
      `/finance-reports/collections?receivedFrom=${today}&receivedTo=${today}&groupBy=day`,
      `/finance-reports/outstanding?academicYearId=${w.year.id}`,
      `/finance-reports/daily-cash?date=${today}`,
      `/finance-reports/concessions?academicYearId=${w.year.id}`,
      `/finance-reports/expenses?spentFrom=${today}&spentTo=${today}`,
      `/finance-reports/payroll?from=${monthOf(-1)}&to=${monthOf(0)}`,
    ]) {
      await get(path, w.teacher).expect(403);
      await get(path, w.office).expect(403);
      await get(path, w.principal).expect(200);
    }
    // A grant of the key opens them to the office.
    await h.grant(w.office.user, w.principal.user, 'finance.report.view');
    await get('/finance-reports/defaulters', w.office).expect(200);
  });
});
