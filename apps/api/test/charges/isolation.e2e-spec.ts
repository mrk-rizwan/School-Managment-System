// Control 4 / R62 for slice 19's repositories over the wave-I tables (charges, concessions,
// charge_runs, charge_campaigns), and every raw statement of the three RAW_SQL_FILES slice 19
// added (charge.repository.ts, concession.repository.ts, charge-generation.repository.ts): run as
// school B against school A's ids, each reads nothing, locks nothing and writes nothing.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ChargeCampaignRepository } from '../../src/repositories/charge-campaign.repository';
import { ChargeGenerationRepository } from '../../src/repositories/charge-generation.repository';
import { ChargeRepository } from '../../src/repositories/charge.repository';
import { ChargeRunRepository } from '../../src/repositories/charge-run.repository';
import { ConcessionRepository } from '../../src/repositories/concession.repository';
import type { SchoolId } from '../../src/tenancy/school-id';
import { createTestApp } from '../core/app';
import { asSchool, tx } from '../messaging/support';
import { expectIsolated } from '../support/isolation';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, type TestSchool } from '../support/schools';
import { day } from '../support/students';
import { classWithSection, db, financeSchool, karachi, pupil, runMonth, session2026, structure } from '../fees/charges-support';

describe('slice 19 tenant isolation (repositories and raw statements)', () => {
  let app: NestExpressApplication;
  let charges: ChargeRepository;
  let runs: ChargeRunRepository;
  let generation: ChargeGenerationRepository;
  let concessions: ConcessionRepository;
  let campaigns: ChargeCampaignRepository;
  const as = <T>(schoolId: SchoolId, fn: () => Promise<T>) => asSchool(app, schoolId, () => tx.run(fn));

  beforeAll(async () => {
    app = await createTestApp();
    charges = app.get(ChargeRepository, { strict: false });
    runs = app.get(ChargeRunRepository, { strict: false });
    generation = app.get(ChargeGenerationRepository, { strict: false });
    concessions = app.get(ConcessionRepository, { strict: false });
    campaigns = app.get(ChargeCampaignRepository, { strict: false });
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  /** School A with a priced class, a child and October generated; school B empty. */
  async function twoSchools() {
    const a = await financeSchool({}, 'School A');
    const b = await financeSchool({}, 'School B');
    const principal = await createSchoolUser(db(), a.school, { systemRole: 'principal' });
    const year = await session2026(a.school);
    const { classId, section } = await classWithSection(a.school, year);
    await structure(a.school, { academicYearId: year.id, classId, feeHeadId: a.heads.tuition, amount: 3000, effectiveFrom: '2026-04' }, principal.userId);
    const child = await pupil(a.school, section, { startedOn: '2026-04-01' });
    await runMonth(app, a.school, year, '2026-10', karachi('2026-10-01'));
    const charge = await db().charge.findFirstOrThrow({ where: { schoolId: a.school.id } });
    return { a, b, principal, year, classId, section, child, charge, two: { a: a.school, b: b.school } };
  }

  it('charges: read, list, lock, void and the statement see only their own school', async () => {
    const w = await twoSchools();
    await expectIsolated(w.two, {
      create: () => Promise.resolve(w.charge.id),
      read: (schoolId, id) => as(schoolId, () => charges.findById(schoolId, id)),
      list: async (schoolId) => (await as(schoolId, () => charges.list(schoolId, { sort: '-dueOn', skip: 0, take: 50 }))).rows,
      write: (schoolId, id) => as(schoolId, () => charges.void(schoolId, id, w.principal.userId, 'Hijack', new Date())),
      snapshot: (row) => (row as { status: string }).status,
    });
    // FOR UPDATE: B locks none of A's rows.
    expect(await as(w.b.school.id, () => charges.lockForUpdate(w.b.school.id, [w.charge.id]))).toEqual([]);
    expect(await as(w.a.school.id, () => charges.lockForUpdate(w.a.school.id, [w.charge.id]))).toEqual([w.charge.id]);
    expect(await as(w.b.school.id, () => charges.studentExists(w.b.school.id, w.child.studentId))).toBe(false);
    expect(await as(w.b.school.id, () => charges.enrolmentForCharge(w.b.school.id, w.child.enrolmentId))).toBeNull();
    expect(await as(w.b.school.id, () => charges.totals(w.b.school.id, w.child.studentId, w.year.id))).toEqual({
      charged: 0, concession: 0, adjustments: 0, paid: 0, outstanding: 0,
    });
  });

  it('concessions: read, list, the student lock and the live check see only their own school', async () => {
    const w = await twoSchools();
    await expectIsolated(w.two, {
      create: async (schoolId) => {
        const id = await as(schoolId, () =>
          concessions.create(schoolId, {
            studentId: w.child.studentId, academicYearId: w.year.id, enrolmentId: w.child.enrolmentId, kind: 'percentage', value: 10,
            effectiveFrom: '2026-10', reason: 'Hardship', requestedBy: w.principal.userId, feeHeadIds: [w.a.heads.tuition], approved: null,
          }),
        );
        return id;
      },
      read: (schoolId, id) => as(schoolId, () => concessions.findById(schoolId, id)),
      list: async (schoolId) => (await as(schoolId, () => concessions.list(schoolId, { sort: '-requestedAt', skip: 0, take: 50 }))).rows,
      write: (schoolId, id) => as(schoolId, () => concessions.end(schoolId, id, w.principal.userId, 'Hijack', new Date())),
      snapshot: (row) => (row as { status: string }).status,
    });
    expect(await as(w.b.school.id, () => concessions.lockStudent(w.b.school.id, w.child.studentId))).toBe(false);
    expect(await as(w.a.school.id, () => concessions.lockStudent(w.a.school.id, w.child.studentId))).toBe(true);
    expect(await as(w.b.school.id, () => concessions.findLiveOnHeads(w.b.school.id, w.child.studentId, w.year.id, [w.a.heads.tuition]))).toBeNull();
  });

  it('charge_runs: read, list, claim and the stale sweep see only their own school', async () => {
    const w = await twoSchools();
    await expectIsolated(w.two, {
      create: async (schoolId) =>
        (await as(schoolId, () =>
          runs.createQueued(schoolId, { academicYearId: w.year.id, period: '2026-11', kind: 'monthly', campaignId: null, triggeredBy: null, regenerateVoided: false, queuedAt: new Date(Date.now() - 60 * 60_000) }),
        )).id,
      read: (schoolId, id) => as(schoolId, () => runs.findById(schoolId, id)),
      list: async (schoolId) => (await as(schoolId, () => runs.list(schoolId, { skip: 0, take: 50 }))).rows,
      write: async (schoolId, id) => ((await as(schoolId, () => runs.claim(schoolId, id, new Date()))) ? 1 : 0),
      snapshot: (row) => (row as { status: string }).status,
    });
    expect(await as(w.b.school.id, () => runs.stale(w.b.school.id, new Date()))).toEqual([]);
    expect(await as(w.b.school.id, () => runs.findInProgress(w.b.school.id, w.year.id))).toBeNull();
  });

  it('charge_campaigns: read, list, moves and audience targets see only their own school', async () => {
    const w = await twoSchools();
    await expectIsolated(w.two, {
      create: (schoolId) =>
        as(schoolId, () =>
          campaigns.create(
            schoolId,
            { name: 'Trip', academicYearId: w.year.id, feeHeadId: w.a.heads.exam, amount: 500, dueOn: day('2026-12-01'), description: null, applyConcessions: false },
            [{ kind: 'class', targetId: w.classId }],
            w.principal.userId,
          ),
        ),
      read: (schoolId, id) => as(schoolId, () => campaigns.findById(schoolId, id)),
      list: async (schoolId) => (await as(schoolId, () => campaigns.list(schoolId, { skip: 0, take: 50 }))).rows,
      write: (schoolId, id) => as(schoolId, () => campaigns.move(schoolId, id, 'draft', 'generating')),
      snapshot: (row) => (row as { status: string }).status,
    });
    expect(await as(w.b.school.id, () => campaigns.targetEnrolments(w.b.school.id, w.year.id, [{ kind: 'everyone', targetId: null }]))).toEqual([]);
    expect(await as(w.b.school.id, () => campaigns.classesOfYear(w.b.school.id, w.year.id, [w.classId]))).toEqual([]);
  });

  it('charge generation: every raw statement run as another school reads and writes nothing of school A', async () => {
    const w = await twoSchools();
    const b: TestSchool = w.b.school;
    const g = {
      academicYearId: w.year.id, classId: w.classId, period: '2026-11', periodStart: '2026-11-01', periodEnd: '2026-11-30',
      cutoffDate: '2026-11-15', label: 'November 2026', dueOn: '2026-11-10', regenerateVoided: true,
      periodStartsAt: new Date('2026-10-31T19:00:00Z'),
    };
    const count = async () => (await db().charge.count({ where: { schoolId: w.a.school.id } })) + (await db().charge.count({ where: { schoolId: b.id } }));
    const before = await count();
    expect(await as(b.id, () => generation.classesToGenerate(b.id, g))).toEqual([]);
    expect(await as(b.id, () => generation.generateMonthly(b.id, g))).toEqual({ candidates: 0, inserted: [] });
    expect(await as(b.id, () => generation.generateYearly(b.id, g))).toEqual({ candidates: 0, inserted: [] });
    expect(
      await as(b.id, () =>
        generation.generateCampaign(b.id, {
          campaignId: 1n, academicYearId: w.year.id, feeHeadId: w.a.heads.exam, amount: 100, description: 'X', dueOn: '2026-12-01',
          period: '2026-11', applyConcessions: true, enrolmentIds: [w.child.enrolmentId],
        }),
      ),
    ).toEqual({ candidates: 0, inserted: [] });
    expect(await as(b.id, () => generation.lateFeeCandidates(b.id, { enabledOn: '2000-01-01', overdueBefore: '2100-01-01', today: '2000-01-01' }))).toEqual([]);
    expect((await as(b.id, () => generation.lateFeePeriods(b.id, [w.child.studentId]))).size).toBe(0);
    expect(await as(b.id, () => generation.feePayers(b.id, [w.child.studentId]))).toEqual([]);
    expect(await as(b.id, () => generation.onceStructures(b.id, w.classId, '2026-11'))).toEqual([]);
    expect(await as(b.id, () => generation.yearOf(b.id, w.year.id))).toBeNull();
    // A late fee naming A's charge, written as B, is refused by the composite foreign keys.
    await expect(
      as(b.id, () =>
        generation.insertLateFees(
          b.id,
          [{ targetId: w.charge.id, studentId: w.child.studentId, enrolmentId: w.child.enrolmentId, academicYearId: w.year.id, period: '2026-10' }],
          { id: w.b.heads.fine, frequency: 'ad_hoc' },
          500,
          '2026-10-20',
          new Map(),
        ),
      ),
    ).rejects.toThrow();
    // The shared head lock takes only the school's own rows.
    await as(b.id, () => generation.lockHeadsShared(b.id));
    expect(await count()).toBe(before);
  });
});
