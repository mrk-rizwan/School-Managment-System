// R328: the Phase 3 identities (phase-3-financial.md §0.20, R228) hold in a year that gains a
// route. A mirror of test/finance-reports/reconciliation.e2e-spec.ts's world (a priced year around
// today, two families, the past month generated), plus a route at 1,200 a month ridden by all three
// children, three generated months, a 50 % concession on the Transport head approved onto the open
// charges, sibling and single payments, a void and an assignment ended today. Written directly, each
// for the reason given where it is written: the route's amount and the assignments from the year's
// first day (the API takes neither for a past month). Every verb else goes through the API.
import { NestExpressApplication } from '@nestjs/platform-express';
import { newIdempotencyKey } from '@asms/shared';
import { createTestApp } from '../core/app';
import { closeTestDb } from '../support/schools';
import { day, isoDay } from '../support/students';
import { db, karachi, runMonth } from '../fees/charges-support';
import { reportsHttp, shiftMonth } from '../finance-reports/support';

describe('R328: the §0.20 identities with a route in the year (e2e)', () => {
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

  it('outstanding, statements, defaulters, payments and concessions reconcile with transport charges', async () => {
    const w = await h.world();
    const schoolId = w.school.id;
    const P = w.principal;
    const O = w.office;
    const transport = (await db().feeHead.findFirstOrThrow({ where: { schoolId, category: 'transport' } })).id;

    const route = (await post('/transport-routes', { name: 'Johar Town', stops: [{ sortOrder: 1, name: 'Canal Road' }] }, O, newIdempotencyKey()).expect(201)).body as {
      id: string;
      stops: { id: string }[];
    };
    const routeId = BigInt(route.id);
    // The route's price from the year's first month: the API sets a new amount from this month on.
    await db().transportRouteAmount.create({
      data: { schoolId, routeId, effectivePeriod: w.year.startsOn.slice(0, 7), amount: 1200, createdBy: O.user.userId },
    });
    // The children ride from the year's first day: the API starts an assignment this month at the earliest.
    const rides = new Map<bigint, bigint>();
    for (const p of [w.a, w.b, w.c]) {
      const row = await db().transportAssignment.create({
        data: {
          schoolId,
          studentId: p.studentId,
          academicYearId: w.year.id,
          enrolmentId: p.enrolmentId,
          routeId,
          stopId: BigInt(route.stops[0]?.id ?? '0'),
          startsOn: day(w.year.startsOn),
          createdBy: O.user.userId,
        },
      });
      rides.set(p.studentId, row.id);
    }
    const m1 = shiftMonth(w.past, -2);
    const m2 = shiftMonth(w.past, -1);
    for (const month of [m1, m2, w.past]) await runMonth(app, w.school, w.year, month, karachi(`${month}-02`));
    const transportRows = await db().charge.findMany({ where: { schoolId, feeHeadId: transport }, orderBy: [{ period: 'asc' }, { studentId: 'asc' }] });
    expect(transportRows.map((c) => [c.period, c.amount])).toEqual([
      [m1, 1200],
      [m1, 1200],
      [m1, 1200],
      [m2, 1200],
      [m2, 1200],
      [m2, 1200],
      [w.past, 1200],
      [w.past, 1200],
      [w.past, 1200],
    ]);

    // A sibling bus rate: 50 % off C's Transport, approved onto the open charges (credits).
    const concession = await post(
      '/concessions',
      {
        studentId: w.c.studentId.toString(),
        academicYearId: w.year.id.toString(),
        kind: 'percentage',
        value: 50,
        feeHeadIds: [transport.toString()],
        effectiveFrom: m1,
        reason: 'Sibling bus rate',
      },
      O,
      newIdempotencyKey(),
    ).expect(201);
    await post(`/concessions/${(concession.body as { id: string }).id}/approve`, { applyToOpenCharges: true }, P).expect(200);

    // Payments: the keypad family's two children together, C's in part, one recorded twice and voided.
    await h.pay(w, O, { guardianId: w.g1, studentIds: [w.a.studentId, w.b.studentId], amount: 9000 });
    await h.pay(w, O, { guardianId: w.g2, studentIds: [w.c.studentId], amount: 2500 });
    const twice = await h.pay(w, O, { guardianId: w.g2, studentIds: [w.c.studentId], amount: 2500 });
    await post(`/payments/${twice.id}/void`, { reason: 'Recorded twice' }, P).expect(200);
    // B stops riding today.
    await post(`/transport-assignments/${rides.get(w.b.studentId)}/end`, { endedOn: isoDay(0), reason: 'Walks to school now' }, O).expect(200);

    // 1. Every non-voided payment: Σ live allocations + unallocated = amount.
    for (const p of await db().payment.findMany({ where: { schoolId, status: 'verified' } })) {
      const live = await db().paymentAllocation.aggregate({ where: { schoolId, paymentId: p.id, reversedAt: null }, _sum: { amount: true } });
      expect((live._sum.amount ?? 0) + p.unallocatedAmount).toBe(p.amount);
    }

    // 2. Every charge: counters bounded; a live one open exactly while something is owed.
    const charges = await db().charge.findMany({ where: { schoolId } });
    for (const c of charges.filter((x) => x.kind !== 'adjustment')) {
      const owed = c.amount - c.allocatedAmount - c.creditedAmount;
      expect(owed).toBeGreaterThanOrEqual(0);
      if (c.status === 'open' || c.status === 'settled') expect(c.status === 'open').toBe(owed > 0);
    }

    // 3. Outstanding = Σ owed over open charges, in the report, each statement and the defaulters.
    const open = charges.filter((c) => c.status === 'open' && c.academicYearId === w.year.id);
    const owedTotal = open.reduce((s, c) => s + c.amount - c.allocatedAmount - c.creditedAmount, 0);
    expect(owedTotal).toBeGreaterThan(0);
    const outstanding = (await get(`/finance-reports/outstanding?academicYearId=${w.year.id}`, P).expect(200)).body as { total: number };
    expect(outstanding.total).toBe(owedTotal);
    let statements = 0;
    for (const p of [w.a, w.b, w.c]) {
      const s = (await get(`/students/${p.studentId}/fee-statement?academicYearId=${w.year.id}`, P).expect(200)).body as {
        totals: { charged: number; concession: number; adjustments: number; paid: number; outstanding: number };
      };
      expect(s.totals.charged - s.totals.concession - s.totals.adjustments - s.totals.paid).toBe(s.totals.outstanding);
      statements += s.totals.outstanding;
    }
    expect(statements).toBe(owedTotal);
    const defaulters = (await get('/finance-reports/defaulters?limit=50', P).expect(200)).body as { data: { outstanding: number }[] };
    expect(defaulters.data.reduce((s, r) => s + r.outstanding, 0)).toBe(owedTotal);

    // 6. Concessions: the report = Σ concession_amount on live charges + live adjustments naming a
    //    concession — here C's three Transport credits of 600.
    const report = (await get(`/finance-reports/concessions?academicYearId=${w.year.id}`, P).expect(200)).body as { total: number };
    const yearCharges = await db().charge.findMany({ where: { schoolId, academicYearId: w.year.id, status: { not: 'voided' } } });
    const conceded =
      yearCharges.filter((c) => c.kind !== 'adjustment').reduce((s, c) => s + c.concessionAmount, 0) +
      yearCharges.filter((c) => c.kind === 'adjustment' && c.concessionId !== null).reduce((s, c) => s + c.amount, 0);
    expect([report.total, conceded]).toEqual([1800, 1800]);

    // The ended ride: charged in full for its last month, nothing after.
    const ended = await db().transportAssignment.findFirstOrThrow({ where: { schoolId, id: rides.get(w.b.studentId) ?? 0n } });
    expect(ended.endsOn?.toISOString().slice(0, 10)).toBe(isoDay(0));
  });
});
