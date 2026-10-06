// Slice 20 under concurrency (phase-3-financial.md §3.2, R188, R190, R236): interleaved counter
// payments, voids, credits, a handover, a carry-forward and a month's generation over one family
// never deadlock (R236's lock order: the payments, then their charges by id, the receipt counter
// last), observed through Postgres's own deadlock count and the payment services' retry counter;
// racing payments never over-allocate; receipt numbers stay gapless. The counter's time budget is
// measured in counter-perf.e2e-spec.ts; its scenario is checked here.
import { setTimeout as sleep } from 'node:timers/promises';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ErrorCode, newIdempotencyKey, receiptCounterName } from '@asms/shared';
import { onceMoreRetries } from '../../src/modules/payments/payments.shared';
import { createTestApp } from '../core/app';
import { closeTestDb } from '../support/schools';
import { createAcademicYear, enrol, isoDay } from '../support/students';
import { classWithSection, db, karachi, pupil, runMonth } from '../fees/charges-support';
import { paymentsHttp, type Payment, type World } from './payments-support';

/** Postgres's count of deadlocks detected in this database (flushed, then read fresh). */
async function deadlocks(): Promise<bigint> {
  await sleep(1200); // backends flush their counters to the shared statistics at most once a second
  await db().$executeRaw`SELECT pg_stat_clear_snapshot()`;
  const [row] = await db().$queryRaw<{ deadlocks: bigint }[]>`
    SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`;
  return row?.deadlocks ?? 0n;
}

describe('slice 20: payments under concurrency (e2e)', () => {
  let app: NestExpressApplication;
  const h = paymentsHttp(() => app);
  const { post, err, pay } = h;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const record = (w: World, studentIds: bigint[], amount: number, advanceFor?: bigint) =>
    post(
      '/payments',
      {
        academicYearId: w.year.id.toString(),
        payerGuardianId: w.guardianId.toString(),
        studentIds: studentIds.map(String),
        amount,
        method: 'cash',
        receivedOn: isoDay(0),
        ...(advanceFor === undefined ? {} : { advanceForStudentId: advanceFor.toString() }),
      },
      w.office,
      newIdempotencyKey(),
    );

  /** Every charge's counter equals its live allocations; every payment balances (§0.20). */
  async function balanced(w: World): Promise<void> {
    const charges = await db().charge.findMany({ where: { schoolId: w.school.id, kind: { not: 'adjustment' } } });
    for (const c of charges) {
      const live = await db().paymentAllocation.aggregate({ where: { schoolId: w.school.id, chargeId: c.id, reversedAt: null }, _sum: { amount: true } });
      expect([c.id, c.allocatedAmount]).toEqual([c.id, live._sum.amount ?? 0]);
      expect(c.allocatedAmount + c.creditedAmount).toBeLessThanOrEqual(c.amount);
    }
    for (const p of await db().payment.findMany({ where: { schoolId: w.school.id, status: 'verified' } })) {
      const live = await db().paymentAllocation.aggregate({ where: { schoolId: w.school.id, paymentId: p.id, reversedAt: null }, _sum: { amount: true } });
      const rev = await db().paymentReversal.findMany({ where: { schoolId: w.school.id, paymentId: p.id } });
      const net = rev.reduce((s, r) => s + (r.kind === 'refund_reversal' ? -r.amount : r.amount), 0);
      expect([p.id, (live._sum.amount ?? 0) + net + p.unallocatedAmount]).toEqual([p.id, p.amount]);
    }
  }

  it('R236: interleaved payments, voids, credits, a handover, a carry-forward and generation find no deadlock and no database-caused retry', async () => {
    const w = await h.world();
    for (const month of ['04', '05', '06']) {
      await runMonth(app, w.school, w.year, `2026-${month}`, karachi(`2026-${month}-01`));
    }
    // A later year for the carry-forward, and a clerk whose cash is handed over meanwhile.
    const later = await createAcademicYear(db(), w.school, { name: '2027-28', startsOn: '2027-04-01', endsOn: '2028-03-31', status: 'planned' });
    const next = await classWithSection(w.school, later, 'Class 6');
    await enrol(db(), w.school, { id: w.a.studentId }, next.section, { startedOn: '2027-04-01', status: 'left', endedOn: '2028-03-31' });
    const clerk = await h.signIn(w.school, 'office_staff');
    await pay(w, clerk, { studentIds: [w.b.studentId], amount: 500 });
    // Earlier payments to void, and an advance of A's to carry forward.
    const earlier: Payment[] = [];
    for (let i = 0; i < 4; i++) earlier.push(await pay(w, w.office, { studentIds: [w.a.studentId, w.b.studentId], amount: 2500 }));
    const carryable = await pay(w, w.principal, { studentIds: [w.a.studentId], amount: 400, advanceForStudentId: w.a.studentId });
    const settled = (await h.charges(w, w.a.studentId)).filter((c) => c.status === 'settled').map((c) => c.id);

    const deadlocksBefore = await deadlocks();
    const retriesBefore = onceMoreRetries.count;
    const work: Promise<{ status: number; body: unknown }>[] = [];
    const as = (p: PromiseLike<{ status: number; body: unknown }>) => work.push(Promise.resolve(p).then((r) => ({ status: r.status, body: r.body })));
    for (let round = 0; round < 4; round++) {
      as(record(w, [w.a.studentId, w.b.studentId], 3500));
      as(record(w, [w.b.studentId, w.a.studentId], 1500));
      as(post(`/payments/${earlier[round]!.id}/void`, { reason: 'Concurrent void' }, w.principal));
      const credited = settled[round % Math.max(1, settled.length)];
      if (credited !== undefined) as(post(`/charges/${credited}/adjust`, { amount: 100, reason: 'Concurrent credit' }, w.principal, newIdempotencyKey()));
    }
    as(post('/me/staff/cash-handovers', {}, clerk));
    as(post(`/payments/${carryable.id}/carry-forward`, { academicYearId: later.id.toString(), reason: 'Concurrent carry' }, w.principal, newIdempotencyKey()));
    work.push(
      runMonth(app, w.school, w.year, '2026-07', karachi('2026-10-04')).then(
        () => ({ status: 200, body: null }),
        (error: unknown) => ({ status: 500, body: String(error) }),
      ),
    );
    const results = await Promise.all(work);

    expect(results.filter((r) => r.status >= 500)).toEqual([]);
    const codes = results.filter((r) => r.status >= 300).map((r) => (r.body as { error?: { code: string } }).error?.code);
    expect(codes.filter((c) => c === ErrorCode.CONCURRENT_UPDATE)).toEqual([]);
    expect(results.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(8);
    expect(await deadlocks()).toBe(deadlocksBefore);
    // No retry came from the database (an increment CHECK or a deadlock). A service's own stale-read
    // re-check may retry (a void reopening a charge a credit was about to lock); those are counted.
    const causes = onceMoreRetries.causes.slice(retriesBefore);
    expect(causes.filter((c) => c !== 'stale_read')).toEqual([]);
    process.stdout.write(`R236 interleaving: ${causes.length} stale-read retries, 0 from the database
`);
    await balanced(w);
  });

  it('R188, R190: racing payments on one child never over-allocate, and receipt numbers stay gapless', async () => {
    const w = await h.world();
    const results = await Promise.all(Array.from({ length: 6 }, () => record(w, [w.a.studentId], 2000, w.a.studentId)));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
    const charges = await h.charges(w, w.a.studentId);
    expect(charges.map((c) => [c.allocatedAmount, c.status])).toEqual([[3000, 'settled'], [3000, 'settled']]);
    const unallocated = (await db().payment.findMany({ where: { schoolId: w.school.id } })).reduce((s, p) => s + p.unallocatedAmount, 0);
    expect(unallocated).toBe(12000 - 6000);
    const numbers = (await db().receipt.findMany({ where: { schoolId: w.school.id }, orderBy: { receiptNo: 'asc' } })).map((r) => r.receiptNo);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6]);
    const counter = await db().schoolCounter.findFirstOrThrow({ where: { schoolId: w.school.id, name: receiptCounterName(w.year.id) } });
    expect(counter.value).toBe(6n);
    await balanced(w);
  });

  it('§7.2 scenario: a family of three with twelve open charges is previewed and paid oldest first', async () => {
    const w = await h.world();
    for (const month of ['07', '08']) await runMonth(app, w.school, w.year, `2026-${month}`, karachi(`2026-${month}-01`));
    const c = await pupil(w.school, w.section, { startedOn: '2026-04-01', fullName: 'Hassan Tariq', guardianId: w.guardianId });
    for (const month of ['07', '08', '09', '10']) await runMonth(app, w.school, w.year, `2026-${month}`, karachi(`2026-${month}-02`));
    const ids = [w.a.studentId, w.b.studentId, c.studentId];
    expect(await db().charge.count({ where: { schoolId: w.school.id, status: 'open', studentId: { in: ids } } })).toBe(12);
    const body = { academicYearId: w.year.id.toString(), payerGuardianId: w.guardianId.toString(), studentIds: ids.map(String), amount: 30000 };
    const preview = await post('/payments/preview', body, w.office).expect(200);
    expect((preview.body as { allocations: { dueOn: string }[] }).allocations.map((a) => a.dueOn)).toEqual([
      ...['2026-07-10', '2026-08-10', '2026-09-10'].flatMap((d) => [d, d, d]),
      '2026-10-10',
    ]);
    const res = await post('/payments', { ...body, method: 'cash', receivedOn: isoDay(0) }, w.office, newIdempotencyKey());
    expect([res.status, err(res).error?.code, (res.body as Payment).allocatedAmount]).toEqual([201, undefined, 30000]);
  });
});
