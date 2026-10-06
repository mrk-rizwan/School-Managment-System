// §7.2 for slice 22, measured at 3,000 students in 30 classes and 2,000 fee-paying families, with
// twelve months of tuition each (36,000 charges, all open: the defaulter list's worst case) and
// 9,000 counter payments with receipts spread over 92 days:
//   - GET /finance-reports/defaulters, first page, within 300 ms (R203);
//   - GET /finance-reports/collections over 92 days, every grouping, within 500 ms each;
//   - the fee-reminder job for the school (about 2,000 overdue reminders) within 20 s.
// The rows are written in bulk SQL (the generation and counter paths have budgets of their own).
//
// Measure it alone, so no other suite shares the database or the CPU:
//   pnpm --filter @asms/api test -- test/finance-reports/reports-perf.e2e-spec.ts --runInBand
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp } from '../core/app';
import { createSchoolSession, createSchoolUser } from '../support/school-session';
import { closeTestDb } from '../support/schools';
import { day, isoDay, randomPhone } from '../support/students';
import { db, financeSchool, session2026 } from '../fees/charges-support';
import { reportsHttp } from './support';

const STUDENTS = 3000;
const CLASSES = 30;
const FAMILIES_OF_TWO = 1000; // 2,000 children in pairs, 1,000 only children: 2,000 families.
const MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03'];

describe('§7.2: finance reports and reminders at 3,000 students (performance)', () => {
  let app: NestExpressApplication;
  const h = reportsHttp(() => app);

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('defaulters ≤ 300 ms, collections ≤ 500 ms per grouping, the reminder job ≤ 20 s', async () => {
    const { school, heads } = await financeSchool({}, 'Large Grammar School');
    const schoolId = school.id;
    const principalUser = await createSchoolUser(db(), school, { systemRole: 'principal' });
    const principal = { ...(await createSchoolSession(db(), school, principalUser)), user: principalUser };
    const clerk = await createSchoolUser(db(), school, { systemRole: 'office_staff' });
    const year = await session2026(school);

    await db().class.createMany({
      data: Array.from({ length: CLASSES }, (_, i) => ({ schoolId, academicYearId: year.id, name: `Class ${i + 1}`, attendanceMode: 'daily' as const })),
    });
    const classes = await db().class.findMany({ where: { schoolId, academicYearId: year.id }, select: { id: true }, orderBy: { id: 'asc' } });
    await db().section.createMany({ data: classes.map((c) => ({ schoolId, classId: c.id, name: 'A' })) });
    const sections = await db().section.findMany({ where: { schoolId }, select: { id: true, classId: true }, orderBy: { id: 'asc' } });
    await db().student.createMany({
      data: Array.from({ length: STUDENTS }, (_, i) => ({
        schoolId, admissionNo: String(100000 + i), fullName: `Student ${i}`, gender: i % 2 === 0 ? ('male' as const) : ('female' as const),
        dateOfBirth: day('2015-01-01'), status: 'active' as const, admittedOn: day('2026-04-01'),
      })),
    });
    const students = (await db().student.findMany({ where: { schoolId }, select: { id: true }, orderBy: { id: 'asc' } })).map((s) => s.id);
    const familyCount = FAMILIES_OF_TWO + (STUDENTS - 2 * FAMILIES_OF_TWO);
    await db().guardian.createMany({
      data: Array.from({ length: familyCount }, (_, i) => ({
        schoolId, fullName: `Parent ${i}`, phone: randomPhone(), contactCapability: i % 3 === 0 ? ('keypad' as const) : ('whatsapp' as const),
      })),
    });
    const guardians = (await db().guardian.findMany({ where: { schoolId }, select: { id: true }, orderBy: { id: 'asc' } })).map((g) => g.id);
    const familyOf = (i: number): bigint => {
      const id = guardians[i < 2 * FAMILIES_OF_TWO ? Math.floor(i / 2) : i - FAMILIES_OF_TWO];
      if (id === undefined) throw new Error('family out of range');
      return id;
    };
    await db().studentGuardian.createMany({
      data: students.map((studentId, i) => ({
        schoolId, studentId, guardianId: familyOf(i), relationship: 'father' as const, isPrimaryContact: true, isFeePayer: true, canLogin: false,
      })),
    });
    await db().enrolment.createMany({
      data: students.map((studentId, i) => {
        const section = sections[i % CLASSES];
        if (!section) throw new Error('no section');
        return { schoolId, studentId, academicYearId: year.id, classId: section.classId, sectionId: section.id, status: 'active' as const, startedOn: day('2026-04-01') };
      }),
    });

    // Twelve months of tuition for everyone, open.
    for (const period of MONTHS) {
      await db().$executeRaw`
        INSERT INTO charges (school_id, enrolment_id, student_id, academic_year_id, fee_head_id, head_frequency, kind,
                             period, gross_amount, concession_amount, amount, description, due_on, status)
        SELECT e.school_id, e.id, e.student_id, e.academic_year_id, ${heads.tuition}::bigint, 'monthly', 'generated',
               ${period}, 3000, 0, 3000, ${`Tuition ${period}`}, ${`${period}-10`}::date, 'open'
          FROM enrolments e WHERE e.school_id = ${schoolId}::bigint`;
    }
    // 9,000 counter payments over the last 92 days, each an advance with its receipt and line.
    await db().$executeRaw`
      INSERT INTO payments (school_id, academic_year_id, payer_guardian_id, method, amount, unallocated_amount, received_on,
                            recorded_by, verified_by, verified_at, advance_for_student_id, status, handover_id)
      SELECT ${schoolId}::bigint, ${year.id}::bigint, sg.guardian_id, 'cash', 1000, 1000,
             (${isoDay(0)}::date - ((sg.n * 3 + g.i) % 92)::int),
             ${clerk.userId}::bigint, ${clerk.userId}::bigint, now() - make_interval(days => ((sg.n * 3 + g.i) % 92)::int),
             sg.student_id, 'verified', NULL
        FROM (SELECT student_id, guardian_id, row_number() OVER (ORDER BY student_id) AS n
                FROM student_guardians WHERE school_id = ${schoolId}::bigint) sg
        CROSS JOIN generate_series(1, 3) AS g(i)`;
    await db().$executeRaw`
      INSERT INTO receipts (school_id, payment_id, academic_year_id, receipt_no, amount, issued_by)
      SELECT p.school_id, p.id, p.academic_year_id, row_number() OVER (ORDER BY p.id), p.amount, p.recorded_by
        FROM payments p WHERE p.school_id = ${schoolId}::bigint`;
    await db().$executeRaw`
      INSERT INTO receipt_lines (school_id, receipt_id, academic_year_id, student_id, charge_id, fee_head_name, period, amount)
      SELECT r.school_id, r.id, r.academic_year_id, p.advance_for_student_id, NULL, NULL, NULL, r.amount
        FROM receipts r JOIN payments p ON p.school_id = r.school_id AND p.id = r.payment_id
       WHERE r.school_id = ${schoolId}::bigint`;
    // The bulk load is measured on current statistics, as autovacuum would leave them live.
    await db().$executeRaw`ANALYZE charges, payments, receipts, receipt_lines, students, enrolments, student_guardians, guardians, messages`;
    expect(await db().charge.count({ where: { schoolId } })).toBe(STUDENTS * MONTHS.length);

    // Defaulters: warm up (connections, plans), then time the first page five times.
    const page = await h.get('/finance-reports/defaulters', principal).expect(200);
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const at = performance.now();
      await h.get('/finance-reports/defaulters', principal).expect(200);
      samples.push(performance.now() - at);
    }
    // The median of five first-page reads after a warm-up.
    const defaultersMs = [...samples].sort((x, y) => x - y)[2] ?? Number.POSITIVE_INFINITY;
    expect((page.body as { total: number }).total).toBe(STUDENTS);

    const timings: Record<string, number> = {};
    for (const groupBy of ['day', 'method', 'feeHead', 'class', 'collector']) {
      for (const basis of ['received', 'verified']) {
        const path = `/finance-reports/collections?receivedFrom=${isoDay(-91)}&receivedTo=${isoDay(0)}&groupBy=${groupBy}&basis=${basis}`;
        const at = performance.now();
        const res = await h.get(path, principal).expect(200);
        timings[`${groupBy}/${basis}`] = performance.now() - at;
        expect((res.body as { total: number }).total).toBe(STUDENTS * 3 * 1000);
      }
    }

    const reminderStart = performance.now();
    const run = await h.reminders({ school });
    const remindersMs = performance.now() - reminderStart;
    expect(run.overdue.families + run.due.families).toBeGreaterThan(0);

    const worst = Math.max(...Object.values(timings));
    console.log(
      `slice 22 at ${STUDENTS} students x ${MONTHS.length} months: defaulters ${defaultersMs.toFixed(0)} ms; collections worst ${worst.toFixed(0)} ms ` +
        `(${Object.entries(timings).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ')}); fee-reminder ${remindersMs.toFixed(0)} ms ` +
        `(${run.due.families} due, ${run.overdue.families} overdue)`,
    );
    expect(defaultersMs).toBeLessThanOrEqual(300);
    expect(worst).toBeLessThanOrEqual(500);
    expect(remindersMs).toBeLessThanOrEqual(20_000);
  }, 300_000);
});
