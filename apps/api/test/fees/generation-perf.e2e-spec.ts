// §7.2 for charge generation, measured: a school of 3,000 students in 30 classes, three monthly
// heads, 300 concessions and 2,000 fee-paying families. The 1st's run (one transaction per class,
// the run row, about 2,000 fee_charged messages) must finish within 30 s; the next night's catch-up
// that finds nothing within 5 s. The figures are printed for the WORKLOG's capacity note.
//
// Measure it alone, so no other suite shares the database or the CPU:
//   pnpm --filter @asms/api test -- test/fees/generation-perf.e2e-spec.ts --runInBand
// In the full run it shares the machine with another worker; the budgets still hold there (they are
// budgets, not the measured figure). The timed window ends when the run's last transaction commits:
// the ~2,000 fee_charged message jobs are enqueued to BullMQ after that commit and are not timed.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp } from '../core/app';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb } from '../support/schools';
import { day, randomPhone } from '../support/students';
import { db, daily, financeSchool, karachi, session2026 } from './charges-support';

const STUDENTS = 3000;
const CLASSES = 30;
const FAMILIES_OF_TWO = 1000; // 2,000 children; the other 1,000 are only children: 2,000 families.
const CONCESSIONS = 300;

describe('§7.2: charge generation at 3,000 students (performance)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('the 1st charges 3 monthly heads for 3,000 students within 30 s; a catch-up that finds nothing within 5 s', async () => {
    const { school, heads } = await financeSchool({}, 'Large Grammar School');
    const schoolId = school.id;
    const principal = await createSchoolUser(db(), school, { systemRole: 'principal' });
    const year = await session2026(school);
    // Two more monthly heads beside tuition.
    await db().feeHead.createMany({
      data: ['Transport', 'Computer lab'].map((name) => ({
        schoolId, name, category: 'other', frequency: 'monthly', concessionEligible: true, refundable: true, createdBy: principal.userId,
      })),
    });
    const monthly = (await db().feeHead.findMany({ where: { schoolId, frequency: 'monthly' }, select: { id: true } })).map((h) => h.id);
    expect(monthly.length).toBe(3);

    await db().class.createMany({
      data: Array.from({ length: CLASSES }, (_, i) => ({ schoolId, academicYearId: year.id, name: `Class ${i + 1}`, attendanceMode: 'daily' as const })),
    });
    const classes = await db().class.findMany({ where: { schoolId, academicYearId: year.id }, select: { id: true }, orderBy: { id: 'asc' } });
    await db().section.createMany({ data: classes.map((c) => ({ schoolId, classId: c.id, name: 'A' })) });
    const sections = await db().section.findMany({ where: { schoolId }, select: { id: true, classId: true }, orderBy: { id: 'asc' } });
    await db().feeStructure.createMany({
      data: classes.flatMap((c, i) =>
        monthly.map((feeHeadId, h) => ({
          schoolId, academicYearId: year.id, classId: c.id, feeHeadId, amount: 2000 + i * 50 + h * 500, effectiveFrom: '2026-04', createdBy: principal.userId,
        })),
      ),
    });

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
        schoolId, fullName: `Parent ${i}`, phone: randomPhone(), contactCapability: 'whatsapp' as const,
      })),
    });
    const guardians = (await db().guardian.findMany({ where: { schoolId }, select: { id: true }, orderBy: { id: 'asc' } })).map((g) => g.id);
    const familyOf = (i: number): bigint => {
      const index = i < 2 * FAMILIES_OF_TWO ? Math.floor(i / 2) : i - FAMILIES_OF_TWO;
      const id = guardians[index];
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
    const enrolments = await db().enrolment.findMany({ where: { schoolId }, select: { id: true, studentId: true }, orderBy: { studentId: 'asc' } });
    await db().concession.createMany({
      data: enrolments.slice(0, CONCESSIONS).map((e) => ({
        schoolId, studentId: e.studentId, academicYearId: year.id, enrolmentId: e.id, kind: 'percentage' as const, value: 25,
        effectiveFrom: '2026-04', reason: 'Sibling discount', requestedBy: principal.userId, status: 'approved' as const,
        decidedBy: principal.userId, decidedAt: new Date(),
      })),
    });
    const concessions = await db().concession.findMany({ where: { schoolId }, select: { id: true } });
    await db().concessionHead.createMany({ data: concessions.map((c) => ({ schoolId, concessionId: c.id, feeHeadId: heads.tuition })) });

    const started = Date.now();
    await daily(app, school, karachi('2026-10-01', 1));
    const firstMs = Date.now() - started;

    expect(await db().charge.count({ where: { schoolId } })).toBe(STUDENTS * 3);
    expect(await db().charge.count({ where: { schoolId, concessionAmount: { gt: 0 } } })).toBe(CONCESSIONS);
    expect(await db().message.count({ where: { schoolId, type: 'fee_charged' } })).toBe(familyCount);
    const run = await db().chargeRun.findFirstOrThrow({ where: { schoolId } });
    expect([run.status, run.chargesInserted, run.studentsCharged]).toEqual(['done', STUDENTS * 3, STUDENTS]);

    // The 1st wrote 9,000 rows into charges; autovacuum analyzes a table that grew this much
    // before the next night, so the catch-up is measured on current statistics, as it runs live.
    await db().$executeRaw`ANALYZE charges`;
    const catchUpStarted = Date.now();
    await daily(app, school, karachi('2026-10-02', 1));
    const catchUpMs = Date.now() - catchUpStarted;
    expect(await db().chargeRun.count({ where: { schoolId } })).toBe(1);

    console.log(`charge-generate at ${STUDENTS} students x 3 heads: the 1st ${firstMs} ms (${familyCount} messages); empty catch-up ${catchUpMs} ms`);
    expect(firstMs).toBeLessThan(30_000);
    expect(catchUpMs).toBeLessThan(5_000);
  }, 180_000);
});
