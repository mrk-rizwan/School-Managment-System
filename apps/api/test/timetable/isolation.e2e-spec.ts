// Control 4 / R62 for the slice-37 tables (migration 20261009140000_slice37_timetable), through
// their repositories: timetable_versions, timetable_slots and timetable_substitutions, plus the
// read-side repository attendance and leave use. Composite foreign keys refuse another school's
// section, class-subject or staff member at the database.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { TimetableReadsRepository } from '../../src/repositories/timetable-reads.repository';
import { TimetableRepository } from '../../src/repositories/timetable.repository';
import type { SchoolId } from '../../src/tenancy/school-id';
import { createTestApp } from '../core/app';
import { asSchool } from '../messaging/support';
import { expectIsolated } from '../support/isolation';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createTwoSchools, testDb } from '../support/schools';
import { createAcademicYear, createClass, createSection, createSubject, day, isoDay } from '../support/students';

const db = () => testDb();

describe('slice 37 tenant isolation', () => {
  let app: NestExpressApplication;
  let timetable: TimetableRepository;
  let reads: TimetableReadsRepository;
  const as = <T>(schoolId: SchoolId, fn: () => Promise<T>) => asSchool(app, schoolId, fn);

  beforeAll(async () => {
    app = await createTestApp();
    timetable = app.get(TimetableRepository, { strict: false });
    reads = app.get(TimetableReadsRepository, { strict: false });
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  /** A school's section with a class-subject and a teacher. */
  const world = async (schoolId: SchoolId) => {
    const school = { id: schoolId, shortCode: '' };
    const user = await createSchoolUser(db(), school, { systemRole: 'principal' });
    const year = await createAcademicYear(db(), school);
    const klass = await createClass(db(), school, year, { attendanceMode: 'period' });
    const section = await createSection(db(), school, klass);
    const subject = await createSubject(db(), school);
    const classSubject = await db().classSubject.create({
      data: { schoolId, academicYearId: year.id, classId: klass.id, subjectId: subject.id, sortOrder: 1 },
    });
    return { user, year, klass, section, classSubjectId: classSubject.id };
  };

  const newVersion = async (schoolId: SchoolId) => {
    const w = await world(schoolId);
    const version = await as(schoolId, () =>
      timetable.createVersion(schoolId, {
        sectionId: w.section.id,
        classId: w.klass.id,
        academicYearId: w.year.id,
        effectiveFrom: day(isoDay()),
        createdBy: w.user.userId,
      }),
    );
    await as(schoolId, () =>
      timetable.createSlots(schoolId, version, [
        { weekday: 1, period: 1, classSubjectId: w.classSubjectId, staffId: w.user.staffId, room: 'Lab' },
      ]),
    );
    return { w, version };
  };

  it('timetable_versions: read, list, later, live and every write see only their own school', async () => {
    const two = await createTwoSchools();
    let sectionOfA = 0n;
    await expectIsolated(two, {
      create: async (schoolId) => {
        const { w, version } = await newVersion(schoolId);
        sectionOfA = w.section.id;
        return version.id;
      },
      read: (schoolId, id) => as(schoolId, () => timetable.findVersion(schoolId, id)),
      list: async (schoolId) =>
        (await as(schoolId, () => timetable.listVersions(schoolId, { today: day(isoDay()), sort: '-effectiveFrom', skip: 0, take: 50 }))).rows,
      write: async (schoolId, id) => {
        await as(schoolId, () => timetable.setEffectiveTo(schoolId, id, day(isoDay(30))));
        return 1;
      },
      snapshot: (row) => (row as { effectiveTo: Date | null }).effectiveTo,
    });
    const b = two.b.id;
    expect(await as(b, () => timetable.findSection(b, sectionOfA))).toBeNull();
    expect(await as(b, () => timetable.laterVersion(b, sectionOfA, day(isoDay(-1))))).toBeNull();
    expect(await as(b, () => timetable.lockLiveOn(b, sectionOfA, day(isoDay())))).toBeNull();
    expect(await as(b, () => reads.versionsBetween(b, [sectionOfA], day(isoDay(-7)), day(isoDay(7))))).toEqual([]);
    expect(await as(b, () => reads.versionsLiveOn(b, day(isoDay())))).toEqual([]);
    expect(await as(b, () => reads.periodAccess(b, { sectionId: sectionOfA, date: day(isoDay()), period: 1, staffId: null }))).toEqual({
      live: false,
      slotStaffId: null,
      substitute: null,
    });
  });

  it('timetable_slots: the slot reads and the clash read see only their own school', async () => {
    const two = await createTwoSchools();
    let staffOfA = 0n;
    let versionOfA = 0n;
    await expectIsolated(two, {
      create: async (schoolId) => {
        const { w, version } = await newVersion(schoolId);
        staffOfA = w.user.staffId;
        versionOfA = version.id;
        const [slot] = await as(schoolId, () => reads.slotsOfVersions(schoolId, [version]));
        return slot!.id;
      },
      read: async (schoolId, id) => {
        const versions = await as(schoolId, () => reads.versionsByIds(schoolId, [versionOfA]));
        const slots = await as(schoolId, () => reads.slotsOfVersions(schoolId, versions));
        return slots.find((s) => s.id === id) ?? null;
      },
      list: (schoolId) => as(schoolId, () => reads.staffSlotsBetween(schoolId, staffOfA, day(isoDay(-7)), day(isoDay(7)))),
    });
    const b = two.b.id;
    expect(await as(b, () => timetable.slotInputsOf(b, versionOfA))).toEqual([]);
    expect(await as(b, () => timetable.otherSlotsMeeting(b, 0n, day(isoDay()), null))).toEqual([]);
    expect(await as(b, () => timetable.slotCounts(b, [versionOfA]))).toEqual(new Map());
    expect(await as(b, () => reads.staffSlotsOf(b, [staffOfA], day(isoDay(-7)), day(isoDay(7))))).toEqual([]);
  });

  it('timetable_substitutions: read, list, the clash read and the void see only their own school', async () => {
    const two = await createTwoSchools();
    let sectionOfA = 0n;
    let staffOfA = 0n;
    await expectIsolated(two, {
      create: async (schoolId) => {
        const w = await world(schoolId);
        sectionOfA = w.section.id;
        staffOfA = w.user.staffId;
        const row = await as(schoolId, () =>
          timetable.createSubstitution(schoolId, {
            sectionId: w.section.id,
            classId: w.klass.id,
            date: day(isoDay()),
            period: 2,
            staffId: w.user.staffId,
            reason: 'Teacher on leave',
            createdBy: w.user.userId,
          }),
        );
        return row.id;
      },
      read: (schoolId, id) => as(schoolId, () => timetable.findSubstitution(schoolId, id)),
      list: async (schoolId) =>
        (await as(schoolId, () => timetable.listSubstitutions(schoolId, { includeVoided: true, sort: '-date', skip: 0, take: 50 }))).rows,
      write: async (schoolId, id) =>
        (await as(schoolId, () => timetable.voidSubstitution(schoolId, id, 1n, 'Back early', new Date()))) ? 1 : 0,
      snapshot: (row) => (row as { voidedAt: Date | null }).voidedAt,
    });
    const b = two.b.id;
    expect(
      await as(b, () => timetable.liveSubstitutionClash(b, { sectionId: sectionOfA, staffId: staffOfA, date: day(isoDay()), period: 2 })),
    ).toBeNull();
    expect(await as(b, () => reads.substitutionsBetween(b, { sectionIds: [sectionOfA], from: day(isoDay(-1)), to: day(isoDay(1)) }))).toEqual([]);
    expect(await as(b, () => reads.substitutionsBetween(b, { staffIds: [staffOfA], from: day(isoDay(-1)), to: day(isoDay(1)) }))).toEqual([]);
  });
});
