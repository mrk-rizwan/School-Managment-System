// Control 4 / R62 for the slice-18 tables (migration 20261005182000_slice18_fee_setup), through
// their repositories, plus the one raw statement (FeeHeadRepository.seedForSchool, eslint
// RAW_SQL_FILES) and R232's own-child predicate. Composite foreign keys refuse a cross-school
// parent at the database.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { FeeHeadRepository } from '../../src/repositories/fee-head.repository';
import { FeeStructureRepository } from '../../src/repositories/fee-structure.repository';
import { PaymentAccountRepository } from '../../src/repositories/payment-account.repository';
import { StudentGuardianRepository } from '../../src/repositories/student-guardian.repository';
import type { SchoolId } from '../../src/tenancy/school-id';
import { createTestApp } from '../core/app';
import { asSchool } from '../messaging/support';
import { createGuardianUser } from '../school-auth/support';
import { expectIsolated } from '../support/isolation';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, createTwoSchools, testDb } from '../support/schools';
import { createAcademicYear, createClass, createStudent, linkGuardian } from '../support/students';

const db = () => testDb();

describe('slice 18 tenant isolation', () => {
  let app: NestExpressApplication;
  let heads: FeeHeadRepository;
  let structures: FeeStructureRepository;
  let accounts: PaymentAccountRepository;
  let links: StudentGuardianRepository;
  const as = <T>(schoolId: SchoolId, fn: () => Promise<T>) => asSchool(app, schoolId, fn);

  beforeAll(async () => {
    app = await createTestApp();
    heads = app.get(FeeHeadRepository, { strict: false });
    structures = app.get(FeeStructureRepository, { strict: false });
    accounts = app.get(PaymentAccountRepository, { strict: false });
    links = app.get(StudentGuardianRepository, { strict: false });
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const principalOf = (schoolId: SchoolId) =>
    createSchoolUser(db(), { id: schoolId, shortCode: '' }, { systemRole: 'principal' });

  it('fee_heads: read, list, update and the seed function see only their own school', async () => {
    const two = await createTwoSchools();
    await expectIsolated(two, {
      create: async (schoolId) => {
        const user = await principalOf(schoolId);
        const row = await as(schoolId, () =>
          heads.create(schoolId, { name: 'Transport', category: 'other', frequency: 'monthly', concessionEligible: true, refundable: true, createdBy: user.userId }),
        );
        return row.id;
      },
      read: (schoolId, id) => as(schoolId, () => heads.findById(schoolId, id)),
      list: async (schoolId) => (await as(schoolId, () => heads.list(schoolId, { sort: 'name', skip: 0, take: 50 }))).rows,
      write: async (schoolId, id) => {
        await as(schoolId, () => heads.update(schoolId, id, { name: 'Hijacked' }));
        return 1;
      },
      snapshot: (row) => (row as { name: string }).name,
    });
    // The seed writes only the school it names.
    await as(two.a.id, () => heads.seedForSchool(two.a.id));
    // Seven, not the eight of SEEDED_FEE_HEADS: school A's own live head named "Transport" keeps the
    // seeded Transport head out (Phase 5's per-name guard, migration 20261009120100_phase5_groundwork).
    expect(await db().feeHead.count({ where: { schoolId: two.a.id, createdBy: null } })).toBe(7);
    expect(await db().feeHead.count({ where: { schoolId: two.b.id } })).toBe(0);
  });

  it('fee_structures: read, the grid and the active rows see only their own school; a foreign class or head is refused', async () => {
    const two = await createTwoSchools();
    let classOfA = 0n;
    await expectIsolated(two, {
      create: async (schoolId) => {
        const user = await principalOf(schoolId);
        const school = { id: schoolId, shortCode: '' };
        const year = await createAcademicYear(db(), school);
        const cls = await createClass(db(), school, year);
        classOfA = cls.id;
        const head = await as(schoolId, () =>
          heads.create(schoolId, { name: 'Tuition', category: 'tuition', frequency: 'monthly', concessionEligible: true, refundable: true, createdBy: user.userId }),
        );
        const row = await as(schoolId, () =>
          structures.create(schoolId, { academicYearId: year.id, classId: cls.id, feeHeadId: head.id, amount: 3000, effectiveFrom: year.startsOn.slice(0, 7), reason: null, createdBy: user.userId }),
        );
        return row.id;
      },
      read: (schoolId, id) => as(schoolId, () => structures.findById(schoolId, id)),
      write: (schoolId, id) => as(schoolId, () => structures.markSuperseded(schoolId, id)),
      snapshot: (row) => (row as { status: string }).status,
    });
    const row = await db().feeStructure.findFirstOrThrow({ where: { schoolId: two.a.id } });
    expect(await as(two.b.id, () => structures.activeFor(two.b.id, row.classId, row.feeHeadId))).toEqual([]);
    expect(await as(two.b.id, () => structures.forClasses(two.b.id, row.academicYearId, [classOfA]))).toEqual([]);
    // School B cannot point a row of its own at A's class or head (composite foreign keys).
    const userB = await principalOf(two.b.id);
    await expect(
      db().feeStructure.create({
        data: { schoolId: two.b.id, academicYearId: row.academicYearId, classId: row.classId, feeHeadId: row.feeHeadId, amount: 1, effectiveFrom: '2026-04', createdBy: userB.userId },
      }),
    ).rejects.toThrow();
  });

  it('school_payment_accounts: read, list, the claim switch and disable see only their own school', async () => {
    const two = await createTwoSchools();
    await expectIsolated(two, {
      create: async (schoolId) => {
        const user = await principalOf(schoolId);
        const row = await as(schoolId, () =>
          accounts.create(schoolId, { kind: 'jazzcash', title: 'School', accountNo: '03001234567', bankName: null, createdBy: user.userId }),
        );
        return row.id;
      },
      read: (schoolId, id) => as(schoolId, () => accounts.findById(schoolId, id)),
      list: async (schoolId) => (await as(schoolId, () => accounts.list(schoolId, { skip: 0, take: 50 }))).rows,
      write: (schoolId, id) => as(schoolId, () => accounts.disable(schoolId, id, 1n, 'Hijacked')),
      snapshot: (row) => (row as { status: string }).status,
    });
    expect(await as(two.a.id, () => accounts.anyActive(two.a.id))).toBe(true);
    expect(await as(two.b.id, () => accounts.anyActive(two.b.id))).toBe(false);
  });

  it('R232: actorIsGuardianOf is true only for a live link of the user\'s guardian, merge-resolved, in the same school', async () => {
    const school = await createSchool();
    const student = await createStudent(db(), school);
    const parent = await createGuardianUser(db(), school);
    const stranger = await createGuardianUser(db(), school);
    const staff = await principalOf(school.id);
    const check = (userId: bigint) => as(school.id, () => links.userIsLiveGuardianOf(school.id, userId, student.id));

    expect(await check(parent.userId)).toBe(false);
    const link = await linkGuardian(db(), school, student, { id: parent.guardianId }, { canLogin: false });
    expect(await check(parent.userId)).toBe(true);
    expect(await check(stranger.userId)).toBe(false);
    expect(await check(staff.userId)).toBe(false);
    // Merge-resolved: the stranger's record merged into the parent's counts as the parent.
    await db().guardian.updateMany({
      where: { schoolId: school.id, id: stranger.guardianId },
      data: { status: 'merged', mergedIntoId: parent.guardianId, cnic: null, cnicHash: null },
    });
    expect(await check(stranger.userId)).toBe(true);
    // An ended link no longer counts.
    await db().studentGuardian.updateMany({ where: { schoolId: school.id, id: link.id }, data: { endedAt: new Date() } });
    expect(await check(parent.userId)).toBe(false);
    // Another school's tenant sees nothing.
    const other = await createSchool();
    expect(await as(other.id, () => links.userIsLiveGuardianOf(other.id, parent.userId, student.id))).toBe(false);
  });
});
