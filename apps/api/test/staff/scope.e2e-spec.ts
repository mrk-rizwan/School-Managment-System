// Teacher scope (contracts/slice-4.md §1; plan §3.4): R53, R54, R59, R69, R79. Read through the
// real access guard by a test-only route that reports scopeOf(session), and through
// PermissionsService directly. The school's clock is moved to test "the day after".
import { Capability } from '@asms/shared';
import { PermissionsService } from '../../src/modules/access/permissions.service';
import { SchoolClock } from '../../src/common/school-clock';
import { createSchoolSession, createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, type TestSchool } from '../support/schools';
import {
  createAcademicYear,
  createClass,
  createSection,
  createSubject,
  createTeacherAssignment,
  type TestClass,
  type TestSection,
} from '../support/students';
import { schoolDay, StaffHarness, type Caller } from './support';

type ScopeBody = { kind: 'all' } | { kind: 'sections'; ids: string[] };

describe('teacher scope (e2e)', () => {
  const h = new StaffHarness();
  const db = h.db;
  let school: TestSchool;
  let principal: Caller;
  let klass: TestClass;
  let subjectId: bigint;

  const scopeOf = async (cookie: string) => {
    const res = await h.get('/api/v1/test-scope', cookie);
    return { status: res.status, body: res.body as ScopeBody };
  };
  const sectionsOf = async (user: Caller) => {
    const { status, body } = await scopeOf(user.cookie);
    expect(status).toBe(200);
    if (body.kind !== 'sections') throw new Error(`expected sections, got ${body.kind}`);
    return body.ids;
  };
  const section = (k: TestClass = klass, deletedAt: Date | null = null): Promise<TestSection> =>
    createSection(db, school, k, { deletedAt });
  const asCaller = async (user: TestSchoolUser): Promise<Caller> => ({
    ...user,
    cookie: (await createSchoolSession(db, school, user)).cookie,
  });

  beforeAll(async () => {
    await h.start();
    school = await createSchool();
    principal = await h.caller(school, 'principal');
    klass = await createClass(db, school, await createAcademicYear(db, school));
    subjectId = (await createSubject(db, school)).id;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await h.app.close();
    await closeTestDb();
  });

  it('R79: school-wide roles get all; a teacher with no assignment gets an empty list, never no filter', async () => {
    expect((await scopeOf(principal.cookie)).body).toEqual({ kind: 'all' });
    const office = await h.caller(school, 'office_staff');
    expect((await scopeOf(office.cookie)).body).toEqual({ kind: 'all' });
    const t = await h.caller(school, 'teacher');
    expect(await sectionsOf(t)).toEqual([]);
  });

  it('R79: held through both a teacher and a school-wide role, the widest wins', async () => {
    const t = await h.caller(school, 'teacher');
    await db.userRole.create({
      data: { schoolId: school.id, userId: t.userId, systemRole: 'office_staff', assignedBy: principal.userId },
    });
    expect((await scopeOf(t.cookie)).body).toEqual({ kind: 'all' });
    const access = await h.app.get(PermissionsService).load(school.id, t.userId);
    expect(
      await h.app.get(PermissionsService).canAny(school.id, access!, [Capability.MARKS_ENTER, Capability.STUDENT_VIEW]),
    ).toMatchObject({ kind: 'all' });
  });

  it('a class teacher’s section and a sectioned subject teacher’s; only rows active today count', async () => {
    const t = await h.caller(school, 'teacher');
    const own = await section();
    const taught = await section();
    const future = await section();
    const ended = await section();
    const voided = await section();
    await createTeacherAssignment(db, school, t, { role: 'class_teacher', section: own, startsOn: schoolDay(-30) });
    await createTeacherAssignment(db, school, t, { role: 'subject_teacher', subjectId, section: taught, startsOn: schoolDay(0), endsOn: schoolDay(0) });
    await createTeacherAssignment(db, school, t, { role: 'class_teacher', section: future, startsOn: schoolDay(1) });
    await createTeacherAssignment(db, school, t, { role: 'class_teacher', section: ended, startsOn: schoolDay(-30), endsOn: schoolDay(-1) });
    await createTeacherAssignment(db, school, t, { role: 'class_teacher', section: voided, startsOn: schoolDay(0), voidedBy: principal.userId });
    expect(await sectionsOf(t)).toEqual([String(own.id), String(taught.id)]);
  });

  it('R54: a subject teacher with no section scopes every live section of the class; an archived one drops out', async () => {
    const k = await createClass(db, school, await createAcademicYear(db, school));
    const a = await section(k);
    const b = await section(k);
    const archived = await section(k, new Date());
    await section(); // another class: not included
    const t = await h.caller(school, 'teacher');
    await createTeacherAssignment(db, school, t, { role: 'subject_teacher', subjectId, klass: k, startsOn: schoolDay(-1) });
    expect(await sectionsOf(t)).toEqual([a.id, b.id].map(String));
    expect(await sectionsOf(t)).not.toContain(String(archived.id));
  });

  it('R53: history follows the section; the day after a reassignment the scope has moved', async () => {
    const s = await section();
    const a = await asCaller(await createSchoolUser(db, school, { systemRole: 'teacher' }));
    const b = await asCaller(await createSchoolUser(db, school, { systemRole: 'teacher' }));
    await createTeacherAssignment(db, school, a, { role: 'class_teacher', section: s, startsOn: schoolDay(-10) });
    const res = await h.send(
      'post',
      `/api/v1/staff/${b.staffId}/teacher-assignments`,
      { role: 'class_teacher', classId: String(s.classId), sectionId: String(s.id), startsOn: schoolDay(1), replaceCurrent: true },
      principal.cookie,
    );
    expect(res.status).toBe(201);
    expect(await sectionsOf(a)).toEqual([String(s.id)]);
    expect(await sectionsOf(b)).toEqual([]);

    // Tomorrow, in the school's time zone (R69: computed on every request, nothing cached).
    const clock = h.app.get(SchoolClock);
    const spy = jest.spyOn(clock, 'now').mockReturnValue(new Date(Date.now() + 86_400_000));
    try {
      expect(await sectionsOf(a)).toEqual([]);
      expect(await sectionsOf(b)).toEqual([String(s.id)]);
    } finally {
      spy.mockRestore();
    }
    expect(await sectionsOf(a)).toEqual([String(s.id)]);
  });

  it('"today" is the school’s date, not the server’s: Karachi midnight decides', async () => {
    const s = await section();
    const t = await h.caller(school, 'teacher');
    await createTeacherAssignment(db, school, t, { role: 'class_teacher', section: s, startsOn: '2027-01-10', endsOn: '2027-01-10' });
    const clock = h.app.get(SchoolClock);
    const at = (iso: string) => jest.spyOn(clock, 'now').mockReturnValue(new Date(iso));
    try {
      // 2027-01-09T19:30Z is 00:30 on the 10th in Karachi (UTC+5): the row counts.
      at('2027-01-09T19:30:00.000Z');
      expect(await sectionsOf(t)).toEqual([String(s.id)]);
      // 2027-01-10T18:59Z is 23:59 on the 10th: still counts. 19:00Z is the 11th: it does not.
      at('2027-01-10T18:59:00.000Z');
      expect(await sectionsOf(t)).toEqual([String(s.id)]);
      at('2027-01-10T19:00:00.000Z');
      expect(await sectionsOf(t)).toEqual([]);
      at('2027-01-09T18:59:00.000Z');
      expect(await sectionsOf(t)).toEqual([]);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('R59: a suspended teacher has no capability and no scope, whatever rows are stored', async () => {
    const t = await h.caller(school, 'teacher');
    const s = await section();
    await createTeacherAssignment(db, school, t, { role: 'class_teacher', section: s, startsOn: schoolDay(-1) });
    expect(await sectionsOf(t)).toEqual([String(s.id)]);
    await db.staff.updateMany({ where: { schoolId: school.id, id: t.staffId }, data: { status: 'suspended' } });
    const permissions = h.app.get(PermissionsService);
    const access = await permissions.load(school.id, t.userId);
    expect(await permissions.can(school.id, access!, Capability.STUDENT_VIEW)).toBeNull();
    // No capacity remains, so the session itself is refused (R71).
    expect((await scopeOf(t.cookie)).status).toBe(401);
  });

  it('another school’s teacher is scoped to that school’s sections only', async () => {
    const other = await createSchool();
    const theirTeacher = await createSchoolUser(db, other, { systemRole: 'teacher' });
    const { cookie } = await createSchoolSession(db, other, theirTeacher);
    const theirSection = await createSection(db, other, await createClass(db, other, await createAcademicYear(db, other)));
    await createTeacherAssignment(db, other, theirTeacher, { role: 'class_teacher', section: theirSection, startsOn: schoolDay(-1) });
    // Another school's teacher sees only its own school's section.
    const res = await h.get('/api/v1/test-scope', cookie);
    expect(res.body).toEqual({ kind: 'sections', ids: [String(theirSection.id)] });
  });
});
