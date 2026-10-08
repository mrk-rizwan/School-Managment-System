// contracts/slice-35.md §7 (phase-4-academic.md §7.2): applying the promotion sheet of a 60-student
// final class — 60 enrolments completed, 60 students made alumni (status rows, audit rows,
// sessions), 60 rows marked applied, under the sheet's lock — must finish within 3 s, the
// request's answer included. The per-row work is batched so the budget also holds on a remote
// database, where each round trip costs tens of milliseconds.
//
// Measure it alone, so no other suite shares the database or the CPU:
//   node --experimental-vm-modules node_modules/jest/bin/jest.js test/promotion/apply-perf.e2e-spec.ts --runInBand
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp } from '../core/app';
import { closeTestDb } from '../support/schools';
import { approvedSheet, detailOf, promotionHttp, promotionWorld, student } from './support';

const STUDENTS = 60;
/** §7.2: apply a 60-student final-class sheet within 3 s. */
const BUDGET_MS = 3_000;

describe('§7.2: applying a 60-student final-class promotion sheet (performance)', () => {
  let app: NestExpressApplication;
  const h = promotionHttp(() => app);

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it(`applies ${STUDENTS} completions within ${BUDGET_MS} ms`, async () => {
    const w = await promotionWorld(() => app);
    const pupils = [];
    for (let i = 0; i < STUDENTS; i++) pupils.push(await student(w, w.a10A, `Pupil ${String(i + 1).padStart(2, '0')}`));
    await approvedSheet(w, w.a10A, pupils.map((p) => [p, true] as const));
    const opened = await h.open(w.a10A.id, w.yearB.id, w.principal);
    expect(opened.status).toBe(201);
    const sheet = detailOf(opened);
    expect(sheet.undecided).toBe(0);

    const started = performance.now();
    const applied = await h.apply(sheet.id, w.principal);
    const elapsed = performance.now() - started;

    expect(applied.status).toBe(200);
    const done = detailOf(applied);
    expect(done.status).toBe('applied');
    expect(done.decisions.every((d) => d.appliedAt !== null)).toBe(true);
    console.log(`apply of ${STUDENTS} completions: ${elapsed.toFixed(0)} ms`);
    expect(elapsed).toBeLessThanOrEqual(BUDGET_MS);
  });
});
