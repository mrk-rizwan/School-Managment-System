// Dated, role-aware scope (contracts/slice-10.md §7; R175, R132): TeacherAssignmentRepository
// sectionsOn / rolesOn and PermissionsService.scopeOf(session, { capability, on }), tested as
// functions. The register and diary refusals that use them are named tests in slices 11 and 13.
import { Capability } from '@asms/shared';
import { addDays, todayIn } from '../../src/common/school-clock';
import { PermissionsService, rowScope } from '../../src/modules/access/permissions.service';
import { TeacherAssignmentRepository } from '../../src/repositories/teacher-assignment.repository';
import { createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, createTwoSchools, type TestSchool } from '../support/schools';
import {
  createAcademicYear,
  createClass,
  createSection,
  createSubject,
  createTeacherAssignment,
  day,
  type TestClass,
} from '../support/students';
import { SCHOOL_TZ, schoolDay, StaffHarness } from './support';

const NONE = { classTeacher: false, cover: false, subjectIds: [] };

describe('dated scope (R175)', () => {
  const h = new StaffHarness();
  const db = h.db;
  let school: TestSchool;
  let klass: TestClass;
  let repo: TeacherAssignmentRepository;
  let permissions: PermissionsService;

  const teacher = (): Promise<TestSchoolUser> => createSchoolUser(db, school, { systemRole: 'teacher' });
  const sessionOf = (user: TestSchoolUser, s: TestSchool = school) => h.widenedSession(s, user.userId, []);
  const on = (offset: number) => day(schoolDay(offset));

  beforeAll(async () => {
    await h.start();
    school = await createSchool();
    klass = await createClass(db, school, await createAcademicYear(db, school));
    repo = h.app.get(TeacherAssignmentRepository);
    permissions = h.app.get(PermissionsService);
  });

  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  it('R175 / R132: a cover counts inside its dates only — absent before startsOn and the day after endsOn', async () => {
    const s = await createSection(db, school, klass);
    const t = await teacher();
    await createTeacherAssignment(db, school, t, {
      role: 'cover',
      section: s,
      startsOn: schoolDay(2),
      endsOn: schoolDay(4),
    });
    expect(await repo.rolesOn(school.id, t.staffId, s.id, on(1))).toEqual(NONE);
    for (const offset of [2, 3, 4]) {
      expect(await repo.rolesOn(school.id, t.staffId, s.id, on(offset))).toEqual({
        classTeacher: false,
        cover: true,
        subjectIds: [],
      });
    }
    expect(await repo.rolesOn(school.id, t.staffId, s.id, on(5))).toEqual(NONE);
  });

  it('R175: a voided row never counts; a class-teacher row sets classTeacher', async () => {
    const s = await createSection(db, school, klass);
    const t = await teacher();
    const principal = await createSchoolUser(db, school, { systemRole: 'principal' });
    await createTeacherAssignment(db, school, t, {
      role: 'class_teacher',
      section: s,
      startsOn: schoolDay(-2),
      voidedBy: principal.userId,
    });
    expect(await repo.rolesOn(school.id, t.staffId, s.id, on(0))).toEqual(NONE);
    const other = await createSection(db, school, klass);
    await createTeacherAssignment(db, school, t, { role: 'class_teacher', section: other });
    expect(await repo.rolesOn(school.id, t.staffId, other.id, on(0))).toMatchObject({
      classTeacher: true,
      cover: false,
    });
  });

  it('R175 / R54: a whole-class subject row gives its subject in every live section of the class; an archived section drops out of it', async () => {
    const own = await createClass(db, school, { id: klass.academicYearId });
    const a = await createSection(db, school, own);
    const archived = await createSection(db, school, own, { deletedAt: new Date() });
    const named = await createSection(db, school, own, { deletedAt: new Date() });
    const t = await teacher();
    const maths = (await createSubject(db, school)).id;
    const urdu = (await createSubject(db, school)).id;
    await createTeacherAssignment(db, school, t, { role: 'subject_teacher', subjectId: maths, klass: own });
    await createTeacherAssignment(db, school, t, { role: 'subject_teacher', subjectId: urdu, section: a });
    // A row naming an archived section itself still counts: only the whole-class expansion skips it.
    await createTeacherAssignment(db, school, t, { role: 'subject_teacher', subjectId: urdu, section: named });
    const sections = await repo.sectionsOn(school.id, t.staffId, on(0));
    expect([...sections.keys()]).toEqual([a.id, named.id]);
    expect(sections.has(archived.id)).toBe(false);
    expect(sections.get(a.id)).toEqual({
      classTeacher: false,
      cover: false,
      subjectIds: [maths, urdu].sort((x, y) => (x < y ? -1 : 1)),
    });
    expect(sections.get(named.id)).toEqual({ classTeacher: false, cover: false, subjectIds: [urdu] });
    expect(await repo.activeSectionIds(school.id, t.staffId, on(0))).toEqual([a.id, named.id]);
  });

  it('today’s scope is the key set of sectionsOn(today): the two cannot disagree', async () => {
    const t = await teacher();
    const s1 = await createSection(db, school, klass);
    const s2 = await createSection(db, school, klass);
    await createTeacherAssignment(db, school, t, { role: 'class_teacher', section: s1 });
    await createTeacherAssignment(db, school, t, { role: 'cover', section: s2, endsOn: schoolDay(1) });
    const today = todayIn(SCHOOL_TZ);
    expect(await repo.activeSectionIds(school.id, t.staffId, today)).toEqual([
      ...(await repo.sectionsOn(school.id, t.staffId, today)).keys(),
    ]);
    expect(await repo.activeSectionIds(school.id, t.staffId, today)).toEqual([s1.id, s2.id]);
  });

  it('R175: scopeOf — principal and office are all; a teacher gets the sections with roles on the date; empty map for none; null when not held', async () => {
    const principal = await createSchoolUser(db, school, { systemRole: 'principal' });
    const office = await createSchoolUser(db, school, { systemRole: 'office_staff' });
    for (const user of [principal, office]) {
      const scope = await permissions.scopeOf(await sessionOf(user), {
        capability: Capability.ATTENDANCE_STUDENT_MARK,
        on: on(0),
      });
      expect(scope).toMatchObject({ kind: 'all', on: on(0) });
      expect(scope && rowScope(scope)).toEqual({ kind: 'all' });
    }

    const idle = await teacher();
    const empty = await permissions.scopeOf(await sessionOf(idle), {
      capability: Capability.ATTENDANCE_STUDENT_MARK,
      on: on(0),
    });
    expect(empty?.kind).toBe('sections');
    expect(empty?.kind === 'sections' && empty.sections.size).toBe(0);
    expect(empty && rowScope(empty)).toEqual({ kind: 'sections', ids: [] });

    const t = await teacher();
    const s = await createSection(db, school, klass);
    await createTeacherAssignment(db, school, t, {
      role: 'cover',
      section: s,
      startsOn: schoolDay(1),
      endsOn: schoolDay(1),
    });
    const session = await sessionOf(t);
    const dated = await permissions.scopeOf(session, { capability: Capability.ATTENDANCE_STUDENT_MARK, on: on(1) });
    expect(dated?.kind === 'sections' && [...dated.sections.entries()]).toEqual([
      [s.id, { classTeacher: false, cover: true, subjectIds: [] }],
    ]);
    expect(dated && rowScope(dated)).toEqual({ kind: 'sections', ids: [s.id] });
    const dayAfter = await permissions.scopeOf(session, { capability: Capability.ATTENDANCE_STUDENT_MARK, on: on(2) });
    expect(dayAfter?.kind === 'sections' && dayAfter.sections.size).toBe(0);
    // A key the teacher does not hold.
    expect(await permissions.scopeOf(session, { capability: Capability.HOLIDAY_MANAGE, on: on(1) })).toBeNull();
  });

  it('R62: sectionsOn and rolesOn read only the caller’s school', async () => {
    const { a, b } = await createTwoSchools();
    const y = await createAcademicYear(db, a);
    const s = await createSection(db, a, await createClass(db, a, y));
    const t = await createSchoolUser(db, a, { systemRole: 'teacher' });
    await createTeacherAssignment(db, a, t, { role: 'class_teacher', section: s });
    const today = addDays(todayIn(SCHOOL_TZ), 0);
    expect([...(await repo.sectionsOn(a.id, t.staffId, today)).keys()]).toEqual([s.id]);
    expect((await repo.sectionsOn(b.id, t.staffId, today)).size).toBe(0);
    expect(await repo.rolesOn(b.id, t.staffId, s.id, today)).toEqual(NONE);
  });
});
