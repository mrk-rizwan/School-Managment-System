// §7.2 for slice 22, measured at 3,000 students in 30 classes and 2,000 fee-paying families, with
// a realistic year: twelve months of three monthly heads (108,000 charges). Every family paid
// April to December at the counter, one payment per family and month, settled through real
// payment_allocations and receipt lines (the allocation trigger settles the charges); one family in
// five skipped August and September, so it owes two overdue months. January to March stay open for
// everyone, so every student is on the defaulter list whatever the date. The payments fall inside
// the last 92 days:
//   - GET /finance-reports/defaulters, first page, within 300 ms (R203);
//   - GET /finance-reports/collections over 92 days, every grouping, within 500 ms each
//     (by class reads each receipt line's enrolment in its year: the phase-close index
//     enrolments_school_id_student_id_academic_year_id_idx took it from 9.7 s to about 0.2 s);
//   - the fee-reminder job for the school within 20 s.
// The rows are written in bulk SQL (the generation and counter paths have budgets of their own),
// then ANALYZE, as autovacuum would leave the statistics live.
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
const PER_STUDENT_MONTH = 3000 + 1500 + 500; // tuition, transport, computer lab
const SETTLED_MONTHS = 9; // April to December; August and September skipped by one family in five.
const MONTHS = [
  '2026-04',
  '2026-05',
  '2026-06',
  '2026-07',
  '2026-08',
  '2026-09',
  '2026-10',
  '2026-11',
  '2026-12',
  '2027-01',
  '2027-02',
  '2027-03',
];

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
    const principal = {
      ...(await createSchoolSession(db(), school, principalUser)),
      user: principalUser,
    };
    const clerk = await createSchoolUser(db(), school, { systemRole: 'office_staff' });
    const year = await session2026(school);

    await db().class.createMany({
      data: Array.from({ length: CLASSES }, (_, i) => ({
        schoolId,
        academicYearId: year.id,
        name: `Class ${i + 1}`,
        attendanceMode: 'daily' as const,
      })),
    });
    const classes = await db().class.findMany({
      where: { schoolId, academicYearId: year.id },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    await db().section.createMany({
      data: classes.map((c) => ({ schoolId, classId: c.id, name: 'A' })),
    });
    const sections = await db().section.findMany({
      where: { schoolId },
      select: { id: true, classId: true },
      orderBy: { id: 'asc' },
    });
    await db().student.createMany({
      data: Array.from({ length: STUDENTS }, (_, i) => ({
        schoolId,
        admissionNo: String(100000 + i),
        fullName: `Student ${i}`,
        gender: i % 2 === 0 ? ('male' as const) : ('female' as const),
        dateOfBirth: day('2015-01-01'),
        status: 'active' as const,
        admittedOn: day('2026-04-01'),
      })),
    });
    const students = (
      await db().student.findMany({
        where: { schoolId },
        select: { id: true },
        orderBy: { id: 'asc' },
      })
    ).map((s) => s.id);
    const familyCount = FAMILIES_OF_TWO + (STUDENTS - 2 * FAMILIES_OF_TWO);
    await db().guardian.createMany({
      data: Array.from({ length: familyCount }, (_, i) => ({
        schoolId,
        fullName: `Parent ${i}`,
        phone: randomPhone(),
        contactCapability: i % 3 === 0 ? ('keypad' as const) : ('whatsapp' as const),
      })),
    });
    const guardians = (
      await db().guardian.findMany({
        where: { schoolId },
        select: { id: true },
        orderBy: { id: 'asc' },
      })
    ).map((g) => g.id);
    const familyOf = (i: number): bigint => {
      const id = guardians[i < 2 * FAMILIES_OF_TWO ? Math.floor(i / 2) : i - FAMILIES_OF_TWO];
      if (id === undefined) throw new Error('family out of range');
      return id;
    };
    await db().studentGuardian.createMany({
      data: students.map((studentId, i) => ({
        schoolId,
        studentId,
        guardianId: familyOf(i),
        relationship: 'father' as const,
        isPrimaryContact: true,
        isFeePayer: true,
        canLogin: false,
      })),
    });
    await db().enrolment.createMany({
      data: students.map((studentId, i) => {
        const section = sections[i % CLASSES];
        if (!section) throw new Error('no section');
        return {
          schoolId,
          studentId,
          academicYearId: year.id,
          classId: section.classId,
          sectionId: section.id,
          status: 'active' as const,
          startedOn: day('2026-04-01'),
        };
      }),
    });

    const loadStarted = performance.now();
    // Two more monthly heads beside tuition.
    await db().feeHead.createMany({
      data: ['Transport', 'Computer lab'].map((name) => ({
        schoolId,
        name,
        category: 'other',
        frequency: 'monthly',
        concessionEligible: true,
        refundable: true,
        createdBy: principalUser.userId,
      })),
    });
    const extra = await db().feeHead.findMany({
      where: { schoolId, name: { in: ['Transport', 'Computer lab'] } },
      select: { id: true, name: true },
    });
    const transport = extra.find((x) => x.name === 'Transport')?.id;
    const lab = extra.find((x) => x.name === 'Computer lab')?.id;
    if (transport === undefined || lab === undefined) throw new Error('heads missing');

    // Twelve months of three heads for everyone, open until the payments below settle them.
    for (const period of MONTHS) {
      await db().$executeRaw`
        INSERT INTO charges (school_id, enrolment_id, student_id, academic_year_id, fee_head_id, head_frequency, kind,
                             period, gross_amount, concession_amount, amount, description, due_on, status)
        SELECT e.school_id, e.id, e.student_id, e.academic_year_id, h.id, 'monthly', 'generated',
               ${period}, h.amount, 0, h.amount, ${`Fee ${period}`}, ${`${period}-10`}::date, 'open'
          FROM enrolments e
         CROSS JOIN (VALUES (${heads.tuition}::bigint, 3000), (${transport}::bigint, 1500), (${lab}::bigint, 500)) AS h(id, amount)
         WHERE e.school_id = ${schoolId}::bigint`;
    }
    // One counter payment per family and settled month, received in the last 92 days: month m
    // (0 = April) on today - (m * 10 + guardian_id % 10), so a family's months fall on distinct days.
    // Each names the family's first child as its advance child (payments_advance_student_required
    // is checked at commit; the allocations below leave no remainder).
    const today = isoDay(0);
    await db().$executeRaw`
      INSERT INTO payments (school_id, academic_year_id, payer_guardian_id, method, amount, unallocated_amount, received_on,
                            recorded_by, verified_by, verified_at, advance_for_student_id, status)
      SELECT ${schoolId}::bigint, ${year.id}::bigint, f.guardian_id, 'cash', f.kids * ${PER_STUDENT_MONTH}, f.kids * ${PER_STUDENT_MONTH},
             ${today}::date - (m.i * 10 + (f.guardian_id % 10))::int,
             ${clerk.userId}::bigint, ${clerk.userId}::bigint,
             ((${today}::date - (m.i * 10 + (f.guardian_id % 10))::int)::timestamp + interval '10 hours') AT TIME ZONE 'Asia/Karachi',
             f.first_child, 'verified'
        FROM (SELECT guardian_id, count(*)::int AS kids, min(student_id) AS first_child FROM student_guardians
               WHERE school_id = ${schoolId}::bigint GROUP BY guardian_id) f
        CROSS JOIN generate_series(0, ${SETTLED_MONTHS - 1}) AS m(i)
       WHERE NOT (f.guardian_id % 5 = 0 AND m.i IN (4, 5))`;
    // Fresh statistics first: on stale ones the allocations' foreign-key check on payments picks a
    // range index and scans the school's year per row (2 ms x 75,000).
    await db().$executeRaw`ANALYZE charges, payments`;
    const allocationsStarted = performance.now();
    // Each payment settles its family's three charges per child of that month.
    await db().$executeRaw`
      INSERT INTO payment_allocations (school_id, payment_id, charge_id, student_id, academic_year_id, amount)
      SELECT c.school_id, p.id, c.id, c.student_id, c.academic_year_id, c.amount
        FROM charges c
        JOIN student_guardians sg ON sg.school_id = c.school_id AND sg.student_id = c.student_id
        JOIN payments p ON p.school_id = c.school_id AND p.payer_guardian_id = sg.guardian_id
         AND p.received_on = ${today}::date
             - ((((substr(c.period, 1, 4)::int * 12 + substr(c.period, 6, 2)::int) - (2026 * 12 + 4)) * 10)
                + (sg.guardian_id % 10)::int)
       WHERE c.school_id = ${schoolId}::bigint
       ORDER BY p.id, c.id`;
    await db().$executeRaw`
      INSERT INTO receipts (school_id, payment_id, academic_year_id, receipt_no, amount, issued_by)
      SELECT p.school_id, p.id, p.academic_year_id, row_number() OVER (ORDER BY p.id), p.amount, p.recorded_by
        FROM payments p WHERE p.school_id = ${schoolId}::bigint`;
    await db().$executeRaw`
      INSERT INTO receipt_lines (school_id, receipt_id, academic_year_id, student_id, charge_id, fee_head_name, period, amount)
      SELECT r.school_id, r.id, r.academic_year_id, a.student_id, a.charge_id, h.name, c.period, a.amount
        FROM receipts r
        JOIN payment_allocations a ON a.school_id = r.school_id AND a.payment_id = r.payment_id
        JOIN charges c ON c.school_id = a.school_id AND c.id = a.charge_id
        JOIN fee_heads h ON h.school_id = c.school_id AND h.id = c.fee_head_id
       WHERE r.school_id = ${schoolId}::bigint`;
    const allocationsMs = performance.now() - allocationsStarted;
    // The bulk load is measured on current statistics, as autovacuum would leave them live.
    await db()
      .$executeRaw`ANALYZE charges, payments, payment_allocations, receipts, receipt_lines, students, enrolments, student_guardians, guardians, messages`;
    const loadMs = performance.now() - loadStarted;
    expect(await db().charge.count({ where: { schoolId } })).toBe(STUDENTS * MONTHS.length * 3);
    const skipperGuardians = guardians.filter((id) => id % 5n === 0n);
    const skippers = await db().studentGuardian.count({
      where: { schoolId, guardianId: { in: skipperGuardians } },
    });
    const settledMonths = STUDENTS * SETTLED_MONTHS - skippers * 2;
    expect(await db().charge.count({ where: { schoolId, status: 'settled' } })).toBe(
      settledMonths * 3,
    );
    expect(await db().receiptLine.count({ where: { schoolId } })).toBe(settledMonths * 3);
    expect(await db().payment.count({ where: { schoolId, unallocatedAmount: { not: 0 } } })).toBe(
      0,
    );
    const paid = await db().payment.aggregate({
      where: { schoolId },
      _sum: { amount: true },
      _count: true,
    });
    const collected = paid._sum.amount ?? 0;
    expect(collected).toBe(settledMonths * PER_STUDENT_MONTH);

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
        expect((res.body as { total: number }).total).toBe(collected);
      }
    }

    const reminderStart = performance.now();
    const run = await h.reminders({ school });
    const remindersMs = performance.now() - reminderStart;
    expect(run.overdue.families + run.due.families).toBeGreaterThan(0);

    const worst = Math.max(...Object.values(timings));
    console.log(
      `slice 22 at ${STUDENTS} students x ${MONTHS.length} months x 3 heads (${paid._count} payments): defaulters ${defaultersMs.toFixed(0)} ms; collections worst ${worst.toFixed(0)} ms ` +
        `(${Object.entries(timings)
          .map(([k, v]) => `${k} ${v.toFixed(0)}`)
          .join(', ')}); fee-reminder ${remindersMs.toFixed(0)} ms; load ${loadMs.toFixed(0)} ms (allocations and receipts ${allocationsMs.toFixed(0)}) ` +
        `(${run.due.families} due, ${run.overdue.families} overdue)`,
    );
    expect(defaultersMs).toBeLessThanOrEqual(300);
    expect(worst).toBeLessThanOrEqual(500);
    expect(remindersMs).toBeLessThanOrEqual(20_000);
  }, 600_000);
});
