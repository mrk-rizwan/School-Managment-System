// Control 4 / R62 for the wave J tables (migrations 20261006140000_slice20_payments and
// 20261006140100_slice25_payroll), at the database: a row written for school A is not found by a
// school-B query and not changed by a school-B write, and every composite foreign key refuses
// another school's parent. The build agents of slices 20 and 25 add the repository-level probes
// beside their repositories; these hold the schema to the same standard from the day the tables
// exist.
import { closeTestDb, createTwoSchools, testDb, type TestSchool } from '../support/schools';
import { expectIsolated } from '../support/isolation';
import { createSchoolUser } from '../support/school-session';
import { createClassWithSection, createStudent, day, enrol, isoDay } from '../support/students';

const db = () => testDb();

/** One school's parents of every wave J row: a principal, a clerk, an enrolled student, a head and a charge. */
async function parents(school: TestSchool) {
  const principal = await createSchoolUser(db(), school, { systemRole: 'principal' });
  const clerk = await createSchoolUser(db(), school, { systemRole: 'office_staff' });
  const { year, section } = await createClassWithSection(db(), school);
  const student = await createStudent(db(), school);
  const enrolment = await enrol(db(), school, student, section);
  const head = await db().feeHead.create({
    data: { schoolId: school.id, name: `Head ${principal.userId}`, category: 'other', frequency: 'monthly', concessionEligible: true, refundable: true, createdBy: principal.userId },
  });
  const charge = await db().charge.create({
    data: {
      schoolId: school.id, enrolmentId: enrolment.id, studentId: student.id, academicYearId: year.id, feeHeadId: head.id,
      headFrequency: 'monthly', kind: 'manual', period: isoDay().slice(0, 7), grossAmount: 1000, amount: 1000,
      description: 'Bus fare', dueOn: day(isoDay()), createdBy: principal.userId,
    },
  });
  return { principal, clerk, year, student, enrolment, head, charge };
}
type Parents = Awaited<ReturnType<typeof parents>>;

/** A cash payment by the clerk, all of it an advance for the student until allocated. */
const payment = (school: TestSchool, p: Parents, over: { academicYearId?: bigint; advanceForStudentId?: bigint } = {}) =>
  db().payment.create({
    data: {
      schoolId: school.id, academicYearId: over.academicYearId ?? p.year.id, payerName: 'Walk-in parent', method: 'cash', amount: 1000,
      receivedOn: day(isoDay()), recordedBy: p.clerk.userId, verifiedBy: p.clerk.userId,
      advanceForStudentId: over.advanceForStudentId ?? p.student.id,
    },
  });

const structure = (school: TestSchool, p: Parents, staffId = p.clerk.staffId) =>
  db().salaryStructure.create({
    data: { schoolId: school.id, staffId, basic: 30000, effectiveFrom: day('2026-01-01'), reason: 'Hired', createdBy: p.principal.userId },
  });

const run = (school: TestSchool, p: Parents) =>
  db().payrollRun.create({ data: { schoolId: school.id, yearMonth: '2026-09', workingDays: 26, preparedBy: p.principal.userId } });

const payslip = async (school: TestSchool, p: Parents) => {
  const s = await structure(school, p);
  const r = await run(school, p);
  return db().payslip.create({
    data: {
      schoolId: school.id, runId: r.id, staffId: p.clerk.staffId, structureId: s.id, employedWorkingDays: 26, basic: 30000,
      allowancesTotal: 0, deductionsTotal: 0, unpaidDays: 0, unmarkedDays: 0, absenceDeduction: 0, advanceRecovery: 0, net: 30000,
    },
  });
};

const advance = (school: TestSchool, p: Parents, staffId = p.clerk.staffId) =>
  db().salaryAdvance.create({
    data: {
      schoolId: school.id, staffId, amount: 6000, grantedOn: day('2026-09-01'), recoverFrom: '2026-09', instalmentAmount: 2000,
      approvedBy: p.principal.userId, paidMethod: 'cash',
    },
  });

/** Refused by the database (a composite FK naming school B's parent from school A, or a CHECK). */
const refused = (write: Promise<unknown>) => expect(write).rejects.toThrow();

describe('wave J tenant isolation (database level)', () => {
  afterAll(() => closeTestDb());

  it('payments: invisible and unwritable from another school; the year and the advance child must be the school\'s own', async () => {
    const two = await createTwoSchools();
    const [a, b] = [await parents(two.a), await parents(two.b)];
    await expectIsolated(two, {
      create: async () => (await payment(two.a, a)).id,
      read: (schoolId, id) => db().payment.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().payment.findMany({ where: { schoolId } }),
      write: async (schoolId, id) => (await db().payment.updateMany({ where: { schoolId, id }, data: { status: 'voided', voidedAt: new Date() } })).count,
      snapshot: (row) => (row as { status: string }).status,
    });
    await refused(payment(two.b, b, { academicYearId: a.year.id }));
    await refused(payment(two.b, b, { advanceForStudentId: a.student.id }));
  });

  it('payment_allocations: invisible from another school; another school\'s charge or payment is refused', async () => {
    const two = await createTwoSchools();
    const [a, b] = [await parents(two.a), await parents(two.b)];
    const [paymentA, paymentB] = [await payment(two.a, a), await payment(two.b, b)];
    const allocate = (schoolId: TestSchool['id'], paymentId: bigint, p: Parents) =>
      db().paymentAllocation.create({ data: { schoolId, paymentId, chargeId: p.charge.id, studentId: p.student.id, academicYearId: p.year.id, amount: 400 } });
    await expectIsolated(two, {
      create: async () => (await allocate(two.a.id, paymentA.id, a)).id,
      read: (schoolId, id) => db().paymentAllocation.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().paymentAllocation.findMany({ where: { schoolId } }),
      write: async (schoolId, id) => (await db().paymentAllocation.updateMany({ where: { schoolId, id }, data: { reversedAt: new Date() } })).count,
      snapshot: (row) => (row as { reversedAt: Date | null }).reversedAt,
    });
    await refused(allocate(two.b.id, paymentB.id, a));
    await refused(allocate(two.b.id, paymentA.id, b));
  });

  it('receipts: invisible and unwritable from another school; another school\'s payment is refused', async () => {
    const two = await createTwoSchools();
    const [a, b] = [await parents(two.a), await parents(two.b)];
    const paymentA = await payment(two.a, a);
    const receipt = (schoolId: TestSchool['id'], paymentId: bigint, p: Parents) =>
      db().receipt.create({ data: { schoolId, paymentId, academicYearId: p.year.id, receiptNo: 1, amount: 1000, issuedBy: p.clerk.userId } });
    await expectIsolated(two, {
      create: async () => (await receipt(two.a.id, paymentA.id, a)).id,
      read: (schoolId, id) => db().receipt.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().receipt.findMany({ where: { schoolId } }),
      write: async (schoolId, id) => (await db().receipt.updateMany({ where: { schoolId, id }, data: { voidedAt: new Date() } })).count,
      snapshot: (row) => (row as { voidedAt: Date | null }).voidedAt,
    });
    await refused(receipt(two.b.id, paymentA.id, b));
  });

  it('receipt_lines: invisible from another school; another school\'s receipt, student or charge is refused', async () => {
    const two = await createTwoSchools();
    const [a, b] = [await parents(two.a), await parents(two.b)];
    const receiptOf = async (school: TestSchool, p: Parents) =>
      db().receipt.create({ data: { schoolId: school.id, paymentId: (await payment(school, p)).id, academicYearId: p.year.id, receiptNo: 1, amount: 1000, issuedBy: p.clerk.userId } });
    const [receiptA, receiptB] = [await receiptOf(two.a, a), await receiptOf(two.b, b)];
    const line = (schoolId: TestSchool['id'], receiptId: bigint, p: Parents, chargeId: bigint) =>
      db().receiptLine.create({ data: { schoolId, receiptId, academicYearId: p.year.id, studentId: p.student.id, chargeId, feeHeadName: 'Bus', period: isoDay().slice(0, 7), amount: 400 } });
    await expectIsolated(two, {
      create: async () => (await line(two.a.id, receiptA.id, a, a.charge.id)).id,
      read: (schoolId, id) => db().receiptLine.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().receiptLine.findMany({ where: { schoolId } }),
    });
    await refused(line(two.b.id, receiptA.id, b, b.charge.id));
    await refused(line(two.b.id, receiptB.id, b, a.charge.id));
  });

  it('payment_reversals: invisible from another school; another school\'s payment is refused', async () => {
    const two = await createTwoSchools();
    const [a, b] = [await parents(two.a), await parents(two.b)];
    const [paymentA] = [await payment(two.a, a)];
    const refund = (schoolId: TestSchool['id'], paymentId: bigint, p: Parents) =>
      db().paymentReversal.create({
        data: { schoolId, paymentId, academicYearId: p.year.id, kind: 'refund', amount: 100, reason: 'Overpaid', requestedBy: p.principal.userId, approvedBy: p.principal.userId, refundMethod: 'cash' },
      });
    await expectIsolated(two, {
      create: async () => (await refund(two.a.id, paymentA.id, a)).id,
      read: (schoolId, id) => db().paymentReversal.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().paymentReversal.findMany({ where: { schoolId } }),
    });
    await refused(refund(two.b.id, paymentA.id, b));
  });

  it('cash_handovers: invisible and unwritable from another school; another school\'s collector is refused', async () => {
    const two = await createTwoSchools();
    const [a, b] = [await parents(two.a), await parents(two.b)];
    /** Opens a handover of the clerk's custody (one payment), as the service does, in one transaction. */
    const open = async (school: TestSchool, p: Parents, collector = p.clerk) => {
      const paid = await payment(school, p);
      return db().$transaction(async (tx) => {
        const handover = await tx.cashHandover.create({
          data: { schoolId: school.id, collectorUserId: collector.userId, collectorStaffId: collector.staffId, openedBy: collector.userId, expectedAmount: 1000, paymentCount: 1 },
        });
        await tx.payment.updateMany({ where: { schoolId: school.id, id: paid.id }, data: { handoverId: handover.id } });
        return handover;
      });
    };
    await expectIsolated(two, {
      create: async () => (await open(two.a, a)).id,
      read: (schoolId, id) => db().cashHandover.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().cashHandover.findMany({ where: { schoolId } }),
      write: async (schoolId, id) =>
        (await db().cashHandover.updateMany({
          where: { schoolId, id },
          data: { status: 'confirmed', confirmedAt: new Date(), confirmedBy: b.principal.userId, countedAmount: 1000, shortfallAmount: 0, surplusAmount: 0 },
        })).count,
      snapshot: (row) => (row as { status: string }).status,
    });
    await refused(
      db().cashHandover.create({
        data: { schoolId: two.b.id, collectorUserId: a.clerk.userId, collectorStaffId: a.clerk.staffId, openedBy: b.principal.userId, onBehalf: true, expectedAmount: 1000, paymentCount: 1 },
      }),
    );
  });

  it('salary_structures: invisible and unwritable from another school; another school\'s staff member is refused', async () => {
    const two = await createTwoSchools();
    const [a, b] = [await parents(two.a), await parents(two.b)];
    await expectIsolated(two, {
      create: async () => (await structure(two.a, a)).id,
      read: (schoolId, id) => db().salaryStructure.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().salaryStructure.findMany({ where: { schoolId } }),
      write: async (schoolId, id) => (await db().salaryStructure.updateMany({ where: { schoolId, id }, data: { endedOn: day('2026-06-30') } })).count,
      snapshot: (row) => (row as { endedOn: Date | null }).endedOn,
    });
    await refused(structure(two.b, b, a.clerk.staffId));
  });

  it('salary_structure_components: invisible from another school; another school\'s structure is refused', async () => {
    const two = await createTwoSchools();
    const [a, b] = [await parents(two.a), await parents(two.b)];
    const structureA = await structure(two.a, a);
    await expectIsolated(two, {
      create: async () => (await db().salaryStructureComponent.create({ data: { schoolId: two.a.id, structureId: structureA.id, kind: 'allowance', name: 'House rent', amount: 5000, position: 0 } })).id,
      read: (schoolId, id) => db().salaryStructureComponent.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().salaryStructureComponent.findMany({ where: { schoolId } }),
    });
    await refused(db().salaryStructureComponent.create({ data: { schoolId: two.b.id, structureId: structureA.id, kind: 'allowance', name: 'Medical', amount: 1000, position: 1 } }));
    expect(b.principal.userId).not.toBe(a.principal.userId);
  });

  it('salary_advances: invisible and unwritable from another school; another school\'s staff member is refused', async () => {
    const two = await createTwoSchools();
    const [a, b] = [await parents(two.a), await parents(two.b)];
    await expectIsolated(two, {
      create: async () => (await advance(two.a, a)).id,
      read: (schoolId, id) => db().salaryAdvance.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().salaryAdvance.findMany({ where: { schoolId } }),
      write: async (schoolId, id) =>
        (await db().salaryAdvance.updateMany({ where: { schoolId, id }, data: { status: 'written_off', writtenOffAt: new Date(), writtenOffBy: b.principal.userId, writeOffReason: 'Hijacked' } })).count,
      snapshot: (row) => (row as { status: string }).status,
    });
    await refused(advance(two.b, b, a.clerk.staffId));
  });

  it('payroll_runs: invisible and unwritable from another school; one run per school and month', async () => {
    const two = await createTwoSchools();
    const [a, b] = [await parents(two.a), await parents(two.b)];
    await expectIsolated(two, {
      create: async () => (await run(two.a, a)).id,
      read: (schoolId, id) => db().payrollRun.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().payrollRun.findMany({ where: { schoolId } }),
      write: async (schoolId, id) => (await db().payrollRun.updateMany({ where: { schoolId, id }, data: { workingDays: 1 } })).count,
      snapshot: (row) => (row as { workingDays: number }).workingDays,
    });
    expect(await run(two.b, b)).toBeTruthy();
    await refused(run(two.b, b));
  });

  it('payslips: invisible and unwritable from another school; another school\'s run or structure is refused', async () => {
    const two = await createTwoSchools();
    const [a, b] = [await parents(two.a), await parents(two.b)];
    await expectIsolated(two, {
      create: async () => (await payslip(two.a, a)).id,
      read: (schoolId, id) => db().payslip.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().payslip.findMany({ where: { schoolId } }),
      write: async (schoolId, id) => (await db().payslip.updateMany({ where: { schoolId, id }, data: { adjustmentTotal: 5, net: 30005 } })).count,
      snapshot: (row) => (row as { net: number }).net,
    });
    const teacherA = await createSchoolUser(db(), two.a, { systemRole: 'teacher' });
    const [structureA, runB] = [await structure(two.a, a, teacherA.staffId), await run(two.b, b)];
    await refused(
      db().payslip.create({
        data: {
          schoolId: two.b.id, runId: runB.id, staffId: teacherA.staffId, structureId: structureA.id, employedWorkingDays: 26, basic: 1,
          allowancesTotal: 0, deductionsTotal: 0, unpaidDays: 0, unmarkedDays: 0, absenceDeduction: 0, advanceRecovery: 0, net: 1,
        },
      }),
    );
  });

  it('payslip_lines: invisible from another school; another school\'s payslip is refused', async () => {
    const two = await createTwoSchools();
    const [a, b] = [await parents(two.a), await parents(two.b)];
    const slipA = await payslip(two.a, a);
    const line = (schoolId: TestSchool['id']) =>
      db().payslipLine.create({ data: { schoolId, payslipId: slipA.id, staffId: a.clerk.staffId, kind: 'allowance', name: 'House rent', amount: 5000 } });
    await expectIsolated(two, {
      create: async () => (await line(two.a.id)).id,
      read: (schoolId, id) => db().payslipLine.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().payslipLine.findMany({ where: { schoolId } }),
    });
    await refused(line(two.b.id));
    expect(b.principal.userId).not.toBe(a.principal.userId);
  });

  it('salary_advance_recoveries: invisible from another school; another school\'s advance or payslip is refused', async () => {
    const two = await createTwoSchools();
    const [a, b] = [await parents(two.a), await parents(two.b)];
    /** A finalised run's payslip of the clerk, and an open advance of the clerk. */
    const finalised = async (school: TestSchool, p: Parents) => {
      const slip = await payslip(school, p);
      await db().payrollRun.updateMany({ where: { schoolId: school.id, id: slip.runId }, data: { status: 'finalised', finalisedAt: new Date(), finalisedBy: p.principal.userId } });
      return { slip, advance: await advance(school, p) };
    };
    const [fa, fb] = [await finalised(two.a, a), await finalised(two.b, b)];
    const recover = (schoolId: TestSchool['id'], advanceId: bigint, payslipId: bigint, staffId: bigint) =>
      db().salaryAdvanceRecovery.create({ data: { schoolId, advanceId, payslipId, staffId, amount: 2000 } });
    await expectIsolated(two, {
      create: async () => (await recover(two.a.id, fa.advance.id, fa.slip.id, a.clerk.staffId)).id,
      read: (schoolId, id) => db().salaryAdvanceRecovery.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().salaryAdvanceRecovery.findMany({ where: { schoolId } }),
    });
    await refused(recover(two.b.id, fa.advance.id, fb.slip.id, b.clerk.staffId));
    await refused(recover(two.b.id, fb.advance.id, fa.slip.id, b.clerk.staffId));
  });
});
