// §7.2 for payroll, measured with headroom: a school of 500 staff (the budget names 200), each with
// a structure of three components, a month of staff attendance (26 marks each), approved leave for
// 125 and open advances for 100. The pay-day job's prepare of September (the month read once, every
// payslip and line written) must finish within §7.2's 5 s; the recompute and the finalise (with
// recoveries and 500 payslip_ready messages), each inside the 15 s request transaction, within 10 s.
//
// Measure it alone, so no other suite shares the database or the CPU:
//   pnpm --filter @asms/api test -- test/payroll/payroll-perf.e2e-spec.ts --runInBand
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from '../core/app';
import { createSchoolSession, createSchoolUser } from '../support/school-session';
import { closeTestDb } from '../support/schools';
import { day, randomPhone } from '../support/students';
import { approvedLeave, db, karachi, payDay, payrollSchool, september } from './support';

const ORIGIN = new URL(process.env.APP_URL ?? 'http://localhost:3460').origin;
const STAFF = 500;
/** §7.2: payroll-prepare for 200 staff within 5 s; held here at 500. */
const BUDGET_MS = 5_000;
/** Recompute and finalise run inside the 15 s request transaction: held at 10 s at 500 staff. */
const REQUEST_BUDGET_MS = 10_000;
const ON_LEAVE = 125;
const BORROWERS = 100;

describe('§7.2: payroll at 500 staff (performance)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('500 staff: prepare within 5 s, recompute and finalise within 10 s each', async () => {
    const { school, types } = await payrollSchool();
    const schoolId = school.id;
    const principal = await createSchoolUser(db(), school, { systemRole: 'principal' });
    await db().staff.createMany({
      data: Array.from({ length: STAFF }, (_, i) => ({ schoolId, fullName: `Staff ${i}`, phone: randomPhone(), status: 'active' as const })),
    });
    const staff = (await db().staff.findMany({ where: { schoolId, NOT: { id: principal.staffId } }, select: { id: true }, orderBy: { id: 'asc' } })).map((s) => s.id);
    expect(staff.length).toBe(STAFF);
    await db().salaryStructure.createMany({
      data: staff.map((staffId, i) => ({
        schoolId, staffId, basic: 30_000 + i * 100, effectiveFrom: day('2026-01-01'), reason: 'Appointment terms', createdBy: principal.userId,
      })),
    });
    const structures = await db().salaryStructure.findMany({ where: { schoolId }, select: { id: true } });
    await db().salaryStructureComponent.createMany({
      data: structures.flatMap((s) => [
        { schoolId, structureId: s.id, kind: 'allowance' as const, name: 'House rent', amount: 6_000, position: 0 },
        { schoolId, structureId: s.id, kind: 'allowance' as const, name: 'Conveyance', amount: 2_000, position: 1 },
        { schoolId, structureId: s.id, kind: 'deduction' as const, name: 'Provident fund', amount: 1_500, position: 2 },
      ]),
    });
    const month = september('present', ['2026-09-14', '2026-09-15']);
    await db().staffAttendance.createMany({
      data: staff.flatMap((staffId, i) =>
        Object.entries({ ...month, '2026-09-14': i % 3 === 0 ? 'absent' : 'present', '2026-09-15': i % 5 === 0 ? 'on_leave' : 'present' } as const).map(
          ([date, status]) => ({ schoolId, staffId, date: day(date), status, markedBy: principal.userId }),
        ),
      ),
    });
    for (const staffId of staff.slice(0, ON_LEAVE)) {
      await approvedLeave(school, staffId, types.casual, '2026-09-21', '2026-09-22', principal.userId);
    }
    await db().salaryAdvance.createMany({
      data: staff.slice(ON_LEAVE, ON_LEAVE + BORROWERS).map((staffId) => ({
        schoolId, staffId, amount: 10_000, grantedOn: day('2026-08-10'), recoverFrom: '2026-09', instalmentAmount: 2_500,
        approvedBy: principal.userId, paidMethod: 'cash' as const,
      })),
    });

    const started = performance.now();
    const runId = await payDay(app, schoolId, karachi('2026-10-01', 3));
    const prepareMs = performance.now() - started;
    expect(runId).not.toBeNull();
    const run = await db().payrollRun.findFirst({ where: { schoolId, id: runId ?? 0n } });
    expect([run?.staffCount, run?.workingDays]).toEqual([STAFF, 26]);
    expect(await db().payslipLine.count({ where: { schoolId } })).toBeGreaterThan(STAFF * 3);

    // The run's two other whole-school steps, over HTTP as the principal runs them (inside the
    // 15 s request transaction).
    const session = await createSchoolSession(db(), school, principal);
    const timed = async (path: string): Promise<number> => {
      const t = performance.now();
      await request(app.getHttpServer()).post(`/api/v1${path}`).set('Cookie', session.cookie).set('Origin', ORIGIN).send({}).expect(200);
      return performance.now() - t;
    };
    const recomputeMs = await timed(`/payroll-runs/${runId}/recompute`);
    const finaliseMs = await timed(`/payroll-runs/${runId}/finalise`);
    expect(await db().salaryAdvanceRecovery.count({ where: { schoolId } })).toBe(BORROWERS);
    expect(await db().message.count({ where: { schoolId, type: 'payslip_ready' } })).toBe(STAFF);

    process.stdout.write(
      `payroll at ${STAFF} staff: prepare ${Math.round(prepareMs)} ms (budget ${BUDGET_MS}), recompute ${Math.round(recomputeMs)} ms, finalise ${Math.round(finaliseMs)} ms (budget ${REQUEST_BUDGET_MS} each)\n`,
    );
    expect(prepareMs).toBeLessThan(BUDGET_MS);
    expect(recomputeMs).toBeLessThan(REQUEST_BUDGET_MS);
    expect(finaliseMs).toBeLessThan(REQUEST_BUDGET_MS);
  }, 300_000);
});

