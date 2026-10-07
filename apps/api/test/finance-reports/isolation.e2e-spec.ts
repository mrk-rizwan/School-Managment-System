// Control 4 / R62 for slice 22's one RAW_SQL_FILES entry (finance-report.repository.ts): school A
// with payments, a void, a refund, a handover, an expense, a credit, a concession, a pending claim,
// an override and reminders; school B with a family of its own and no money moved. Every statement
// run as school B, with school A's ids where it takes ids, returns only school B's rows.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { newIdempotencyKey } from '@asms/shared';
import { FinanceReportRepository, type CollectionWindow } from '../../src/repositories/finance-report.repository';
import { createTestApp } from '../core/app';
import { asSchool, tx } from '../messaging/support';
import { closeTestDb } from '../support/schools';
import { isoDay } from '../support/students';
import { db } from '../fees/charges-support';
import { reportsHttp } from './support';

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

describe('slice 22 tenant isolation (finance-report.repository.ts)', () => {
  let app: NestExpressApplication;
  const h = reportsHttp(() => app);
  let reports: FinanceReportRepository;

  beforeAll(async () => {
    app = await createTestApp();
    reports = app.get(FinanceReportRepository, { strict: false });
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('every report, reminder and clearance read sees only its own school', async () => {
    const a = await h.world();
    const b = await h.world({ name: 'Other School' });
    const A = a.school.id;
    const B = b.school.id;
    // School A moves money every way the reports read.
    const paid = await h.pay(a, a.office, { guardianId: a.g1, studentIds: [a.a.studentId], amount: 5000 });
    const typo = await h.pay(a, a.office, { guardianId: a.g2, studentIds: [a.c.studentId], amount: 100 });
    await h.post(`/payments/${typo.id}/void`, { reason: 'Typed wrong' }, a.principal).expect(200);
    await h.post(`/payments/${paid.id}/refund`, { amount: 500, reason: 'Overpaid', method: 'cash' }, a.principal, newIdempotencyKey()).expect(201);
    await h.post('/me/staff/cash-handovers', {}, a.office).expect(201);
    await h.post('/expenses', { category: 'water', amount: 300, spentOn: isoDay(0), description: 'Water bottles', method: 'cash' }, a.office, newIdempotencyKey()).expect(201);
    const [hira] = await db().charge.findMany({ where: { schoolId: A, studentId: a.b.studentId } });
    await h.post(`/charges/${hira?.id}/adjust`, { amount: 200, reason: 'Goodwill' }, a.principal, newIdempotencyKey()).expect(201);
    await h.post(`/students/${a.b.studentId}/dues-clearance/override`, { reason: 'Leaving' }, a.principal).expect(200);
    await h.reminders(a);

    const run = <T>(schoolId: typeof A, fn: () => Promise<T>) => asSchool(app, schoolId, () => tx.run(fn));
    const window = (): CollectionWindow => ({
      basis: 'received',
      from: day(isoDay(-30)),
      to: day(isoDay(0)),
      startsAt: new Date(Date.now() - 30 * 86_400_000),
      endsBefore: new Date(Date.now() + 86_400_000),
      timezone: 'Asia/Karachi',
    });
    const today = day(isoDay(0));

    // Defaulters and their extras: only B's three students, untouched by A's payments.
    const mine = await run(B, () => reports.defaulters(B, { today, overdueOnly: false, sort: '-outstanding', skip: 0, take: 50 }));
    expect(mine.rows.map((r) => r.studentId).sort()).toEqual([b.a.studentId, b.b.studentId, b.c.studentId].sort());
    expect(mine.rows.every((r) => r.outstanding === 3000)).toBe(true);
    expect(await run(B, () => reports.defaulterExtras(B, [a.a.studentId, a.c.studentId]))).toEqual([]);

    // Collections, outstanding, concessions, expenses, payroll and daily cash: nothing of A's.
    for (const group of ['day', 'method', 'feeHead', 'class', 'collector'] as const) {
      expect(await run(B, () => reports.collections(B, window(), group))).toEqual([]);
      expect((await run(A, () => reports.collections(A, window(), group))).length).toBeGreaterThan(0);
    }
    expect(await run(B, () => reports.collectionTotals(B, window()))).toEqual({
      total: { amount: 0, count: 0 },
      voided: { amount: 0, count: 0 },
      refunds: { amount: 0, count: 0 },
      refundReversals: { amount: 0, count: 0 },
      carriedForward: { amount: 0, count: 0 },
      carryForwardReversals: { amount: 0, count: 0 },
    });
    for (const group of ['class', 'feeHead', 'period'] as const) {
      expect(await run(B, () => reports.outstanding(B, a.year.id, group))).toEqual([]);
    }
    expect(await run(B, () => reports.adjustmentsTotal(B, a.year.id))).toEqual({ amount: 0, count: 0 });
    for (const group of ['feeHead', 'class'] as const) expect(await run(B, () => reports.concessions(B, a.year.id, group))).toEqual([]);
    for (const group of ['category', 'day', 'method', 'recorder'] as const) {
      expect(await run(B, () => reports.expenses(B, day(isoDay(-1)), today, group))).toEqual([]);
    }
    expect(await run(B, () => reports.expenseSides(B, day(isoDay(-1)), today))).toEqual({ pending: { amount: 0, count: 0 }, subThreshold: [] });
    expect(await run(B, () => reports.payroll(B, '2000-01', '2999-12'))).toEqual([]);
    expect(await run(B, () => reports.dailyCash(B, today, new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000)))).toEqual({
      cashReceived: 0,
      voidedBeforeHandover: 0,
      voidedAfterHandover: 0,
      withCollectors: [],
      handedOver: [],
      refundsPaidCash: 0,
      cashExpenses: 0,
      shortfallWrittenOff: 0,
      salariesPaidCash: 0,
    });
    expect((await run(A, () => reports.dailyCash(A, today, new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000)))).cashReceived).toBe(5100);

    // The clearance's reads with A's student.
    expect(await run(B, () => reports.studentDues(B, a.a.studentId))).toEqual({ outstanding: 0, newestOpenAt: null });
    expect(await run(B, () => reports.studentAdvance(B, a.a.studentId))).toBe(0);
    expect(await run(A, () => reports.studentAdvance(A, a.a.studentId))).toBe(1500);
    expect(await run(B, () => reports.latestOverride(B, a.b.studentId))).toBeNull();
    expect(await run(A, () => reports.latestOverride(A, a.b.studentId))).not.toBeNull();

    // The reminders' reads: B's families only; A's guardians, students, class and subjects reach nothing.
    const links = await run(B, () => reports.reminderLinks(B, today));
    expect(new Set(links.map((l) => l.guardianId))).toEqual(new Set([b.g1, b.g2]));
    expect(await run(B, () => reports.reminderLinks(B, today, [a.g1, a.g2]))).toEqual([]);
    expect(await run(B, () => reports.feePayerGuardians(B, [a.a.studentId, a.c.studentId]))).toEqual([]);
    expect(await run(B, () => reports.studentsIn(B, { classId: a.classId }))).toEqual([]);
    expect(await run(B, () => reports.targetsExist(B, { sectionId: a.section.id }))).toBe(false);
    expect(await run(B, () => reports.targetsExist(B, { studentIds: [a.a.studentId] }))).toBe(false);
    const subjects = (await db().message.findMany({ where: { schoolId: A, subjectType: 'fee_reminder' }, select: { subjectId: true } })).map((m) => m.subjectId);
    expect(subjects.length).toBeGreaterThan(0);
    expect(await run(B, () => reports.reminderMessages(B, subjects))).toEqual([]);
    // The reminder budget's queued SMS: A's receipts and reminders wait on SMS; B has written none.
    expect((await run(A, () => reports.pendingSmsMessages(A))).length).toBeGreaterThan(0);
    expect(await run(B, () => reports.pendingSmsMessages(B))).toEqual([]);
  });
});
