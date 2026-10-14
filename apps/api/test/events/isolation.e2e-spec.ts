// Control 4 / R62 for slice 38 through its repository (contracts/slice-38.md): every EventRepository
// read and write of events, duties, participation and the family list, as school A's row seen or
// changed by school B. The tables' own composite foreign keys are proved in
// test/phase5/wave-s-isolation.e2e-spec.ts.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { EventRepository } from '../../src/repositories/event.repository';
import type { SchoolId } from '../../src/tenancy/school-id';
import { createTestApp } from '../core/app';
import { asSchool } from '../messaging/support';
import { expectIsolated, studentsScope } from '../support/isolation';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createTwoSchools, testDb } from '../support/schools';
import { createAcademicYear, createClass, createSection, createStudent, day, enrol, isoDay } from '../support/students';

const db = () => testDb();

describe('slice 38 tenant isolation', () => {
  let app: NestExpressApplication;
  let events: EventRepository;
  const as = <T>(schoolId: SchoolId, fn: () => Promise<T>) => asSchool(app, schoolId, fn);

  beforeAll(async () => {
    app = await createTestApp();
    events = app.get(EventRepository, { strict: false });
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  /** A school's published event of one section with a pupil, a duty and a participation row. */
  const world = async (schoolId: SchoolId) => {
    const school = { id: schoolId, shortCode: '' };
    const principal = await createSchoolUser(db(), school, { systemRole: 'principal' });
    const year = await createAcademicYear(db(), school);
    const klass = await createClass(db(), school, year);
    const section = await createSection(db(), school, klass);
    const student = await createStudent(db(), school, { admittedOn: isoDay(-60) });
    const enrolment = await enrol(db(), school, student, section, { startedOn: isoDay(-60) });
    const startsAt = new Date(`${isoDay(5)}T04:00:00.000Z`);
    const eventId = await as(schoolId, () =>
      events.create(
        schoolId,
        year.id,
        { type: 'ptm', title: 'Parents meeting', startsAt, endsAt: startsAt, venue: 'Hall', details: null, chargeAmount: null, chargeDueOn: null },
        principal.userId,
      ),
    );
    await as(schoolId, () => events.replaceSections(schoolId, eventId, year.id, [{ sectionId: section.id, classId: klass.id }]));
    const invite = await db().announcement.create({
      data: { schoolId, title: 'Parents meeting', body: 'Saturday.', category: 'event', priority: 'normal', createdBy: principal.userId },
    });
    await as(schoolId, () => events.publish(schoolId, eventId, { announcementId: invite.id, campaignId: null }));
    const dutyId = await as(schoolId, () =>
      events.createDuty(schoolId, { eventId, staffId: principal.staffId, duty: 'registration', note: null, createdBy: principal.userId }),
    );
    await as(schoolId, () =>
      events.recordParticipation(
        schoolId,
        { id: eventId, academicYearId: year.id },
        [{ studentId: student.id, enrolmentId: enrolment.id, status: 'attended' }],
        principal.userId,
        new Date(),
      ),
    );
    return { principal, year, section, student, eventId, dutyId, startsAt };
  };

  it('events: read, list, the locks and every status write see only their own school', async () => {
    const two = await createTwoSchools();
    let ofA: Awaited<ReturnType<typeof world>> | undefined;
    await expectIsolated(two, {
      create: async (schoolId) => {
        ofA = await world(schoolId);
        return ofA.eventId;
      },
      read: (schoolId, id) => as(schoolId, () => events.findById(schoolId, id)),
      list: async (schoolId) =>
        (await as(schoolId, () => events.list(schoolId, { visible: ['draft', 'published', 'completed', 'cancelled'], sort: '-startsAt', skip: 0, take: 50 }))).rows,
      write: (schoolId, id) => as(schoolId, () => events.complete(schoolId, id, new Date())),
      snapshot: (row) => (row as { status: string }).status,
    });
    const b = two.b.id;
    const a = ofA!;
    expect(await as(b, () => events.lockForUpdate(b, a.eventId))).toBeNull();
    expect(await as(b, () => events.lockForShare(b, a.eventId))).toBeNull();
    expect(await as(b, () => events.updateDraft(b, a.eventId, { title: 'Taken' }))).toBe(0);
    expect(await as(b, () => events.cancel(b, a.eventId, 'published', { by: a.principal.userId, reason: 'Gone', at: new Date(), cancelAnnouncementId: null }))).toBe(0);
    expect(await as(b, () => events.year(b, a.year.id))).toBeNull();
    expect(await as(b, () => events.liveSectionsOfYear(b, a.year.id, [a.section.id]))).toEqual([]);
    expect(await as(b, () => events.activeStaff(b, a.principal.staffId))).toBe(false);
    expect(await as(b, () => events.expenseTotals(b, a.eventId))).toEqual({ count: 0, total: 0 });
    expect(await as(b, () => events.mineIds(b, a.principal.staffId, day(isoDay())))).toEqual([]);
  });

  it('event_duties: read, list, the live checks and the end see only their own school', async () => {
    const two = await createTwoSchools();
    let ofA: Awaited<ReturnType<typeof world>> | undefined;
    await expectIsolated(two, {
      create: async (schoolId) => {
        ofA = await world(schoolId);
        return ofA.dutyId;
      },
      read: (schoolId, id) => as(schoolId, () => events.findDuty(schoolId, id)),
      list: (schoolId) => as(schoolId, () => events.dutiesOf(schoolId, [ofA!.eventId])),
      write: (schoolId, id) => as(schoolId, () => events.endDuty(schoolId, id, { by: ofA!.principal.userId, reason: 'Gone', at: new Date() })),
      snapshot: (row) => (row as { endedAt: Date | null }).endedAt,
    });
    const b = two.b.id;
    const a = ofA!;
    expect(await as(b, () => events.liveDuty(b, a.eventId, a.principal.staffId, 'registration'))).toBeNull();
    expect(await as(b, () => events.liveDutyKinds(b, a.eventId, a.principal.staffId))).toEqual([]);
    expect(await as(b, () => events.everCollected(b, a.eventId, a.principal.staffId))).toBe(false);
    expect(await as(b, () => events.classTeacherSections(b, a.principal.staffId, [a.section.id], day(isoDay())))).toEqual([]);
  });

  it('event_participation, the roster and the family list see only their own school', async () => {
    const two = await createTwoSchools();
    const a = await world(two.a.id);
    const b = two.b.id;
    const event = { id: a.eventId, academicYearId: a.year.id, campaignId: null, sectionIds: [a.section.id] };
    const roster = await as(two.a.id, () => events.roster(two.a.id, event, day(isoDay(5)), null));
    expect(roster.map((r) => [r.studentId, r.participation])).toEqual([[a.student.id, 'attended']]);
    expect(await as(b, () => events.roster(b, event, day(isoDay(5)), null))).toEqual([]);
    // B's write of A's participation finds no event row of its own and is refused at the database.
    await expect(
      as(b, () =>
        events.recordParticipation(b, { id: a.eventId, academicYearId: a.year.id }, [{ studentId: a.student.id, enrolmentId: 1n, status: 'absent' }], a.principal.userId, new Date()),
      ),
    ).rejects.toThrow();
    expect((await as(two.a.id, () => events.roster(two.a.id, event, day(isoDay(5)), null)))[0]?.participation).toBe('attended');
    // The family list: A's child under A's scope, nothing under B.
    const page = { skip: 0, take: 50 };
    expect((await as(two.a.id, () => events.familyEvents(two.a.id, studentsScope([a.student.id]), a.student.id, 'Asia/Karachi', page))).total).toBe(1);
    expect(await as(b, () => events.familyEvents(b, studentsScope([a.student.id]), a.student.id, 'Asia/Karachi', page))).toEqual({ rows: [], total: 0 });
    expect(await as(b, () => events.childCharges(b, a.student.id, [1n]))).toEqual([]);
    expect(await as(b, () => events.campaignTotals(b, 1n))).toEqual({ chargeCount: 0, charged: 0, credited: 0, collected: 0 });
  });
});
