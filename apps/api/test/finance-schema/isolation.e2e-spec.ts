// Control 4 / R62 for the wave I tables (migrations 20261006100100_slice19_charges to
// 20261006100400_slice26_platform_billing), at the database: a row written for school A is not
// found by a school-B query and not changed by a school-B write, and every composite foreign key
// refuses another school's parent. The build agents of slices 19, 23, 24 and 26 add the
// repository-level probes beside their repositories; these hold the schema to the same standard
// from the day the tables exist.
import { closeTestDb, createSchool, createTwoSchools, testDb, type TestSchool } from '../support/schools';
import { expectIsolated } from '../support/isolation';
import { createSchoolUser } from '../support/school-session';
import { createClassWithSection, createStudent, enrol, isoDay, day } from '../support/students';

const db = () => testDb();

/** One school's parents of every wave I row: a principal, a year, class, section, enrolled student and a head. */
async function parents(school: TestSchool) {
  const principal = await createSchoolUser(db(), school, { systemRole: 'principal' });
  const { year, klass, section } = await createClassWithSection(db(), school);
  const student = await createStudent(db(), school);
  const enrolment = await enrol(db(), school, student, section);
  const head = await db().feeHead.create({
    data: { schoolId: school.id, name: `Head ${principal.userId}`, category: 'other', frequency: 'monthly', concessionEligible: true, refundable: true, createdBy: principal.userId },
  });
  const leaveType = await db().leaveType.create({
    data: { schoolId: school.id, name: `Type ${principal.userId}`, code: 'casual', daysPerYear: 10, paid: true, createdBy: principal.userId },
  });
  return { principal, year, klass, section, student, enrolment, head, leaveType };
}
type Parents = Awaited<ReturnType<typeof parents>>;

const period = isoDay().slice(0, 7);

const charge = (school: TestSchool, p: Parents) =>
  db().charge.create({
    data: {
      schoolId: school.id, enrolmentId: p.enrolment.id, studentId: p.student.id, academicYearId: p.year.id,
      feeHeadId: p.head.id, headFrequency: 'monthly', kind: 'manual', period, grossAmount: 1000, amount: 1000,
      description: 'Bus fare', dueOn: day(isoDay()), createdBy: p.principal.userId,
    },
  });

const concession = (school: TestSchool, p: Parents) =>
  db().concession.create({
    data: {
      schoolId: school.id, studentId: p.student.id, academicYearId: p.year.id, enrolmentId: p.enrolment.id,
      kind: 'percentage', value: 50, effectiveFrom: period, reason: 'Sibling', requestedBy: p.principal.userId,
    },
  });

const campaign = (school: TestSchool, p: Parents) =>
  db().chargeCampaign.create({
    data: {
      schoolId: school.id, name: 'Exam fee', academicYearId: p.year.id, feeHeadId: p.head.id, amount: 500,
      dueOn: day(isoDay(10)), createdBy: p.principal.userId,
    },
  });

/** Refused by the database (a composite FK naming school B's parent from school A, or a CHECK). */
const refused = (write: Promise<unknown>) => expect(write).rejects.toThrow();

describe('wave I tenant isolation (database level)', () => {
  afterAll(() => closeTestDb());

  it('concessions: invisible and unwritable from another school; the enrolment must be the school\'s own', async () => {
    const two = await createTwoSchools();
    const [a, b] = [await parents(two.a), await parents(two.b)];
    await expectIsolated(two, {
      create: async () => (await concession(two.a, a)).id,
      read: (schoolId, id) => db().concession.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().concession.findMany({ where: { schoolId } }),
      write: async (schoolId, id) => (await db().concession.updateMany({ where: { schoolId, id }, data: { status: 'rejected', decidedAt: new Date(), decidedBy: b.principal.userId, decisionReason: 'No' } })).count,
      snapshot: (row) => (row as { status: string }).status,
    });
    await refused(concession(two.b, { ...b, enrolment: a.enrolment, student: a.student, year: a.year }));
  });

  it('concession_heads: invisible from another school; a head of another school is refused', async () => {
    const two = await createTwoSchools();
    const [a, b] = [await parents(two.a), await parents(two.b)];
    const concessionA = await concession(two.a, a);
    await expectIsolated(two, {
      create: async () => (await db().concessionHead.create({ data: { schoolId: two.a.id, concessionId: concessionA.id, feeHeadId: a.head.id } })).id,
      read: (schoolId, id) => db().concessionHead.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().concessionHead.findMany({ where: { schoolId } }),
    });
    const concessionB = await concession(two.b, b);
    await refused(db().concessionHead.create({ data: { schoolId: two.b.id, concessionId: concessionB.id, feeHeadId: a.head.id } }));
    await refused(db().concessionHead.create({ data: { schoolId: two.b.id, concessionId: concessionA.id, feeHeadId: b.head.id } }));
  });

  it('charge_runs: invisible and unwritable from another school; the year must be the school\'s own', async () => {
    const two = await createTwoSchools();
    const [a, b] = [await parents(two.a), await parents(two.b)];
    await expectIsolated(two, {
      create: async () => (await db().chargeRun.create({ data: { schoolId: two.a.id, academicYearId: a.year.id, period, kind: 'monthly', triggeredBy: a.principal.userId } })).id,
      read: (schoolId, id) => db().chargeRun.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().chargeRun.findMany({ where: { schoolId } }),
      write: async (schoolId, id) => (await db().chargeRun.updateMany({ where: { schoolId, id }, data: { status: 'running', startedAt: new Date() } })).count,
      snapshot: (row) => (row as { status: string }).status,
    });
    await refused(db().chargeRun.create({ data: { schoolId: two.b.id, academicYearId: a.year.id, period, kind: 'monthly', triggeredBy: b.principal.userId } }));
  });

  it('charge_campaigns: invisible and unwritable from another school; the head must be the school\'s own', async () => {
    const two = await createTwoSchools();
    const [a, b] = [await parents(two.a), await parents(two.b)];
    await expectIsolated(two, {
      create: async () => (await campaign(two.a, a)).id,
      read: (schoolId, id) => db().chargeCampaign.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().chargeCampaign.findMany({ where: { schoolId } }),
      write: async (schoolId, id) => (await db().chargeCampaign.updateMany({ where: { schoolId, id }, data: { name: 'Hijacked' } })).count,
      snapshot: (row) => (row as { name: string }).name,
    });
    await refused(campaign(two.b, { ...b, head: a.head }));
  });

  it('charge_campaign_audiences: invisible from another school; a class of another school is refused', async () => {
    const two = await createTwoSchools();
    const [a, b] = [await parents(two.a), await parents(two.b)];
    const campaignA = await campaign(two.a, a);
    await expectIsolated(two, {
      create: async () => (await db().chargeCampaignAudience.create({ data: { schoolId: two.a.id, campaignId: campaignA.id, kind: 'class', classId: a.klass.id } })).id,
      read: (schoolId, id) => db().chargeCampaignAudience.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().chargeCampaignAudience.findMany({ where: { schoolId } }),
    });
    const campaignB = await campaign(two.b, b);
    await refused(db().chargeCampaignAudience.create({ data: { schoolId: two.b.id, campaignId: campaignB.id, kind: 'class', classId: a.klass.id } }));
  });

  it('charges: invisible and unwritable from another school; the enrolment, head and concession must be the school\'s own', async () => {
    const two = await createTwoSchools();
    const [a, b] = [await parents(two.a), await parents(two.b)];
    await expectIsolated(two, {
      create: async () => (await charge(two.a, a)).id,
      read: (schoolId, id) => db().charge.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().charge.findMany({ where: { schoolId } }),
      write: async (schoolId, id) => (await db().charge.updateMany({ where: { schoolId, id }, data: { status: 'voided', voidedAt: new Date(), voidedBy: b.principal.userId, voidReason: 'Hijacked' } })).count,
      snapshot: (row) => (row as { status: string }).status,
    });
    await refused(charge(two.b, { ...b, enrolment: a.enrolment, student: a.student, year: a.year }));
    await refused(charge(two.b, { ...b, head: a.head }));
    const concessionA = await concession(two.a, a);
    await refused(
      db().charge.create({
        data: {
          schoolId: two.b.id, enrolmentId: b.enrolment.id, studentId: b.student.id, academicYearId: b.year.id, feeHeadId: b.head.id,
          headFrequency: 'monthly', kind: 'manual', concessionId: concessionA.id, grossAmount: 10, amount: 10, description: 'X', dueOn: day(isoDay()),
        },
      }),
    );
  });

  it('expenses: invisible and unwritable from another school; the recorder must be the school\'s own', async () => {
    const two = await createTwoSchools();
    const [a, b] = [await parents(two.a), await parents(two.b)];
    const expense = (schoolId: TestSchool['id'], recordedBy: bigint, expenseNo: number) =>
      db().expense.create({
        data: { schoolId, expenseNo, category: 'stationery', amount: 300, spentOn: day(isoDay()), description: 'Chalk', method: 'cash', status: 'recorded', recordedBy },
      });
    await expectIsolated(two, {
      create: async () => (await expense(two.a.id, a.principal.userId, 1)).id,
      read: (schoolId, id) => db().expense.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().expense.findMany({ where: { schoolId } }),
      write: async (schoolId, id) => (await db().expense.updateMany({ where: { schoolId, id }, data: { amount: 1 } })).count,
      snapshot: (row) => (row as { amount: number }).amount,
    });
    await refused(expense(two.b.id, a.principal.userId, 1));
    expect(b.principal.userId).not.toBe(a.principal.userId);
  });

  it('leave_types: invisible and unwritable from another school; the seed writes only the school it names', async () => {
    const two = await createTwoSchools();
    const a = await parents(two.a);
    await expectIsolated(two, {
      create: () => Promise.resolve(a.leaveType.id),
      read: (schoolId, id) => db().leaveType.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().leaveType.findMany({ where: { schoolId } }),
      write: async (schoolId, id) => (await db().leaveType.updateMany({ where: { schoolId, id }, data: { status: 'archived', archivedAt: new Date(), archivedBy: a.principal.userId } })).count,
      snapshot: (row) => (row as { status: string }).status,
    });
    const school = await createSchool();
    const other = await createSchool();
    await db().$executeRaw`SELECT asms_seed_school_finance(${school.id}::bigint)`;
    expect(await db().leaveType.count({ where: { schoolId: school.id, createdBy: null } })).toBe(3);
    expect(await db().leaveType.count({ where: { schoolId: other.id } })).toBe(0);
  });

  it('leave_requests: invisible and unwritable from another school; the staff member and type must be the school\'s own', async () => {
    const two = await createTwoSchools();
    const [a, b] = [await parents(two.a), await parents(two.b)];
    const request = (schoolId: TestSchool['id'], p: Parents, staffId: bigint, leaveTypeId: bigint) =>
      db().leaveRequest.create({
        data: { schoolId, staffId, leaveTypeId, startsOn: day(isoDay(30)), endsOn: day(isoDay(31)), workingDays: 2, reason: 'Wedding', requestedBy: p.principal.userId },
      });
    await expectIsolated(two, {
      create: async () => (await request(two.a.id, a, a.principal.staffId, a.leaveType.id)).id,
      read: (schoolId, id) => db().leaveRequest.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().leaveRequest.findMany({ where: { schoolId } }),
      write: async (schoolId, id) => (await db().leaveRequest.updateMany({ where: { schoolId, id }, data: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: b.principal.userId, cancelReason: 'Hijacked' } })).count,
      snapshot: (row) => (row as { status: string }).status,
    });
    await refused(request(two.b.id, b, a.principal.staffId, b.leaveType.id));
    await refused(request(two.b.id, b, b.principal.staffId, a.leaveType.id));
  });

  // ---- the platform billing tables: non-tenant (NON_TENANT_MODELS), each row naming one school.

  async function plan() {
    const min = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
    return db().platformPlan.create({ data: { name: `Tier ${min}`, minStudents: min, maxStudents: min, monthlyPrice: 5000, smsAllowance: 500, status: 'archived', archivedAt: new Date() } });
  }

  it('platform_subscriptions: a non-tenant row per school; one live row per school; another school\'s filter finds nothing', async () => {
    const two = await createTwoSchools();
    const p = await plan();
    const row = await db().platformSubscription.create({ data: { schoolId: two.a.id, planId: p.id, startedOn: day(isoDay()) } });
    expect(await db().platformSubscription.findFirst({ where: { schoolId: two.b.id, id: row.id } })).toBeNull();
    expect(await db().platformSubscription.findFirst({ where: { schoolId: two.a.id, id: row.id } })).not.toBeNull();
    await refused(db().platformSubscription.create({ data: { schoolId: two.a.id, planId: p.id, startedOn: day(isoDay()) } }));
  });

  it('platform_school_metrics: a non-tenant rollup, one row per school and day', async () => {
    const two = await createTwoSchools();
    const row = await db().platformSchoolMetric.create({ data: { schoolId: two.a.id, day: day(isoDay()), activeStudents: 42, computedAt: new Date() } });
    expect(await db().platformSchoolMetric.findFirst({ where: { schoolId: two.b.id, id: row.id } })).toBeNull();
    await refused(db().platformSchoolMetric.create({ data: { schoolId: two.a.id, day: day(isoDay()), activeStudents: 1, computedAt: new Date() } }));
    expect(await db().platformSchoolMetric.create({ data: { schoolId: two.b.id, day: day(isoDay()), activeStudents: 1, computedAt: new Date() } })).toBeTruthy();
  });

  it('platform_invoices: a non-tenant row per school; one non-void invoice per school per month', async () => {
    const two = await createTwoSchools();
    const p = await plan();
    const no = () => `INV-${1000 + Math.floor(Math.random() * 9000)}-${String(Math.floor(Math.random() * 100_000)).padStart(5, "0")}`;
    const invoice = (schoolId: TestSchool['id']) =>
      db().platformInvoice.create({ data: { schoolId, invoiceNo: no(), yearMonth: '2026-10', planId: p.id, studentCount: 10, amount: 5000, dueOn: day('2026-10-10') } });
    const row = await invoice(two.a.id);
    expect(await db().platformInvoice.findFirst({ where: { schoolId: two.b.id, id: row.id } })).toBeNull();
    await refused(invoice(two.a.id));
    expect(await invoice(two.b.id)).toBeTruthy();
  });
});
