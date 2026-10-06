// §7.2 for the counter, measured: preview + record of a family of three with twelve open charges
// must finish within 400 ms. The scenario's correctness is checked in concurrency.e2e-spec.ts.
//
// Measure it alone, so no other suite shares the database or the CPU:
//   pnpm --filter @asms/api test -- test/payments/counter-perf.e2e-spec.ts --runInBand
// In the full run it shares the machine with another worker; the budget is a budget, not the
// measured figure. The timed window is the two HTTP requests in-process, after a warm-up payment.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { newIdempotencyKey } from '@asms/shared';
import { createTestApp } from '../core/app';
import { closeTestDb } from '../support/schools';
import { createGuardian, isoDay } from '../support/students';
import { db, karachi, pupil, runMonth } from '../fees/charges-support';
import { paymentsHttp } from './payments-support';

describe('§7.2: the counter budget (performance)', () => {
  let app: NestExpressApplication;
  const h = paymentsHttp(() => app);

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('preview + record for a family of three with twelve open charges is within 400 ms', async () => {
    const w = await h.world();
    for (const month of ['07', '08']) await runMonth(app, w.school, w.year, `2026-${month}`, karachi(`2026-${month}-01`));
    const c = await pupil(w.school, w.section, { startedOn: '2026-04-01', fullName: 'Hassan Tariq', guardianId: w.guardianId });
    for (const month of ['07', '08', '09', '10']) await runMonth(app, w.school, w.year, `2026-${month}`, karachi(`2026-${month}-02`));
    const ids = [w.a.studentId, w.b.studentId, c.studentId];
    // Warm the path on another family first (connections, plans, the receipt counter).
    const other = await createGuardian(db(), w.school, {});
    const warm = await pupil(w.school, w.section, { startedOn: '2026-10-01', fullName: 'Warm Up', guardianId: other.id });
    await runMonth(app, w.school, w.year, '2026-10', karachi('2026-10-03'));
    await h
      .post(
        '/payments',
        { academicYearId: w.year.id.toString(), payerGuardianId: other.id.toString(), studentIds: [String(warm.studentId)], amount: 100, method: 'cash', receivedOn: isoDay(0) },
        w.office,
        newIdempotencyKey(),
      )
      .expect(201);

    const body = { academicYearId: w.year.id.toString(), payerGuardianId: w.guardianId.toString(), studentIds: ids.map(String), amount: 30000 };
    const started = performance.now();
    await h.post('/payments/preview', body, w.office).expect(200);
    await h.post('/payments', { ...body, method: 'cash', receivedOn: isoDay(0) }, w.office, newIdempotencyKey()).expect(201);
    const elapsed = performance.now() - started;
    process.stdout.write(`counter preview + record: ${elapsed.toFixed(0)} ms\n`);
    expect(elapsed).toBeLessThanOrEqual(400);
  });
});
