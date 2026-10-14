// Control 4 / R62 for the wave T tables (migration 20261014120100_wave_t_transport_biometric), at
// the database through the guarded client: a row written as school A is invisible to, and
// unwritable by, school B. Slices 41 and 44 add the same checks through their repositories when
// they write them; these hold the line until then and stay as the table-level floor. The
// append-only device_punches has no write probe: nothing updates it.
import type { SchoolId } from '../../src/tenancy/school-id';
import { expectIsolated } from '../support/isolation';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createTwoSchools, testDb, type TwoSchools } from '../support/schools';
import { createAcademicYear, createClass, createSection, createStudent, day, enrol } from '../support/students';

const db = () => testDb();

describe('wave T tenant isolation (database level)', () => {
  let schools: TwoSchools;
  let n = 0;

  beforeAll(async () => {
    schools = await createTwoSchools();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  /** A school's office user, a vehicle, a route on it with a stop. */
  const transport = async (schoolId: SchoolId) => {
    const school = { id: schoolId, shortCode: '' };
    const office = await createSchoolUser(db(), school, { systemRole: 'office_staff' });
    const vehicle = await db().vehicle.create({
      data: { schoolId, registration: `ISO-${++n}-${schoolId}`, capacity: 30, createdBy: office.userId },
    });
    const route = await db().transportRoute.create({
      data: { schoolId, name: `Isolation ${++n}`, vehicleId: vehicle.id, createdBy: office.userId },
    });
    const stop = await db().transportStop.create({ data: { schoolId, routeId: route.id, sortOrder: 1, name: 'Main gate' } });
    return { school, office, vehicle, route, stop };
  };

  /** A teacher with a device user id, and an office user to mark them. */
  const staff = async (schoolId: SchoolId) => {
    const school = { id: schoolId, shortCode: '' };
    const office = await createSchoolUser(db(), school, { systemRole: 'office_staff' });
    const teacher = await createSchoolUser(db(), school, { systemRole: 'teacher' });
    const deviceUserId = `ISO${++n}`;
    await db().staff.updateMany({ where: { schoolId, id: teacher.staffId }, data: { deviceUserId } });
    return { office, teacher, deviceUserId };
  };

  it('vehicles: a school never reads, lists or edits another school vehicle', async () => {
    await expectIsolated(schools, {
      create: async (schoolId) => (await transport(schoolId)).vehicle.id,
      read: (schoolId, id) => db().vehicle.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().vehicle.findMany({ where: { schoolId }, select: { id: true } }),
      write: async (schoolId, id) => (await db().vehicle.updateMany({ where: { schoolId, id }, data: { capacity: 99 } })).count,
      snapshot: (row) => (row as { capacity: number }).capacity,
    });
  });

  it('transport_routes: a school never reads, lists or renames another school route', async () => {
    await expectIsolated(schools, {
      create: async (schoolId) => (await transport(schoolId)).route.id,
      read: (schoolId, id) => db().transportRoute.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().transportRoute.findMany({ where: { schoolId }, select: { id: true } }),
      write: async (schoolId, id) => (await db().transportRoute.updateMany({ where: { schoolId, id }, data: { name: 'Taken' } })).count,
      snapshot: (row) => (row as { name: string }).name,
    });
  });

  it('transport_route_amounts: a school never reads, lists or voids another school amount', async () => {
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const t = await transport(schoolId);
        return (
          await db().transportRouteAmount.create({
            data: { schoolId, routeId: t.route.id, effectivePeriod: '2099-01', amount: 2500, createdBy: t.office.userId },
          })
        ).id;
      },
      read: (schoolId, id) => db().transportRouteAmount.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().transportRouteAmount.findMany({ where: { schoolId }, select: { id: true } }),
      write: async (schoolId, id) =>
        (await db().transportRouteAmount.updateMany({ where: { schoolId, id }, data: { voidedAt: new Date(), voidReason: 'Taken' } })).count,
      snapshot: (row) => (row as { voidedAt: Date | null }).voidedAt,
    });
  });

  it('transport_stops: a school never reads, lists or renames another school stop', async () => {
    await expectIsolated(schools, {
      create: async (schoolId) => (await transport(schoolId)).stop.id,
      read: (schoolId, id) => db().transportStop.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().transportStop.findMany({ where: { schoolId }, select: { id: true } }),
      write: async (schoolId, id) => (await db().transportStop.updateMany({ where: { schoolId, id }, data: { name: 'Taken' } })).count,
      snapshot: (row) => (row as { name: string }).name,
    });
  });

  it('transport_assignments: a school never reads, lists or ends another school assignment', async () => {
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const t = await transport(schoolId);
        const year = await createAcademicYear(db(), t.school, { startsOn: '2026-04-01', endsOn: '2027-03-31' });
        const section = await createSection(db(), t.school, await createClass(db(), t.school, year));
        const student = await createStudent(db(), t.school, { admittedOn: '2026-04-01' });
        const enrolment = await enrol(db(), t.school, student, section, { startedOn: '2026-04-01' });
        return (
          await db().transportAssignment.create({
            data: {
              schoolId,
              studentId: student.id,
              academicYearId: year.id,
              enrolmentId: enrolment.id,
              routeId: t.route.id,
              stopId: t.stop.id,
              startsOn: day('2026-05-01'),
              createdBy: t.office.userId,
            },
          })
        ).id;
      },
      read: (schoolId, id) => db().transportAssignment.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().transportAssignment.findMany({ where: { schoolId }, select: { id: true } }),
      write: async (schoolId, id) =>
        (
          await db().transportAssignment.updateMany({
            where: { schoolId, id },
            data: { endedAt: new Date(), endReason: 'Taken', endsOn: day('2026-06-30') },
          })
        ).count,
      snapshot: (row) => (row as { endedAt: Date | null }).endedAt,
    });
  });

  it('device_punches: a school never reads or lists another school punch', async () => {
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const s = await staff(schoolId);
        return (
          await db().devicePunch.create({
            data: {
              schoolId,
              staffId: s.teacher.staffId,
              deviceUserId: s.deviceUserId,
              punchedAt: new Date('2026-09-01T03:00:00Z'),
              direction: 'in',
              outcome: 'stored',
            },
          })
        ).id;
      },
      read: (schoolId, id) => db().devicePunch.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().devicePunch.findMany({ where: { schoolId }, select: { id: true } }),
    });
  });

  it('staff_attendance_disputes: a school never reads, lists or decides another school dispute', async () => {
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const s = await staff(schoolId);
        const mark = await db().staffAttendance.create({
          data: { schoolId, staffId: s.teacher.staffId, date: day('2026-09-02'), status: 'absent', markedBy: s.office.userId },
        });
        return (
          await db().staffAttendanceDispute.create({
            data: {
              schoolId,
              attendanceId: mark.id,
              staffId: s.teacher.staffId,
              raisedBy: s.teacher.userId,
              requestedStatus: 'present',
              reason: 'I was in school',
            },
          })
        ).id;
      },
      read: (schoolId, id) => db().staffAttendanceDispute.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().staffAttendanceDispute.findMany({ where: { schoolId }, select: { id: true } }),
      write: async (schoolId, id) =>
        (
          await db().staffAttendanceDispute.updateMany({
            where: { schoolId, id },
            data: { status: 'rejected', decidedAt: new Date(), decisionReason: 'Taken' },
          })
        ).count,
      snapshot: (row) => (row as { status: string }).status,
    });
  });
});
