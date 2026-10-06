// Control 4 / R62 for the slice-24 tables (migration 20261006100300_slice24_leave), through their
// repositories: leave_types and leave_requests, plus the day-sheet and cover reads. Composite
// foreign keys refuse a cross-school staff member or type at the database.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { LeaveRequestRepository } from '../../src/repositories/leave-request.repository';
import { LeaveTypeRepository } from '../../src/repositories/leave-type.repository';
import type { SchoolId } from '../../src/tenancy/school-id';
import { createTestApp } from '../core/app';
import { asSchool } from '../messaging/support';
import { expectIsolated } from '../support/isolation';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createTwoSchools, testDb } from '../support/schools';
import { day, isoDay } from '../support/students';

const db = () => testDb();

describe('slice 24 tenant isolation', () => {
  let app: NestExpressApplication;
  let types: LeaveTypeRepository;
  let requests: LeaveRequestRepository;
  const as = <T>(schoolId: SchoolId, fn: () => Promise<T>) => asSchool(app, schoolId, fn);

  beforeAll(async () => {
    app = await createTestApp();
    types = app.get(LeaveTypeRepository, { strict: false });
    requests = app.get(LeaveRequestRepository, { strict: false });
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const principalOf = (schoolId: SchoolId) =>
    createSchoolUser(db(), { id: schoolId, shortCode: '' }, { systemRole: 'principal' });

  it('leave_types: read, list, by name, archive see only their own school', async () => {
    const two = await createTwoSchools();
    let owner = 0n;
    await expectIsolated(two, {
      create: async (schoolId) => {
        const user = await principalOf(schoolId);
        owner = user.userId;
        const row = await as(schoolId, () =>
          types.create(schoolId, { name: 'Hajj leave', code: 'other', daysPerYear: 30, paid: true, createdBy: user.userId }),
        );
        return row.id;
      },
      read: (schoolId, id) => as(schoolId, () => types.findById(schoolId, id)),
      list: async (schoolId) => (await as(schoolId, () => types.list(schoolId, { skip: 0, take: 50 }))).rows,
      write: async (schoolId, id) => {
        await as(schoolId, () => types.archive(schoolId, id, owner));
        return 1;
      },
      snapshot: (row) => (row as { status: string }).status,
    });
    expect(await as(two.b.id, () => types.findLiveByName(two.b.id, 'Hajj leave'))).toBeNull();
    expect(await as(two.b.id, () => types.listActive(two.b.id))).toEqual([]);
  });

  it('leave_requests: read, list, overlap, balance and day-sheet reads and every status write see only their own school', async () => {
    const two = await createTwoSchools();
    let staffOfA = 0n;
    let userOfA = 0n;
    await expectIsolated(two, {
      create: async (schoolId) => {
        const user = await principalOf(schoolId);
        staffOfA = user.staffId;
        userOfA = user.userId;
        const type = await as(schoolId, () =>
          types.create(schoolId, { name: 'Casual', code: 'casual', daysPerYear: 10, paid: true, createdBy: user.userId }),
        );
        const row = await as(schoolId, () =>
          requests.create(schoolId, {
            staffId: user.staffId,
            leaveTypeId: type.id,
            startsOn: day(isoDay(1)),
            endsOn: day(isoDay(2)),
            workingDays: 2,
            reason: 'Family wedding',
            requestedBy: user.userId,
            onBehalf: false,
          }),
        );
        return row.id;
      },
      read: (schoolId, id) => as(schoolId, () => requests.findById(schoolId, id)),
      list: async (schoolId) =>
        (await as(schoolId, () => requests.list(schoolId, { sort: '-requestedAt', skip: 0, take: 50 }))).rows,
      write: async (schoolId, id) =>
        as(schoolId, async () =>
          (await requests.cancel(schoolId, id, 'pending', userOfA, 'Hijacked')) +
          (await requests.decide(schoolId, id, { status: 'rejected', decidedBy: userOfA, decisionReason: 'Hijacked', selfApproved: false, coverAssignmentId: null })),
        ),
      snapshot: (row) => (row as { status: string }).status,
    });
    const b = two.b.id;
    expect(await as(b, () => requests.findLiveOverlapping(b, staffOfA, day(isoDay(0)), day(isoDay(5))))).toBeNull();
    expect(await as(b, () => requests.forStaffInRange(b, staffOfA, ['pending'], day(isoDay(0)), day(isoDay(5))))).toEqual([]);
    expect(await as(b, () => requests.takenOn(b, day(isoDay(1)), [staffOfA]))).toEqual([]);
    expect(await as(b, () => requests.list(b, { staffId: staffOfA, sort: 'startsOn', skip: 0, take: 50 }))).toEqual({ rows: [], total: 0 });
    expect((await as(b, () => requests.staffNames(b, [staffOfA]))).size).toBe(0);
    expect((await as(b, () => requests.userNames(b, [userOfA]))).size).toBe(0);
    expect(await as(b, () => requests.classTeacherRows(b, [staffOfA], day(isoDay(0)), day(isoDay(5))))).toEqual([]);
    // The owner still sees it pending and live.
    const a = two.a.id;
    expect(await as(a, () => requests.findLiveOverlapping(a, staffOfA, day(isoDay(0)), day(isoDay(5))))).not.toBeNull();
  });

  it('a request naming another school\'s staff member or leave type is refused by the composite foreign keys', async () => {
    const two = await createTwoSchools();
    const a = await principalOf(two.a.id);
    const bUser = await principalOf(two.b.id);
    const typeOfB = await as(two.b.id, () =>
      types.create(two.b.id, { name: 'Casual', code: 'casual', daysPerYear: 10, paid: true, createdBy: bUser.userId }),
    );
    await expect(
      as(two.a.id, () =>
        requests.create(two.a.id, {
          staffId: a.staffId,
          leaveTypeId: typeOfB.id,
          startsOn: day(isoDay(1)),
          endsOn: day(isoDay(1)),
          workingDays: 1,
          reason: 'Cross school',
          requestedBy: a.userId,
          onBehalf: false,
        }),
      ),
    ).rejects.toThrow();
  });
});
