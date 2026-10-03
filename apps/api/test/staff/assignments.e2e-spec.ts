// Teacher assignments end to end (contracts/slice-4.md §4): create, list, end, the class-teacher
// rule (R23) and its exclusion constraint, and the seams in the academic structure (§4.5).
import { ErrorCode } from '@asms/shared';
import { mapDatabaseError, summariseDatabaseError } from '../../src/common/errors/prisma-errors';
import { TeacherAssignmentRepository } from '../../src/repositories/teacher-assignment.repository';
import { createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, type TestSchool } from '../support/schools';
import {
  createAcademicYear,
  createClass,
  createSection,
  createSubject,
  createTeacherAssignment,
  day,
  type TestAcademicYear,
  type TestClass,
  type TestSection,
} from '../support/students';
import { errorOf, ID, schoolDay, StaffHarness, type Caller } from './support';

interface Assignment {
  id: string;
  staffId: string;
  staffFullName: string;
  classId: string;
  sectionId: string | null;
  subjectId: string | null;
  role: string;
  startsOn: string;
  endsOn: string | null;
  voidedAt: string | null;
  activeToday: boolean;
}

describe('teacher assignments (e2e)', () => {
  const h = new StaffHarness();
  const db = h.db;
  let school: TestSchool;
  let principal: Caller;
  let year: TestAcademicYear;
  let klass: TestClass;
  let subjectId: bigint;

  const forStaff = (staff: { staffId: bigint }) => `/api/v1/staff/${staff.staffId}/teacher-assignments`;
  const create = (staff: { staffId: bigint }, body: object, cookie = principal.cookie) =>
    h.send('post', forStaff(staff), body, cookie);
  const end = (id: string | bigint, body: object = {}, cookie = principal.cookie) =>
    h.send('post', `/api/v1/teacher-assignments/${id}/end`, body, cookie);
  const list = async (staff: { staffId: bigint }, query = '') => {
    const res = await h.get(`${forStaff(staff)}?${query}`, principal.cookie);
    expect(res.status).toBe(200);
    return (res.body as { data: Assignment[] }).data;
  };
  const teacher = (fullName?: string): Promise<TestSchoolUser> =>
    createSchoolUser(db, school, { systemRole: 'teacher', ...(fullName ? { fullName } : {}) });
  const section = (k: TestClass = klass): Promise<TestSection> => createSection(db, school, k);
  const classTeacher = (s: TestSection, extra: object = {}) => ({
    role: 'class_teacher',
    classId: String(s.classId),
    sectionId: String(s.id),
    ...extra,
  });
  const auditFor = (id: string | bigint) =>
    db.auditLog.findMany({
      where: { schoolId: school.id, subjectType: 'teacher_assignment', subjectId: BigInt(id) },
      orderBy: { id: 'asc' },
    });

  beforeAll(async () => {
    await h.start();
    school = await createSchool();
    principal = await h.caller(school, 'principal');
    year = await createAcademicYear(db, school);
    klass = await createClass(db, school, year);
    subjectId = (await createSubject(db, school, { name: 'Mathematics' })).id;
  });

  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  it('needs class.manage: office staff and teachers are refused', async () => {
    const t = await teacher();
    const s = await section();
    for (const role of ['office_staff', 'teacher'] as const) {
      const caller = await h.caller(school, role);
      expect((await h.get(forStaff(t), caller.cookie)).status).toBe(403);
      expect((await create(t, classTeacher(s), caller.cookie)).status).toBe(403);
      expect((await end('1', {}, caller.cookie)).status).toBe(403);
    }
  });

  describe('R74: nobody widens their own scope (§4.3)', () => {
    /** A teacher who holds class.manage by a grant row, as slice 7 makes it delegable. */
    const teacherWithClassManage = async (): Promise<Caller> => {
      const caller = await h.caller(school, 'teacher');
      const granted = await h.send(
        'post',
        `/api/v1/users/${caller.userId}/grants`,
        { capability: 'class.manage', effect: 'grant', reason: 'Timetable coordinator' },
        principal.cookie,
      );
      expect(granted.status).toBe(201);
      return caller;
    };

    it('a class.manage holder cannot assign themselves: 409 SELF_ACTION_FORBIDDEN, nothing written', async () => {
      const caller = await teacherWithClassManage();
      const s = await section();
      for (const body of [classTeacher(s), { role: 'subject_teacher', classId: String(klass.id), subjectId: String(subjectId) }]) {
        const res = await create(caller, body, caller.cookie);
        expect(res.status).toBe(409);
        expect(errorOf(res).code).toBe(ErrorCode.SELF_ACTION_FORBIDDEN);
      }
      expect(await db.teacherAssignment.count({ where: { schoolId: school.id, staffId: caller.staffId } })).toBe(0);
    });

    it('the same holder may assign another staff member, and end their own row (it only narrows)', async () => {
      const caller = await teacherWithClassManage();
      const other = await teacher();
      const res = await create(other, classTeacher(await section()), caller.cookie);
      expect(res.status).toBe(201);
      const own = await createTeacherAssignment(db, school, caller, {
        role: 'subject_teacher',
        subjectId,
        klass,
        startsOn: schoolDay(-3),
      });
      const ended = await end(own.id, {}, caller.cookie);
      expect(ended.status).toBe(200);
      expect((ended.body as Assignment).endsOn).toBe(schoolDay(-1));
    });

    it('a principal (role.manage) may assign themselves', async () => {
      const self = await h.caller(school, 'principal');
      const res = await create(self, classTeacher(await section()), self.cookie);
      expect(res.status).toBe(201);
      expect((res.body as Assignment).staffId).toBe(String(self.staffId));
    });
  });

  describe('POST /staff/:id/teacher-assignments', () => {
    it('creates a class teacher from today by default; the year is the class’s; audited', async () => {
      const t = await teacher('Saima Bibi');
      const s = await section();
      const res = await create(t, classTeacher(s));
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: expect.stringMatching(ID),
        staffId: String(t.staffId),
        staffFullName: 'Saima Bibi',
        academicYearId: String(year.id),
        academicYearName: expect.any(String),
        classId: String(klass.id),
        className: expect.any(String),
        sectionId: String(s.id),
        sectionName: expect.any(String),
        subjectId: null,
        subjectName: null,
        role: 'class_teacher',
        startsOn: schoolDay(),
        endsOn: null,
        voidedAt: null,
        activeToday: true,
        createdAt: expect.any(String),
      });
      const id = (res.body as Assignment).id;
      expect((await auditFor(id)).map((a) => [a.action, a.metadata, a.actorUserId])).toEqual([
        [
          'teacher_assignment.created',
          {
            staffId: String(t.staffId),
            role: 'class_teacher',
            classId: String(klass.id),
            sectionId: String(s.id),
            subjectId: null,
            startsOn: schoolDay(),
            endsOn: null,
          },
          principal.userId,
        ],
      ]);
    });

    it('a subject teacher with no section covers the class; a staff member needs no teacher role', async () => {
      const office = await createSchoolUser(db, school, { systemRole: 'office_staff' });
      const res = await create(office, {
        role: 'subject_teacher',
        classId: String(klass.id),
        sectionId: null,
        subjectId: String(subjectId),
        endsOn: schoolDay(30),
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ sectionId: null, subjectName: 'Mathematics', endsOn: schoolDay(30) });
    });

    it('in a year that has not begun, starts on the year’s first day by default', async () => {
      const later = await createAcademicYear(db, school, { startsOn: schoolDay(20), endsOn: schoolDay(300), status: 'planned' });
      const k = await createClass(db, school, later);
      const s = await createSection(db, school, k);
      const res = await create(await teacher(), classTeacher(s));
      expect(res.body).toMatchObject({ startsOn: schoolDay(20), activeToday: false });
    });

    it('422 on role-dependent shape, references outside the school and dates', async () => {
      const t = await teacher();
      const s = await section();
      const otherClass = await createClass(db, school, year);
      const sectionOfOther = await createSection(db, school, otherClass);
      const elsewhere = await createSchool();
      const theirYear = await createAcademicYear(db, elsewhere);
      const theirClass = await createClass(db, elsewhere, theirYear);
      const theirSubject = await createSubject(db, elsewhere);
      const cases: [object, string, string][] = [
        [{ role: 'class_teacher', classId: String(klass.id) }, 'sectionId', 'INVALID_VALUE'],
        [classTeacher(s, { subjectId: String(subjectId) }), 'subjectId', 'INVALID_VALUE'],
        [{ role: 'subject_teacher', classId: String(klass.id) }, 'subjectId', 'INVALID_VALUE'],
        [
          { role: 'subject_teacher', classId: String(klass.id), subjectId: String(subjectId), replaceCurrent: true },
          'replaceCurrent',
          'INVALID_VALUE',
        ],
        [classTeacher(s, { classId: String(theirClass.id) }), 'classId', 'REFERENCE_NOT_FOUND'],
        [classTeacher(sectionOfOther, { classId: String(klass.id) }), 'sectionId', 'REFERENCE_NOT_FOUND'],
        [
          { role: 'subject_teacher', classId: String(klass.id), subjectId: String(theirSubject.id) },
          'subjectId',
          'REFERENCE_NOT_FOUND',
        ],
        [classTeacher(s, { startsOn: schoolDay(-1) }), 'startsOn', 'INVALID_VALUE'],
        [classTeacher(s, { startsOn: year.endsOn.replace(/^(\d{4})/, (y) => String(Number(y) + 1)) }), 'startsOn', 'INVALID_VALUE'],
        [classTeacher(s, { startsOn: schoolDay(5), endsOn: schoolDay(4) }), 'endsOn', 'INVALID_VALUE'],
        [classTeacher(s, { endsOn: year.endsOn.replace(/^(\d{4})/, (y) => String(Number(y) + 1)) }), 'endsOn', 'INVALID_VALUE'],
        [classTeacher(s, { academicYearId: String(year.id) }), 'academicYearId', 'UNKNOWN_FIELD'],
        [classTeacher(s, { role: 'head' }), 'role', 'INVALID_VALUE'],
        [classTeacher(s, { classId: 'abc' }), 'classId', 'INVALID_VALUE'],
      ];
      for (const [body, path, code] of cases) {
        const res = await create(t, body);
        expect([res.status, errorOf(res).details]).toEqual([
          422,
          { fields: [expect.objectContaining({ path, code })] },
        ]);
      }
      expect(await db.teacherAssignment.count({ where: { schoolId: school.id, staffId: t.staffId } })).toBe(0);
      expect((await create({ staffId: 999_999_999_999n }, classTeacher(s))).status).toBe(404);
    });

    it('409 for an inactive staff member, a closed year, archived class, section or subject', async () => {
      const t = await teacher();
      const s = await section();
      const suspended = await createSchoolUser(db, school, { systemRole: 'teacher', staffStatus: 'suspended' });
      expect(errorOf(await create(suspended, classTeacher(s))).code).toBe('STAFF_NOT_ACTIVE');

      const closed = await createAcademicYear(db, school, { status: 'closed' });
      const inClosed = await createSection(db, school, await createClass(db, school, closed));
      expect(errorOf(await create(t, classTeacher(inClosed))).code).toBe('ACADEMIC_YEAR_CLOSED');

      const archivedClass = await createClass(db, school, year, { status: 'archived' });
      const inArchived = await createSection(db, school, archivedClass);
      expect(errorOf(await create(t, classTeacher(inArchived))).code).toBe('CLASS_ARCHIVED');

      const archivedSection = await createSection(db, school, klass, { deletedAt: new Date() });
      expect(errorOf(await create(t, classTeacher(archivedSection))).code).toBe('SECTION_ARCHIVED');

      const archivedSubject = await db.subject.create({
        data: { schoolId: school.id, name: `Old ${s.id}`, deletedAt: new Date() },
      });
      const res = await create(t, { role: 'subject_teacher', classId: String(klass.id), subjectId: String(archivedSubject.id) });
      expect(errorOf(res).code).toBe('SUBJECT_ARCHIVED');
    });

    it('a resubmit of the same live assignment is ASSIGNMENT_EXISTS with a pointer', async () => {
      const t = await teacher();
      const body = { role: 'subject_teacher', classId: String(klass.id), subjectId: String(subjectId) };
      const first = (await create(t, body)).body as Assignment;
      const again = await create(t, body);
      expect(again.status).toBe(409);
      expect(errorOf(again)).toMatchObject({ code: 'ASSIGNMENT_EXISTS', details: { assignmentId: first.id } });
      // The same subject in one section is a different assignment.
      const s = await section();
      expect((await create(t, { ...body, sectionId: String(s.id) })).status).toBe(201);
    });

    it('R23: a second class teacher is refused with the conflict listed; replaceCurrent voids one begun today', async () => {
      const s = await section();
      const a = await teacher('First Teacher');
      const b = await teacher('Second Teacher');
      const current = (await create(a, classTeacher(s))).body as Assignment;
      const refused = await create(b, classTeacher(s));
      expect(refused.status).toBe(409);
      expect(errorOf(refused)).toMatchObject({
        code: 'CLASS_TEACHER_EXISTS',
        details: {
          conflicts: [
            {
              assignmentId: current.id,
              staffId: String(a.staffId),
              staffFullName: 'First Teacher',
              startsOn: schoolDay(),
              endsOn: null,
            },
          ],
        },
      });
      // Subject teachers of the section do not count.
      expect((await create(b, { role: 'subject_teacher', classId: String(klass.id), sectionId: String(s.id), subjectId: String(subjectId) })).status).toBe(201);

      const replaced = await create(b, classTeacher(s, { replaceCurrent: true }));
      expect(replaced.status).toBe(201);
      const old = await db.teacherAssignment.findFirst({ where: { schoolId: school.id, id: BigInt(current.id) } });
      expect(old).toMatchObject({ voidedBy: principal.userId, endsOn: null });
      const newId = (replaced.body as Assignment).id;
      expect((await auditFor(current.id)).map((r) => [r.action, r.metadata])).toEqual([
        ['teacher_assignment.created', expect.any(Object)],
        ['teacher_assignment.ended', { voided: true, replacedBy: newId }],
      ]);
    });

    it('R23: replacing from tomorrow ends a class teacher who began earlier on today', async () => {
      const s = await section();
      const a = await teacher();
      const b = await teacher();
      const current = await createTeacherAssignment(db, school, a, { role: 'class_teacher', section: s, startsOn: schoolDay(-20) });
      const res = await create(b, classTeacher(s, { startsOn: schoolDay(1), replaceCurrent: true }));
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ startsOn: schoolDay(1), activeToday: false });
      const old = await db.teacherAssignment.findFirst({ where: { schoolId: school.id, id: current.id } });
      expect(old).toMatchObject({ endsOn: day(schoolDay()), voidedAt: null });
      expect((await auditFor(current.id)).map((r) => r.metadata)).toEqual([
        { endsOn: schoolDay(), replacedBy: (res.body as Assignment).id },
      ]);
      const [ofA] = await list(a);
      expect(ofA).toMatchObject({ endsOn: schoolDay(), activeToday: true });
    });

    it('R23: sequential class teachers are allowed; a shared day is not', async () => {
      const s = await section();
      const a = await teacher();
      const b = await teacher();
      expect((await create(a, classTeacher(s, { endsOn: schoolDay(14) }))).status).toBe(201);
      expect(errorOf(await create(b, classTeacher(s, { startsOn: schoolDay(14) }))).code).toBe('CLASS_TEACHER_EXISTS');
      expect((await create(b, classTeacher(s, { startsOn: schoolDay(15) }))).status).toBe(201);
    });
  });

  describe('the exclusion constraint teacher_assignments_class_teacher_excl', () => {
    it('refuses overlapping live class teachers in the database; voided rows and sequential ones pass', async () => {
      const s = await section();
      const a = await teacher();
      const b = await teacher();
      await createTeacherAssignment(db, school, a, { role: 'class_teacher', section: s, startsOn: schoolDay(1), endsOn: schoolDay(10) });
      const error: unknown = await createTeacherAssignment(db, school, b, {
        role: 'class_teacher',
        section: s,
        startsOn: schoolDay(10),
      }).catch((e: unknown) => e);
      expect(summariseDatabaseError(error)).toEqual({
        prismaCode: 'P2039',
        constraint: 'teacher_assignments_class_teacher_excl',
      });
      expect(mapDatabaseError(error)).toMatchObject({ status: 409, code: ErrorCode.CLASS_TEACHER_EXISTS });
      await expect(
        createTeacherAssignment(db, school, b, { role: 'class_teacher', section: s, startsOn: schoolDay(11) }),
      ).resolves.toBeDefined();
      await expect(
        createTeacherAssignment(db, school, b, { role: 'class_teacher', section: s, startsOn: schoolDay(2), voidedBy: principal.userId }),
      ).resolves.toBeDefined();
    });
  });

  describe('the R23 race fallback', () => {
    afterEach(() => jest.restoreAllMocks());

    it('re-reads conflicts from the default start the transaction used: the year start when the year has not begun', async () => {
      const future = await createAcademicYear(db, school, { startsOn: schoolDay(30), endsOn: schoolDay(300) });
      const k = await createClass(db, school, future);
      const s = await section(k);
      const holder = await teacher();
      await createTeacherAssignment(db, school, holder, { role: 'class_teacher', section: s, startsOn: schoolDay(30) });
      // The in-transaction check sees nothing, as when a concurrent insert commits after it: the
      // exclusion constraint then aborts the insert and the fallback reads the conflicts again.
      const repository = h.app.get(TeacherAssignmentRepository);
      const spy = jest.spyOn(repository, 'findClassTeacherConflicts').mockResolvedValueOnce([]);
      const res = await create(await teacher(), classTeacher(s));
      expect(errorOf(res).code).toBe('CLASS_TEACHER_EXISTS');
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls.map((call) => call[2].toISOString().slice(0, 10))).toEqual([
        schoolDay(30),
        schoolDay(30),
      ]);
    });
  });

  describe('POST /teacher-assignments/:id/end', () => {
    it('without endsOn: begun before today ends yesterday; begun today or later is voided', async () => {
      const t = await teacher();
      const s = await section();
      const begun = await createTeacherAssignment(db, school, t, { role: 'class_teacher', section: s, startsOn: schoolDay(-5) });
      const res = await end(begun.id, { reason: 'Moved to another class' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ endsOn: schoolDay(-1), voidedAt: null, activeToday: false });
      const audit = await auditFor(begun.id);
      expect(audit.map((r) => [r.action, r.reason, r.metadata])).toEqual([
        ['teacher_assignment.ended', 'Moved to another class', { endsOn: schoolDay(-1) }],
      ]);

      for (const startsOn of [schoolDay(0), schoolDay(3)]) {
        const row = await createTeacherAssignment(db, school, t, { role: 'subject_teacher', subjectId, section: s, startsOn });
        const voided = await end(row.id);
        expect(voided.body).toMatchObject({ voidedAt: expect.any(String), endsOn: null, activeToday: false });
        expect((await auditFor(row.id)).map((r) => r.metadata)).toEqual([{ voided: true }]);
      }
    });

    it('with endsOn: a planned last day, today or later, within the row', async () => {
      const t = await teacher();
      const s = await section();
      const row = await createTeacherAssignment(db, school, t, {
        role: 'class_teacher',
        section: s,
        startsOn: schoolDay(-5),
        endsOn: schoolDay(20),
      });
      for (const endsOn of [schoolDay(-1), schoolDay(21), 'tomorrow']) {
        const res = await end(row.id, { endsOn });
        expect(res.status).toBe(422);
      }
      const future = await createTeacherAssignment(db, school, t, { role: 'subject_teacher', subjectId, section: s, startsOn: schoolDay(5) });
      expect((await end(future.id, { endsOn: schoolDay(4) })).status).toBe(422);
      const planned = await end(row.id, { endsOn: schoolDay(10) });
      expect(planned.body).toMatchObject({ endsOn: schoolDay(10), activeToday: true });
      expect((await auditFor(row.id)).map((r) => r.metadata)).toEqual([{ endsOn: schoolDay(10) }]);
    });

    it('already voided or ended before today: 200, unchanged, no audit; another school’s id is 404', async () => {
      const t = await teacher();
      const s = await section();
      const voided = await createTeacherAssignment(db, school, t, { role: 'class_teacher', section: s, startsOn: schoolDay(2), voidedBy: principal.userId });
      const ended = await createTeacherAssignment(db, school, t, { role: 'subject_teacher', subjectId, section: s, startsOn: schoolDay(-9), endsOn: schoolDay(-2) });
      for (const row of [voided, ended]) {
        const res = await end(row.id, { endsOn: schoolDay(30) });
        expect(res.status).toBe(200);
        expect(await auditFor(row.id)).toEqual([]);
      }
      const other = await createSchool();
      const theirs = await createSchoolUser(db, other, { systemRole: 'teacher' });
      const theirYear = await createAcademicYear(db, other);
      const theirSection = await createSection(db, other, await createClass(db, other, theirYear));
      const row = await createTeacherAssignment(db, other, theirs, { role: 'class_teacher', section: theirSection });
      expect((await end(row.id)).status).toBe(404);
      expect(await db.teacherAssignment.findFirst({ where: { schoolId: other.id, id: row.id } })).toMatchObject({ voidedAt: null, endsOn: null });
      expect((await end('abc')).status).toBe(404);
    });
  });

  describe('GET /staff/:id/teacher-assignments', () => {
    it('hides ended and voided rows unless includeEnded; filters by year; sorts', async () => {
      const t = await teacher();
      const s = await section();
      const current = await createTeacherAssignment(db, school, t, { role: 'class_teacher', section: s, startsOn: schoolDay(-3) });
      const future = await createTeacherAssignment(db, school, t, { role: 'subject_teacher', subjectId, klass, startsOn: schoolDay(4) });
      const ended = await createTeacherAssignment(db, school, t, { role: 'subject_teacher', subjectId, section: s, startsOn: schoolDay(-30), endsOn: schoolDay(-1) });
      const voided = await createTeacherAssignment(db, school, t, { role: 'subject_teacher', subjectId, section: s, startsOn: schoolDay(1), voidedBy: principal.userId });
      const ids = (rows: Assignment[]) => rows.map((r) => r.id);
      expect(ids(await list(t))).toEqual([String(future.id), String(current.id)]);
      expect(ids(await list(t, 'sort=startsOn'))).toEqual([String(current.id), String(future.id)]);
      expect(ids(await list(t, 'includeEnded=true'))).toEqual(
        [future, voided, current, ended].map((r) => String(r.id)),
      );
      const rows = await list(t, 'includeEnded=true');
      expect(rows.map((r) => r.activeToday)).toEqual([false, false, true, false]);
      expect(await list(t, `academicYearId=${999_999_999}`)).toEqual([]);
      expect(ids(await list(t, `academicYearId=${year.id}&sort=className`))).toHaveLength(2);
      expect((await h.get(`${forStaff(t)}?includeEnded=1`, principal.cookie)).status).toBe(422);
      expect((await h.get(`/api/v1/staff/999999999/teacher-assignments`, principal.cookie)).status).toBe(404);
    });
  });

  describe('seams in the academic structure (§4.5)', () => {
    it('a section with a live assignment cannot be archived; an ended one does not block', async () => {
      const t = await teacher();
      const s = await section();
      const row = await createTeacherAssignment(db, school, t, { role: 'class_teacher', section: s, startsOn: schoolDay(3) });
      const refused = await h.send('post', `/api/v1/sections/${s.id}/archive`, {}, principal.cookie);
      expect(refused.status).toBe(409);
      expect(errorOf(refused).code).toBe('SECTION_IN_USE');
      expect((await end(row.id)).status).toBe(200);
      const ended = await section();
      await createTeacherAssignment(db, school, t, { role: 'class_teacher', section: ended, startsOn: schoolDay(-9), endsOn: schoolDay(-1) });
      for (const id of [s.id, ended.id]) {
        expect((await h.send('post', `/api/v1/sections/${id}/archive`, {}, principal.cookie)).status).toBe(200);
      }
    });

    it('CLASS_YEAR_IMMUTABLE: a class named by an assignment keeps its year, even with no section', async () => {
      const k = await createClass(db, school, year);
      const target = await createAcademicYear(db, school);
      await createTeacherAssignment(db, school, await teacher(), { role: 'subject_teacher', subjectId, klass: k, startsOn: schoolDay(1), voidedBy: principal.userId });
      const res = await h.send('patch', `/api/v1/classes/${k.id}`, { academicYearId: String(target.id) }, principal.cookie);
      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({ code: 'CLASS_YEAR_IMMUTABLE', details: { field: 'academicYearId' } });
    });
  });
});
