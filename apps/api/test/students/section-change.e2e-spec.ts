// Section change as close-old/open-new (contracts/slice-10.md §8; R174, R37 amended), and the
// roster-of-a-date property it exists for (R124): no date has the child on two rosters.
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import {
  createClass,
  createClassWithSection,
  createSection,
  createStudent,
  day,
  enrol,
  isoDay,
} from '../support/students';
import { auditFor, createHarness, errorOf, signIn, type Harness } from './support';

interface Enrolment {
  id: string;
  studentId: string;
  classId: string;
  sectionId: string;
  sectionName: string;
  rollNo: number | null;
  status: string;
  startedOn: string;
  endedOn: string | null;
}
interface Moved {
  closed: Enrolment;
  opened: Enrolment;
}

describe('change-section (R174)', () => {
  let h: Harness;
  const db = testDb();

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  /** The students on `sectionId`'s roster on `date`: enrolments in force that day. */
  const rosterOn = async (school: TestSchool, sectionId: bigint, date: string) =>
    (
      await db.enrolment.findMany({
        where: {
          schoolId: school.id,
          sectionId,
          startedOn: { lte: day(date) },
          OR: [{ endedOn: null }, { endedOn: { gte: day(date) } }],
        },
        select: { studentId: true },
      })
    ).map((e) => e.studentId);

  async function moving(opts: { rollNo?: number | null; startedOn?: string } = {}) {
    const startedOn = opts.startedOn ?? isoDay(-20);
    const school = await createSchool();
    const office = await signIn(school, 'office_staff');
    const { klass, section } = await createClassWithSection(db, school);
    const student = await createStudent(db, school, { admittedOn: startedOn });
    const enrolment = await enrol(db, school, student, section, {
      startedOn,
      rollNo: opts.rollNo === undefined ? 3 : opts.rollNo,
    });
    const target = await createSection(db, school, klass, { name: 'B' });
    const path = `/enrolments/${enrolment.id}/change-section`;
    const body = (extra: object = {}) => ({
      sectionId: target.id.toString(),
      effectiveOn: isoDay(-5),
      reason: '  Balance   sizes ',
      ...extra,
    });
    return { school, office, klass, section, student, enrolment, target, path, body };
  }

  it('R174: closes the old enrolment on effectiveOn − 1 and opens one on effectiveOn; the old keeps its roll number, the new has none', async () => {
    const { school, office, section, student, enrolment, target, path, body } = await moving();
    const res = await h.send('post', path, body(), office.cookie);
    expect(res.status).toBe(200);
    const { closed, opened } = res.body as Moved;
    expect(closed).toMatchObject({
      id: enrolment.id.toString(),
      sectionId: section.id.toString(),
      rollNo: 3,
      status: 'left',
      startedOn: isoDay(-20),
      endedOn: isoDay(-6),
    });
    expect(opened).toMatchObject({
      studentId: student.id.toString(),
      classId: section.classId.toString(),
      sectionId: target.id.toString(),
      sectionName: 'B',
      rollNo: null,
      status: 'active',
      startedOn: isoDay(-5),
      endedOn: null,
    });
    expect(opened.id).not.toBe(closed.id);
    expect(
      await db.enrolment.findFirst({ where: { schoolId: school.id, id: enrolment.id } }),
    ).toMatchObject({ sectionId: section.id, rollNo: 3, status: 'left', endedOn: day(isoDay(-6)) });

    // Audited on the closed enrolment, reason normalised.
    expect(await auditFor(school, 'enrolment', enrolment.id)).toEqual([
      expect.objectContaining({
        action: 'enrolment.section_changed',
        reason: 'Balance sizes',
        metadata: {
          fromSectionId: section.id.toString(),
          toSectionId: target.id.toString(),
          newEnrolmentId: opened.id,
          effectiveOn: isoDay(-5),
        },
      }),
    ]);

    // R124: the roster of every date has the child exactly once, in the right section.
    for (const date of [isoDay(-20), isoDay(-6), isoDay(-5), isoDay()]) {
      const both = [
        ...(await rosterOn(school, section.id, date)),
        ...(await rosterOn(school, target.id, date)),
      ];
      expect(both.filter((id) => id === student.id)).toHaveLength(1);
    }
    expect(await rosterOn(school, section.id, isoDay(-6))).toContain(student.id);
    expect(await rosterOn(school, target.id, isoDay(-5))).toContain(student.id);

    // The roll number is set again on the opened enrolment (slice 6 PATCH, unchanged).
    const rolled = await h.send('patch', `/enrolments/${opened.id}`, { rollNo: 3 }, office.cookie);
    expect(rolled.body).toMatchObject({ rollNo: 3 });
    // Retry-safety: a resubmit lands on the closed enrolment.
    expect(errorOf(await h.send('post', path, body(), office.cookie)).code).toBe(
      'ENROLMENT_NOT_ACTIVE',
    );
  });

  it('R174: a same-day correction (effectiveOn = started_on) leaves a zero-length enrolment in force on no date', async () => {
    const { school, office, section, student, target, path, body } = await moving({
      rollNo: null,
      startedOn: isoDay(-2),
    });
    const res = await h.send('post', path, body({ effectiveOn: isoDay(-2) }), office.cookie);
    expect(res.status).toBe(200);
    expect((res.body as Moved).closed).toMatchObject({
      startedOn: isoDay(-2),
      endedOn: isoDay(-3),
      status: 'left',
    });
    for (const date of [isoDay(-3), isoDay(-2), isoDay()]) {
      expect(await rosterOn(school, section.id, date)).not.toContain(student.id);
    }
    expect(await rosterOn(school, target.id, isoDay(-2))).toContain(student.id);
  });

  it('R174: refusals — current section, another class, unknown, archived, dates outside started_on..today, reason required and normalised', async () => {
    const { school, office, klass, section, enrolment, path, body } = await moving();
    const fieldsOf = (res: { body: unknown }) =>
      (errorOf(res).details as { fields: { path: string; code: string }[] }).fields;
    const otherClass = await createClass(db, school, { id: klass.academicYearId });
    const foreign = await createSection(db, school, otherClass);
    const cases: [object, string, string][] = [
      [body({ sectionId: section.id.toString() }), 'sectionId', 'INVALID_VALUE'],
      [body({ sectionId: foreign.id.toString() }), 'sectionId', 'INVALID_VALUE'],
      [body({ sectionId: '999999999999' }), 'sectionId', 'REFERENCE_NOT_FOUND'],
      [body({ effectiveOn: isoDay(-21) }), 'effectiveOn', 'INVALID_VALUE'],
      [body({ effectiveOn: isoDay(1) }), 'effectiveOn', 'INVALID_VALUE'],
      [body({ effectiveOn: undefined }), 'effectiveOn', 'INVALID_VALUE'],
      [body({ reason: undefined }), 'reason', 'INVALID_VALUE'],
      [body({ reason: 'no' }), 'reason', 'INVALID_VALUE'],
      [body({ reason: 'Ring 0300 1234567 first' }), 'reason', 'INVALID_VALUE'],
    ];
    for (const [request, field, code] of cases) {
      const res = await h.send('post', path, request, office.cookie);
      expect(res.status).toBe(422);
      // Every refusal names that field (a missing value may fail several of its rules).
      const fields = fieldsOf(res);
      expect(fields.length).toBeGreaterThan(0);
      expect(fields).toEqual(fields.map(() => expect.objectContaining({ path: field, code }) as unknown));
    }
    const archived = await createSection(db, school, klass, { deletedAt: new Date() });
    expect(
      errorOf(await h.send('post', path, body({ sectionId: archived.id.toString() }), office.cookie))
        .code,
    ).toBe('SECTION_ARCHIVED');
    // Nothing moved.
    expect(
      await db.enrolment.findFirst({ where: { schoolId: school.id, id: enrolment.id } }),
    ).toMatchObject({ status: 'active', sectionId: section.id, endedOn: null });
    expect(await auditFor(school, 'enrolment', enrolment.id)).toEqual([]);
  });

  it('R174: the database refuses an in-place section_id edit (enrolments_columns_immutable)', async () => {
    const { school, enrolment, target } = await moving();
    await expect(
      db.enrolment.update({
        where: { schoolId_id: { schoolId: school.id, id: enrolment.id } },
        data: { sectionId: target.id },
      }),
    ).rejects.toThrow(/section_id/);
  });

  it.todo(
    'ATTENDANCE_RECORDED_AFTER: a section or class change dated on or before a recorded mark is 409 with details.lastRecordedOn (live when slice 11 binds AttendanceHistoryProbe)',
  );
});
