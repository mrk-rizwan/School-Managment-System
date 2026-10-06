// Control 4 / R62 for the slice-25 repositories (migration 20261006140100_slice25_payroll):
// salary_structures (with their components), salary_advances, payroll_runs and payslips (with their
// lines and recoveries) read, list and write only their own school's rows, and the run's month
// inputs (staff, structures, marks, leave, advances) never reach another school's.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PayrollRunRepository } from '../../src/repositories/payroll-run.repository';
import { PayslipRepository } from '../../src/repositories/payslip.repository';
import { SalaryAdvanceRepository } from '../../src/repositories/salary-advance.repository';
import { SalaryStructureRepository } from '../../src/repositories/salary-structure.repository';
import type { SchoolId } from '../../src/tenancy/school-id';
import { createTestApp } from '../core/app';
import { asSchool } from '../messaging/support';
import { expectIsolated } from '../support/isolation';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createTwoSchools, testDb } from '../support/schools';
import { day } from '../support/students';

const db = () => testDb();
const page = { skip: 0, take: 50 };

describe('slice 25 tenant isolation', () => {
  let app: NestExpressApplication;
  let structures: SalaryStructureRepository;
  let advances: SalaryAdvanceRepository;
  let runs: PayrollRunRepository;
  let payslips: PayslipRepository;
  const as = <T>(schoolId: SchoolId, fn: () => Promise<T>) => asSchool(app, schoolId, fn);

  beforeAll(async () => {
    app = await createTestApp();
    structures = app.get(SalaryStructureRepository, { strict: false });
    advances = app.get(SalaryAdvanceRepository, { strict: false });
    runs = app.get(PayrollRunRepository, { strict: false });
    payslips = app.get(PayslipRepository, { strict: false });
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  /** A principal and a teacher with a structure from 1 January 2026, in `schoolId`. */
  const staffed = async (schoolId: SchoolId) => {
    const school = { id: schoolId, shortCode: '' };
    const principal = await createSchoolUser(db(), school, { systemRole: 'principal' });
    const teacher = await createSchoolUser(db(), school, { systemRole: 'teacher' });
    const structureId = await as(schoolId, () =>
      structures.create(schoolId, {
        staffId: teacher.staffId,
        basic: 26_000,
        effectiveFrom: day('2026-01-01'),
        endedOn: null,
        reason: 'Appointment terms',
        createdBy: principal.userId,
        selfApproved: false,
        components: [{ kind: 'allowance', name: 'House rent', amount: 2_600 }],
      }),
    );
    return { principal, teacher, structureId };
  };

  it('salary_structures: read, history, in force, close and supersede see only their own school', async () => {
    const two = await createTwoSchools();
    let staffOfA = 0n;
    await expectIsolated(two, {
      create: async (schoolId) => {
        const { teacher, structureId } = await staffed(schoolId);
        staffOfA = teacher.staffId;
        return structureId;
      },
      read: (schoolId, id) => as(schoolId, () => structures.findById(schoolId, id)),
      list: async (schoolId) => (await as(schoolId, () => structures.listForStaff(schoolId, staffOfA, page))).rows,
      write: (schoolId, id) => as(schoolId, () => structures.close(schoolId, id, day('2026-06-30'))),
      snapshot: (row) => (row as { endedOn: Date | null }).endedOn,
    });
    const b = two.b.id;
    expect(await as(b, () => structures.latestActive(b, staffOfA))).toBeNull();
    expect(await as(b, () => structures.activeOn(b, staffOfA, day('2026-03-01')))).toBeNull();
  });

  it('salary_advances: read, list and write-off see only their own school', async () => {
    const two = await createTwoSchools();
    let approver = 0n;
    await expectIsolated(two, {
      create: async (schoolId) => {
        const { principal, teacher } = await staffed(schoolId);
        approver = principal.userId;
        return as(schoolId, () =>
          advances.create(schoolId, {
            staffId: teacher.staffId,
            amount: 5_000,
            grantedOn: day('2026-09-01'),
            recoverFrom: '2026-10',
            instalmentAmount: 1_000,
            approvedBy: principal.userId,
            paidMethod: 'cash',
            paidReference: null,
            expenseId: null,
          }),
        );
      },
      read: (schoolId, id) => as(schoolId, () => advances.findById(schoolId, id)),
      list: async (schoolId) => (await as(schoolId, () => advances.list(schoolId, page))).rows,
      write: (schoolId, id) => as(schoolId, () => advances.writeOff(schoolId, id, approver, new Date(), 'Hardship relief')),
      snapshot: (row) => (row as { status: string }).status,
    });
  });

  it('payroll_runs: read, by month, list, totals, finalise and the month inputs see only their own school', async () => {
    const two = await createTwoSchools();
    let teacherOfA = 0n;
    await expectIsolated(two, {
      create: async (schoolId) => {
        const { principal, teacher } = await staffed(schoolId);
        teacherOfA = teacher.staffId;
        await db().staffAttendance.create({
          data: { schoolId, staffId: teacher.staffId, date: day('2026-09-01'), status: 'absent', markedBy: principal.userId },
        });
        const run = await as(schoolId, () =>
          runs.create(schoolId, { yearMonth: '2026-09', preparedBy: principal.userId, preparedAt: new Date(), workingDays: 26, staffCount: 0, skipped: [], totalNet: 0 }),
        );
        return run.id;
      },
      read: (schoolId, id) => as(schoolId, () => runs.findById(schoolId, id)),
      list: async (schoolId) => (await as(schoolId, () => runs.list(schoolId, page))).rows,
      write: (schoolId, id) => as(schoolId, () => runs.addToTotalNet(schoolId, id, 1)),
      snapshot: (row) => (row as { totalNet: number }).totalNet,
    });
    const b = two.b.id;
    const from = day('2026-09-01');
    const to = day('2026-09-30');
    expect(await as(b, () => runs.findByMonth(b, '2026-09'))).toBeNull();
    expect((await as(b, () => runs.candidates(b, from, to))).map((c) => c.id)).not.toContain(teacherOfA);
    expect(await as(b, () => runs.structures(b, [teacherOfA], from, to))).toEqual([]);
    expect(await as(b, () => runs.marks(b, [teacherOfA], from, to))).toEqual([]);
    expect(await as(b, () => runs.approvedLeave(b, [teacherOfA], from, to))).toEqual([]);
    expect(await as(b, () => runs.openAdvances(b, [teacherOfA], '2026-12'))).toEqual([]);
    expect((await as(b, () => runs.staffNames(b, [teacherOfA]))).get(teacherOfA.toString())).toBe('');
  });

  it('payslips: read, by run, by staff, lines and mark paid see only their own school', async () => {
    const two = await createTwoSchools();
    let runOfA = 0n;
    let teacherOfA = 0n;
    let payer = 0n;
    await expectIsolated(two, {
      create: async (schoolId) => {
        const { principal, teacher, structureId } = await staffed(schoolId);
        teacherOfA = teacher.staffId;
        payer = principal.userId;
        const run = await as(schoolId, () =>
          runs.create(schoolId, { yearMonth: '2026-09', preparedBy: principal.userId, preparedAt: new Date(), workingDays: 26, staffCount: 1, skipped: [], totalNet: 28_600 }),
        );
        runOfA = run.id;
        const figures = {
          structureId, employedWorkingDays: 26, basic: 26_000, allowancesTotal: 2_600, deductionsTotal: 0, unpaidDays: 0,
          unmarkedDays: 26, absenceDeduction: 0, advanceRecovery: 0, adjustmentTotal: 0, net: 28_600,
        };
        const [slip] = await as(schoolId, () =>
          payslips.createMany(schoolId, run.id, [{ staffId: teacher.staffId, ...figures, lines: [{ kind: 'allowance', name: 'House rent', amount: 2_600 }] }]),
        );
        await as(schoolId, () => runs.finalise(schoolId, run.id, principal.userId, new Date(), null));
        return slip?.id ?? 0n;
      },
      read: (schoolId, id) => as(schoolId, () => payslips.findById(schoolId, id)),
      list: async (schoolId) => (await as(schoolId, () => payslips.listForRun(schoolId, runOfA, page))).rows,
      write: (schoolId, id) =>
        as(schoolId, () => payslips.markPaid(schoolId, id, { paidOn: day('2026-10-01'), paidMethod: 'cash', paidReference: null, paidBy: payer })),
      snapshot: (row) => (row as { status: string }).status,
    });
    const b = two.b.id;
    expect((await as(b, () => payslips.listFinalisedForStaff(b, teacherOfA, page))).rows).toEqual([]);
    expect(await as(b, () => payslips.ofRun(b, runOfA))).toEqual([]);
    expect(await as(b, () => payslips.hasAdjustment(b, runOfA, teacherOfA))).toBe(false);
  });
});
