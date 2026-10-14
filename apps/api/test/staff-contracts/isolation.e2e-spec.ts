// Control 4 / R62 for staff_contracts (slice 39, migration 20261010090000_wave_s_events_contracts)
// through StaffContractRepository: every read, list, end, stamp and the job's candidate read see
// only their own school. The composite foreign keys refuse another school's staff member.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { StaffContractRepository } from '../../src/repositories/staff-contract.repository';
import type { SchoolId } from '../../src/tenancy/school-id';
import { createTestApp } from '../core/app';
import { asSchool } from '../messaging/support';
import { expectIsolated } from '../support/isolation';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createTwoSchools, testDb } from '../support/schools';
import { day } from '../support/students';

const db = () => testDb();

describe('slice 39 tenant isolation', () => {
  let app: NestExpressApplication;
  let contracts: StaffContractRepository;
  const as = <T>(schoolId: SchoolId, fn: () => Promise<T>) => asSchool(app, schoolId, fn);

  beforeAll(async () => {
    app = await createTestApp();
    contracts = app.get(StaffContractRepository, { strict: false });
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  /** The staff member each school's probe contract belongs to, by school id. */
  const staffOf: Record<string, bigint> = {};
  const newContract = async (schoolId: SchoolId): Promise<bigint> => {
    const user = await createSchoolUser(db(), { id: schoolId, shortCode: '' }, { systemRole: 'principal' });
    staffOf[schoolId.toString()] = user.staffId;
    return as(schoolId, () =>
      contracts.create(schoolId, {
        staffId: user.staffId,
        type: 'fixed_term',
        startsOn: day('2026-01-01'),
        endsOn: day('2026-12-31'),
        salaryStructureId: null,
        document: null,
        note: null,
        createdBy: user.userId,
      }),
    );
  };

  it('staff_contracts: read, list, live, ending, unwarned, end and stamp see only their own school', async () => {
    const two = await createTwoSchools();
    await expectIsolated(two, {
      create: newContract,
      read: (schoolId, id) => as(schoolId, () => contracts.findById(schoolId, id)),
      list: async (schoolId) => (await as(schoolId, () => contracts.liveEndingBy(schoolId, day('2027-01-01'), { skip: 0, take: 50 }))).rows,
      write: async (schoolId, id) => {
        const user = await createSchoolUser(db(), { id: schoolId, shortCode: '' }, { systemRole: 'principal' });
        return as(schoolId, () => contracts.end(schoolId, id, { endedBy: user.userId, reason: 'Probe', endedOn: day('2026-06-30'), now: new Date() }));
      },
      snapshot: (row) => (row as { endedAt: Date | null }).endedAt,
    });
    const staffA = staffOf[two.a.id.toString()] ?? 0n;
    // The owner's staff id, asked as school B, finds nothing.
    expect(await as(two.b.id, () => contracts.findLive(two.b.id, staffA))).toBeNull();
    expect((await as(two.b.id, () => contracts.listForStaff(two.b.id, staffA, { skip: 0, take: 50 }))).total).toBe(0);
    expect(await as(two.b.id, () => contracts.unwarned(two.b.id, 'warned30At', day('2026-01-01'), day('2027-01-01')))).toEqual([]);
    const [own] = (await as(two.a.id, () => contracts.listForStaff(two.a.id, staffA, { skip: 0, take: 50 }))).rows;
    expect(await as(two.b.id, () => contracts.stamp(two.b.id, own?.id ?? 0n, 'warned30At', new Date()))).toBe(0);
    expect((await as(two.a.id, () => contracts.findById(two.a.id, own?.id ?? 0n)))?.warned30At).toBeNull();
  });

  it('the database refuses a contract for another school’s staff member', async () => {
    const two = await createTwoSchools();
    const a = await createSchoolUser(db(), two.a, { systemRole: 'principal' });
    const b = await createSchoolUser(db(), two.b, { systemRole: 'principal' });
    await expect(
      as(two.b.id, () =>
        contracts.create(two.b.id, {
          staffId: a.staffId,
          type: 'permanent',
          startsOn: day('2026-01-01'),
          endsOn: null,
          salaryStructureId: null,
          document: null,
          note: null,
          createdBy: b.userId,
        }),
      ),
    ).rejects.toThrow();
  });
});
