// Control 4 / R62 for slice 41 through its repositories (contracts/slice-41.md): every
// TransportRepository read and write of vehicles, routes, stops, amounts and assignments, the
// family and driver reads, and TransportReadsRepository.riders (the charge job's raw read), as
// school A's row seen or changed by school B. The tables' composite foreign keys are proved in
// test/phase5/wave-t-isolation.e2e-spec.ts.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { TransportReadsRepository } from '../../src/repositories/transport-reads.repository';
import { TransportRepository } from '../../src/repositories/transport.repository';
import type { SchoolId } from '../../src/tenancy/school-id';
import { createTestApp } from '../core/app';
import { asSchool } from '../messaging/support';
import { expectIsolated, studentsScope } from '../support/isolation';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createTwoSchools, testDb } from '../support/schools';
import { createAcademicYear, createClass, createSection, createStudent, day, enrol } from '../support/students';

const db = () => testDb();

describe('slice 41 tenant isolation', () => {
  let app: NestExpressApplication;
  let transport: TransportRepository;
  let reads: TransportReadsRepository;
  const as = <T>(schoolId: SchoolId, fn: () => Promise<T>) => asSchool(app, schoolId, fn);

  beforeAll(async () => {
    app = await createTestApp();
    transport = app.get(TransportRepository, { strict: false });
    reads = app.get(TransportReadsRepository, { strict: false });
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  interface World {
    userId: bigint;
    staffId: bigint;
    vehicleId: bigint;
    routeId: bigint;
    stopId: bigint;
    amountId: bigint;
    assignmentId: bigint;
    studentId: bigint;
    yearId: bigint;
  }
  const worlds: { schoolId: SchoolId; world: World }[] = [];

  /** A school's van (driven by its principal), route with a stop and a future amount, and a rider. */
  const world = async (schoolId: SchoolId): Promise<World> => {
    const known = worlds.find((x) => x.schoolId === schoolId)?.world;
    if (known) return known;
    const school = { id: schoolId, shortCode: '' };
    const principal = await createSchoolUser(db(), school, { systemRole: 'principal' });
    const year = await createAcademicYear(db(), school, { startsOn: '2026-04-01', endsOn: '2027-12-31' });
    const section = await createSection(db(), school, await createClass(db(), school, year));
    const student = await createStudent(db(), school, { admittedOn: '2026-04-01' });
    const enrolment = await enrol(db(), school, student, section, { startedOn: '2026-04-01' });
    const vehicleId = await as(schoolId, () =>
      transport.createVehicle(schoolId, { registration: 'LES-1', capacity: 10, driverStaffId: principal.staffId, createdBy: principal.userId }),
    );
    const routeId = await as(schoolId, () => transport.createRoute(schoolId, { name: 'Route 1', vehicleId, createdBy: principal.userId }));
    await as(schoolId, () => transport.insertStops(schoolId, routeId, [{ sortOrder: 1, name: 'Stop 1', pickupTime: null }]));
    const [stop] = await as(schoolId, () => transport.liveStops(schoolId, routeId));
    await as(schoolId, () => transport.createAmount(schoolId, { routeId, effectivePeriod: '2026-04', amount: 1500, createdBy: principal.userId }));
    const amountId = await as(schoolId, () =>
      transport.createAmount(schoolId, { routeId, effectivePeriod: '2027-09', amount: 1800, createdBy: principal.userId }),
    );
    const assignmentId = await as(schoolId, () =>
      transport.createAssignment(schoolId, {
        studentId: student.id,
        academicYearId: year.id,
        enrolmentId: enrolment.id,
        routeId,
        stopId: stop?.id ?? null,
        startsOn: day('2026-04-01'),
        createdBy: principal.userId,
      }),
    );
    const w = {
      userId: principal.userId,
      staffId: principal.staffId,
      vehicleId,
      routeId,
      stopId: stop?.id ?? 0n,
      amountId,
      assignmentId,
      studentId: student.id,
      yearId: year.id,
    };
    worlds.push({ schoolId, world: w });
    return w;
  };
  const end = (w: World) => ({ by: w.userId, reason: 'Probe', now: new Date() });

  it('vehicles: read, list, update and retire see only their own school', async () => {
    const two = await createTwoSchools();
    const b = await world(two.b.id);
    await expectIsolated(two, {
      create: async (schoolId) => (await world(schoolId)).vehicleId,
      read: (schoolId, id) => as(schoolId, () => transport.findVehicle(schoolId, id)),
      list: async (schoolId) => (await as(schoolId, () => transport.listVehicles(schoolId, { skip: 0, take: 50 }))).rows,
      write: (schoolId, id) => as(schoolId, () => transport.updateVehicle(schoolId, id, { capacity: 99 })),
      snapshot: (row) => (row as { capacity: number }).capacity,
    });
    const a = await world(two.a.id);
    expect(await as(two.b.id, () => transport.retireVehicle(two.b.id, a.vehicleId, end(b)))).toBe(0);
    expect(await as(two.b.id, () => transport.activeRoutesOfVehicle(two.b.id, a.vehicleId))).toEqual([]);
  });

  it('routes and stops: read, list, update, archive, stops and in-use see only their own school', async () => {
    const two = await createTwoSchools();
    const b = await world(two.b.id);
    await expectIsolated(two, {
      create: async (schoolId) => (await world(schoolId)).routeId,
      read: (schoolId, id) => as(schoolId, () => transport.findRoute(schoolId, id)),
      list: async (schoolId) => (await as(schoolId, () => transport.listRoutes(schoolId, { skip: 0, take: 50 }))).rows,
      write: (schoolId, id) => as(schoolId, () => transport.updateRoute(schoolId, id, { name: 'Taken over' })),
      snapshot: (row) => (row as { name: string }).name,
    });
    const a = await world(two.a.id);
    expect(await as(two.b.id, () => transport.archiveRoute(two.b.id, a.routeId, end(b)))).toBe(0);
    expect(await as(two.b.id, () => transport.liveStops(two.b.id, a.routeId))).toEqual([]);
    expect(await as(two.b.id, () => transport.liveStopsOf(two.b.id, [a.routeId]))).toEqual([]);
    expect(await as(two.b.id, () => transport.updateStop(two.b.id, a.routeId, a.stopId, { sortOrder: 5, name: 'X', pickupTime: null }))).toBe(0);
    expect(await as(two.b.id, () => transport.endStops(two.b.id, a.routeId, [a.stopId], end(b)))).toBe(0);
    expect(await as(two.b.id, () => transport.stopsInUse(two.b.id, [a.stopId]))).toEqual([]);
    expect((await as(two.a.id, () => transport.liveStops(two.a.id, a.routeId))).map((s) => s.name)).toEqual(['Stop 1']);
  });

  it('amounts: read, list and void see only their own school', async () => {
    const two = await createTwoSchools();
    await world(two.b.id);
    await expectIsolated(two, {
      create: async (schoolId) => (await world(schoolId)).amountId,
      read: (schoolId, id) => as(schoolId, () => transport.findAmount(schoolId, id)),
      write: async (schoolId, id) => as(schoolId, async () => transport.voidAmount(schoolId, id, end(await world(schoolId)))),
      snapshot: (row) => (row as { voidedAt: Date | null }).voidedAt,
    });
    const a = await world(two.a.id);
    expect(await as(two.b.id, () => transport.amountsOf(two.b.id, [a.routeId]))).toEqual([]);
  });

  it('assignments: read, list, end and the family, driver and leaving reads see only their own school', async () => {
    const two = await createTwoSchools();
    await world(two.b.id);
    const scopeOf = async (schoolId: SchoolId) => studentsScope([(await world(schoolId)).studentId]);
    await expectIsolated(two, {
      create: async (schoolId) => (await world(schoolId)).assignmentId,
      read: async (schoolId, id) => as(schoolId, async () => transport.findAssignment(schoolId, await scopeOf(two.a.id), id)),
      list: async (schoolId) =>
        (await as(schoolId, async () => transport.listForRoute(schoolId, await scopeOf(two.a.id), (await world(two.a.id)).routeId, { includeEnded: true, skip: 0, take: 50 }))).rows,
      write: async (schoolId, id) => as(schoolId, async () => transport.endAssignment(schoolId, id, day('2026-05-01'), end(await world(schoolId)))),
      snapshot: (row) => (row as { endedAt: Date | null }).endedAt,
    });
    const a = await world(two.a.id);
    const scopeA = studentsScope([a.studentId]);
    expect(await as(two.b.id, () => transport.listForStudent(two.b.id, scopeA, a.studentId, 21))).toEqual([]);
    expect(await as(two.b.id, () => transport.currentForStudent(two.b.id, scopeA, a.studentId, day('2026-05-01')))).toBeNull();
    expect(await as(two.b.id, () => transport.yearAssignments(two.b.id, a.studentId, a.yearId))).toEqual([]);
    expect(await as(two.b.id, () => transport.liveOf(two.b.id, [a.studentId]))).toEqual([]);
    expect(await as(two.b.id, () => transport.driverRoutes(two.b.id, a.staffId, day('2026-05-01')))).toEqual([]);
    expect((await as(two.a.id, () => transport.driverRoutes(two.a.id, a.staffId, day('2026-05-01')))).map((r) => r.id)).toEqual([a.routeId]);
  });

  it("riders (the charge job's read) see only their own school", async () => {
    const two = await createTwoSchools();
    const a = await world(two.a.id);
    const b = await world(two.b.id);
    const q = (yearId: bigint) => ({ academicYearId: yearId, period: '2026-05', periodStart: '2026-05-01', cutoffDate: '2026-05-15' });
    expect(await as(two.a.id, () => reads.riders(two.a.id, q(a.yearId)))).toEqual([{ studentId: a.studentId, routeId: a.routeId, amount: 1500 }]);
    // School A's year asked as school B finds nothing; B's own rider only.
    expect(await as(two.b.id, () => reads.riders(two.b.id, q(a.yearId)))).toEqual([]);
    expect((await as(two.b.id, () => reads.riders(two.b.id, q(b.yearId)))).map((r) => r.studentId)).toEqual([b.studentId]);
  });
});
