// Control 4 / R62 for the wave S tables (migration 20261010090000_wave_s_events_contracts), at
// the database through the guarded client: a row written as school A is invisible to, and
// unwritable by, school B. Slices 38 and 39 add the same checks through their repositories when
// they write them; these hold the line until then and stay as the table-level floor.
import type { SchoolId } from '../../src/tenancy/school-id';
import { expectIsolated } from '../support/isolation';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createTwoSchools, testDb, type TwoSchools } from '../support/schools';
import { createAcademicYear, createClass, createSection, createStudent, day, enrol } from '../support/students';

const db = () => testDb();

describe('wave S tenant isolation (database level)', () => {
  let schools: TwoSchools;

  beforeAll(async () => {
    schools = await createTwoSchools();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  /** A school's principal, year, section, enrolled student and a draft event. */
  const world = async (schoolId: SchoolId) => {
    const school = { id: schoolId, shortCode: '' };
    const user = await createSchoolUser(db(), school, { systemRole: 'principal' });
    const year = await createAcademicYear(db(), school, { startsOn: '2026-04-01', endsOn: '2027-03-31' });
    const klass = await createClass(db(), school, year);
    const section = await createSection(db(), school, klass);
    const student = await createStudent(db(), school, { admittedOn: '2026-04-01' });
    const enrolment = await enrol(db(), school, student, section, { startedOn: '2026-04-01' });
    const event = await db().event.create({
      data: {
        schoolId,
        academicYearId: year.id,
        type: 'ptm',
        title: 'Parents meeting',
        startsAt: new Date('2026-05-10T04:00:00Z'),
        endsAt: new Date('2026-05-10T06:00:00Z'),
        venue: 'Hall',
        createdBy: user.userId,
      },
    });
    const sectionRow = await db().eventSection.create({
      data: { schoolId, eventId: event.id, sectionId: section.id, classId: klass.id, academicYearId: year.id },
    });
    return { user, year, klass, section, student, enrolment, event, sectionRow };
  };

  const publish = async (schoolId: SchoolId, eventId: bigint, createdBy: bigint) => {
    const invite = await db().announcement.create({
      data: { schoolId, title: 'Parents meeting', body: 'Saturday 9 am.', category: 'event', priority: 'normal', createdBy },
    });
    await db().event.updateMany({ where: { schoolId, id: eventId }, data: { status: 'published', announcementId: invite.id } });
  };

  it('events: a school never reads, lists or edits another school event', async () => {
    await expectIsolated(schools, {
      create: async (schoolId) => (await world(schoolId)).event.id,
      read: (schoolId, id) => db().event.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().event.findMany({ where: { schoolId }, select: { id: true } }),
      write: async (schoolId, id) => (await db().event.updateMany({ where: { schoolId, id }, data: { title: 'Taken' } })).count,
      snapshot: (row) => (row as { title: string }).title,
    });
  });

  it('event_sections: a school never reads or lists another school event sections', async () => {
    await expectIsolated(schools, {
      create: async (schoolId) => (await world(schoolId)).sectionRow.id,
      read: (schoolId, id) => db().eventSection.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().eventSection.findMany({ where: { schoolId }, select: { id: true } }),
    });
  });

  it('event_duties: a school never reads, lists or ends another school duty', async () => {
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const w = await world(schoolId);
        return (
          await db().eventDuty.create({
            data: { schoolId, eventId: w.event.id, staffId: w.user.staffId, duty: 'supervision', createdBy: w.user.userId },
          })
        ).id;
      },
      read: (schoolId, id) => db().eventDuty.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().eventDuty.findMany({ where: { schoolId }, select: { id: true } }),
      write: async (schoolId, id) =>
        (await db().eventDuty.updateMany({ where: { schoolId, id }, data: { endedAt: new Date(), endReason: 'Taken' } })).count,
      snapshot: (row) => (row as { endedAt: Date | null }).endedAt,
    });
  });

  it('event_participation: a school never reads, lists or edits another school participation', async () => {
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const w = await world(schoolId);
        await publish(schoolId, w.event.id, w.user.userId);
        return (
          await db().eventParticipation.create({
            data: {
              schoolId,
              eventId: w.event.id,
              academicYearId: w.year.id,
              studentId: w.student.id,
              enrolmentId: w.enrolment.id,
              status: 'attended',
              recordedBy: w.user.userId,
            },
          })
        ).id;
      },
      read: (schoolId, id) => db().eventParticipation.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().eventParticipation.findMany({ where: { schoolId }, select: { id: true } }),
      write: async (schoolId, id) =>
        (await db().eventParticipation.updateMany({ where: { schoolId, id }, data: { status: 'absent' } })).count,
      snapshot: (row) => (row as { status: string }).status,
    });
  });

  it('staff_contracts: a school never reads, lists or ends another school contract', async () => {
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const user = await createSchoolUser(db(), { id: schoolId, shortCode: '' }, { systemRole: 'teacher' });
        return (
          await db().staffContract.create({
            data: {
              schoolId,
              staffId: user.staffId,
              type: 'fixed_term',
              startsOn: day('2026-04-01'),
              endsOn: day('2027-03-31'),
              createdBy: user.userId,
            },
          })
        ).id;
      },
      read: (schoolId, id) => db().staffContract.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().staffContract.findMany({ where: { schoolId }, select: { id: true } }),
      write: async (schoolId, id) =>
        (await db().staffContract.updateMany({ where: { schoolId, id }, data: { warned30At: new Date() } })).count,
      snapshot: (row) => (row as { warned30At: Date | null }).warned30At,
    });
  });
});
