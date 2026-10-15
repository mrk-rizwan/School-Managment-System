// §7.2 for slice 42 (phase-5-extended.md; contracts/slice-42.md §6):
//   - GET /finance-reports/financial-statement over a year ≤ 1.5 s, at 3,000 students in 2,000
//     families paying monthly for twelve months (24,000 payments with receipts) and 1,200 expenses,
//     on both bases;
//   - the class ranking of 5 sections (200 published results) ≤ 500 ms: the recompute a publish
//     adds, timed alone in its transaction.
// The rows are written in bulk SQL, then ANALYZE, as autovacuum would leave the statistics live.
//
// Measure it alone, so no other suite shares the database or the CPU:
//   node --experimental-vm-modules node_modules/jest/bin/jest.js test/reports/reports-perf.e2e-spec.ts
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ClassRankingService } from '../../src/modules/results/class-ranking.service';
import { createTestApp } from '../core/app';
import { asSchool, tx } from '../messaging/support';
import { createSchoolSession, createSchoolUser } from '../support/school-session';
import { closeTestDb } from '../support/schools';
import { createAcademicYear, day, isoDay, randomPhone } from '../support/students';
import { db, financeSchool } from '../fees/charges-support';
import { reportsHttp } from '../finance-reports/support';

const FAMILIES = 2000;
const STUDENTS = 3000;
const MONTHS = 12;

describe('§7.2: the financial statement and the class ranking (performance)', () => {
  let app: NestExpressApplication;
  const h = reportsHttp(() => app);

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('the statement over a year ≤ 1.5 s on both bases', async () => {
    const { school } = await financeSchool({}, 'Large Grammar School');
    const schoolId = school.id;
    const principalUser = await createSchoolUser(db(), school, { systemRole: 'principal' });
    const principal = { ...(await createSchoolSession(db(), school, principalUser)), user: principalUser };
    const clerk = await createSchoolUser(db(), school, { systemRole: 'office_staff' });
    const year = await createAcademicYear(db(), school, { startsOn: isoDay(-370), endsOn: isoDay(10), status: 'active' });
    const klass = await db().class.create({ data: { schoolId, academicYearId: year.id, name: 'Class 1', attendanceMode: 'daily' } });
    const section = await db().section.create({ data: { schoolId, classId: klass.id, name: 'A' } });
    await db().student.createMany({
      data: Array.from({ length: STUDENTS }, (_, i) => ({
        schoolId,
        admissionNo: String(200000 + i),
        fullName: `Student ${i}`,
        gender: 'female' as const,
        dateOfBirth: day('2015-01-01'),
        status: 'active' as const,
        admittedOn: day(isoDay(-370)),
      })),
    });
    const students = (await db().student.findMany({ where: { schoolId }, select: { id: true }, orderBy: { id: 'asc' } })).map((s) => s.id);
    await db().guardian.createMany({
      data: Array.from({ length: FAMILIES }, (_, i) => ({ schoolId, fullName: `Parent ${i}`, phone: randomPhone(), contactCapability: 'whatsapp' as const })),
    });
    const guardians = (await db().guardian.findMany({ where: { schoolId }, select: { id: true }, orderBy: { id: 'asc' } })).map((g) => g.id);
    await db().studentGuardian.createMany({
      data: students.map((studentId, i) => ({
        schoolId,
        studentId,
        guardianId: guardians[i % FAMILIES] ?? 0n,
        relationship: 'mother' as const,
        isPrimaryContact: true,
        isFeePayer: true,
        canLogin: false,
      })),
    });
    await db().enrolment.createMany({
      data: students.map((studentId) => ({
        schoolId,
        studentId,
        academicYearId: year.id,
        classId: klass.id,
        sectionId: section.id,
        status: 'active' as const,
        startedOn: day(isoDay(-370)),
      })),
    });
    // One payment per family per month over the last year (kept as each family's advance), each
    // with its receipt.
    await db().$executeRaw`
      INSERT INTO payments (school_id, academic_year_id, payer_guardian_id, method, amount, unallocated_amount, received_on,
                            recorded_by, verified_by, verified_at, advance_for_student_id, status)
      SELECT ${schoolId}::bigint, ${year.id}::bigint, f.guardian_id, 'cash', 3000, 3000,
             ${isoDay(0)}::date - (m.i * 30 + (f.guardian_id % 28))::int,
             ${clerk.userId}::bigint, ${clerk.userId}::bigint,
             ((${isoDay(0)}::date - (m.i * 30 + (f.guardian_id % 28))::int)::timestamp + interval '30 hours') AT TIME ZONE 'Asia/Karachi',
             f.first_child, 'verified'
        FROM (SELECT guardian_id, min(student_id) AS first_child FROM student_guardians
               WHERE school_id = ${schoolId}::bigint GROUP BY guardian_id) f
        CROSS JOIN generate_series(0, ${MONTHS - 1}) AS m(i)`;
    await db().$executeRaw`
      INSERT INTO receipts (school_id, payment_id, academic_year_id, receipt_no, amount, issued_by)
      SELECT p.school_id, p.id, p.academic_year_id, row_number() OVER (ORDER BY p.id), p.amount, p.recorded_by
        FROM payments p WHERE p.school_id = ${schoolId}::bigint`;
    // A hundred small expenses a month.
    await db().$executeRaw`
      INSERT INTO expenses (school_id, expense_no, category, amount, spent_on, description, method, status, recorded_by)
      SELECT ${schoolId}::bigint, g.i, 'stationery', 1500, ${isoDay(0)}::date - (g.i % 360)::int, 'Chalk and registers', 'cash',
             'recorded', ${clerk.userId}::bigint
        FROM generate_series(1, ${MONTHS * 100}) AS g(i)`;
    await db().$executeRaw`ANALYZE payments, receipts, expenses, payment_reversals, payslips, salary_advances`;
    expect(await db().payment.count({ where: { schoolId } })).toBe(FAMILIES * MONTHS);

    const path = (basis: string) => `/finance-reports/financial-statement?from=${isoDay(-365)}&to=${isoDay(0)}&basis=${basis}`;
    await h.get(path('received'), principal).expect(200); // warm-up: connections, plans
    const timings: Record<string, number> = {};
    for (const basis of ['received', 'verified']) {
      const samples: number[] = [];
      let receipts = 0;
      for (let i = 0; i < 3; i++) {
        const at = performance.now();
        const res = await h.get(path(basis), principal).expect(200);
        samples.push(performance.now() - at);
        receipts = (res.body as { total: { receipts: number } }).total.receipts;
      }
      timings[basis] = [...samples].sort((x, y) => x - y)[1] ?? Number.POSITIVE_INFINITY;
      expect(receipts).toBeGreaterThan(0);
    }
    console.log(
      `slice 42 statement over a year (${FAMILIES * MONTHS} payments, ${MONTHS * 100} expenses): received ${timings.received?.toFixed(0)} ms, verified ${timings.verified?.toFixed(0)} ms`,
    );
    expect(Math.max(...Object.values(timings))).toBeLessThanOrEqual(1500);
  }, 600_000);

  it('the class ranking of 5 sections (200 published results) ≤ 500 ms', async () => {
    const { school } = await financeSchool({}, 'Ranked Grammar School');
    const schoolId = school.id;
    const principal = await createSchoolUser(db(), school, { systemRole: 'principal' });
    const decider = await createSchoolUser(db(), school, { systemRole: 'principal' });
    const year = await createAcademicYear(db(), school, { startsOn: isoDay(-100), endsOn: isoDay(200), status: 'active' });
    await db().$executeRaw`SELECT asms_seed_year_results(${schoolId}::bigint, ${year.id}::bigint)`;
    const term = await db().academicTerm.findFirstOrThrow({ where: { schoolId, academicYearId: year.id }, orderBy: { sortOrder: 'asc' } });
    const klass = await db().class.create({ data: { schoolId, academicYearId: year.id, name: 'Nine', attendanceMode: 'daily' } });
    const now = new Date();
    let n = 0;
    for (const name of ['A', 'B', 'C', 'D', 'E']) {
      const section = await db().section.create({ data: { schoolId, classId: klass.id, name } });
      const sheet = await db().resultSheet.create({
        data: { schoolId, academicYearId: year.id, termId: term.id, classId: klass.id, sectionId: section.id, createdBy: principal.userId },
      });
      const where = { schoolId, id: sheet.id };
      await db().resultSheet.updateMany({ where, data: { status: 'submitted', submittedBy: principal.userId, submittedAt: now } });
      await db().resultSheet.updateMany({
        where,
        data: {
          status: 'approved',
          decidedBy: decider.userId,
          decidedAt: now,
          testWeight: 20,
          examWeight: 80,
          passPercent: 40,
          passRule: 'all_subjects',
          bands: [{ grade: 'A', minPercent: 80 }, { grade: 'F', minPercent: 0 }],
        },
      });
      await db().resultSheet.updateMany({ where, data: { status: 'published', publishedBy: decider.userId, publishedAt: now } });
      for (let i = 0; i < 40; i++) {
        n += 1;
        const student = await db().student.create({
          data: {
            schoolId,
            admissionNo: String(300000 + n),
            fullName: `Pupil ${n}`,
            gender: 'male',
            dateOfBirth: day('2012-01-01'),
            status: 'active',
            admittedOn: day(isoDay(-100)),
          },
        });
        const enrolment = await db().enrolment.create({
          data: { schoolId, studentId: student.id, academicYearId: year.id, classId: klass.id, sectionId: section.id, status: 'active', startedOn: day(isoDay(-100)) },
        });
        const bp = 3000 + ((n * 37) % 7000);
        await db().result.create({
          data: {
            schoolId,
            sheetId: sheet.id,
            enrolmentId: enrolment.id,
            studentId: student.id,
            academicYearId: year.id,
            termId: term.id,
            totalObtained: Math.floor(bp / 100),
            totalMax: 100,
            percentBp: bp,
            grade: bp >= 8000 ? 'A' : 'F',
            passed: bp >= 4000,
            position: 1,
            positionOf: 1,
            publishedAt: now,
          },
        });
      }
    }
    await db().$executeRaw`ANALYZE results, result_sheets, enrolments, class_rankings, class_ranking_rows`;
    const rankings = app.get(ClassRankingService, { strict: false });
    const recompute = () =>
      asSchool(app, schoolId, () => tx.run(() => rankings.recompute(schoolId, klass.id, term.id, 'publish', principal.userId)));
    await recompute(); // warm-up: the first version
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const at = performance.now();
      expect(await recompute()).not.toBeNull();
      samples.push(performance.now() - at);
    }
    const median = [...samples].sort((x, y) => x - y)[1] ?? Number.POSITIVE_INFINITY;
    const live = await db().classRanking.findFirstOrThrow({ where: { schoolId, classId: klass.id, supersededAt: null } });
    expect(await db().classRankingRow.count({ where: { schoolId, rankingId: live.id } })).toBe(200);
    console.log(`slice 42 class ranking of 5 sections x 40: ${median.toFixed(0)} ms (samples ${samples.map((s) => s.toFixed(0)).join(', ')})`);
    expect(median).toBeLessThanOrEqual(500);
  }, 600_000);
});
