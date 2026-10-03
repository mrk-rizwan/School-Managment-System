// Cover assignments end to end (contracts/slice-10.md §6; R132, R175 cover cases): shape, F1,
// the covered row, the assignee capability, retry-safety, scope for exactly the cover's dates
// (lapsing with no write), /me, and the one cover_assigned message.
import { ErrorCode } from '@asms/shared';
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
import { errorOf, schoolDay, StaffHarness, type Caller } from './support';

interface Assignment {
  id: string;
  staffId: string;
  role: string;
  sectionId: string | null;
  subjectId: string | null;
  startsOn: string;
  endsOn: string | null;
  activeToday: boolean;
  coversAssignmentId: string | null;
  coversStaffFullName: string | null;
}

type ScopeBody = { kind: 'all' } | { kind: 'sections'; ids: string[] };

describe('cover assignments (e2e)', () => {
  const h = new StaffHarness();
  const db = h.db;
  let school: TestSchool;
  let principal: Caller;
  let klass: TestClass;

  const forStaff = (staff: { staffId: bigint }) => `/api/v1/staff/${staff.staffId}/teacher-assignments`;
  const create = (staff: { staffId: bigint }, body: object, cookie = principal.cookie) =>
    h.send('post', forStaff(staff), body, cookie);
  const teacher = (fullName?: string): Promise<TestSchoolUser> =>
    createSchoolUser(db, school, { systemRole: 'teacher', ...(fullName ? { fullName } : {}) });
  const section = (): Promise<TestSection> => createSection(db, school, klass);
  const cover = (s: TestSection, extra: object = {}) => ({
    role: 'cover',
    classId: String(s.classId),
    sectionId: String(s.id),
    endsOn: schoolDay(4),
    ...extra,
  });
  const fieldOf = (res: { body: unknown }) =>
    (errorOf(res).details as { fields: { path: string; code: string }[] }).fields;
  const asCaller = async (user: TestSchoolUser): Promise<Caller> => ({
    ...user,
    cookie: (await createSchoolSession(db, school, user)).cookie,
  });
  const scopeIds = async (caller: Caller) => {
    const res = await h.get('/api/v1/test-scope', caller.cookie);
    expect(res.status).toBe(200);
    const body = res.body as ScopeBody;
    if (body.kind !== 'sections') throw new Error(`expected sections, got ${body.kind}`);
    return body.ids;
  };
  /** A section with a class teacher who began three days ago, open-ended. */
  const coveredSection = async () => {
    const s = await section();
    const absent = await teacher('Absent Teacher');
    const row = await createTeacherAssignment(db, school, absent, {
      role: 'class_teacher',
      section: s,
      startsOn: schoolDay(-3),
    });
    return { s, absent, row };
  };

  beforeAll(async () => {
    await h.start();
    school = await createSchool();
    principal = await h.caller(school, 'principal');
    klass = await createClass(db, school, await createAcademicYear(db, school));
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await h.app.close();
    await closeTestDb();
  });

  it('R132: a cover is created for the covering teacher, never displacing the class teacher (no CLASS_TEACHER_EXISTS)', async () => {
    const { s, row } = await coveredSection();
    const covering = await teacher('Cover Teacher');
    const res = await create(covering, cover(s, { coversAssignmentId: String(row.id) }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      staffId: String(covering.staffId),
      role: 'cover',
      sectionId: String(s.id),
      subjectId: null,
      startsOn: schoolDay(),
      endsOn: schoolDay(4),
      activeToday: true,
      coversAssignmentId: String(row.id),
      coversStaffFullName: 'Absent Teacher',
    });
    // The class teacher's row is untouched.
    const covered = await db.teacherAssignment.findFirst({ where: { schoolId: school.id, id: row.id } });
    expect(covered).toMatchObject({ endsOn: null, voidedAt: null });
    // Audit carries the covered row.
    const [audit] = await db.auditLog.findMany({
      where: { schoolId: school.id, subjectType: 'teacher_assignment', subjectId: BigInt((res.body as Assignment).id) },
    });
    expect(audit).toMatchObject({
      action: 'teacher_assignment.created',
      metadata: expect.objectContaining({ role: 'cover', coversAssignmentId: String(row.id) }) as unknown,
    });
    // A second cover by another teacher on overlapping dates is allowed (a split week).
    const second = await create(await teacher(), cover(s, { endsOn: schoolDay(2) }));
    expect(second.status).toBe(201);
  });

  it('R132: shape refusals — section and last day required, no subject, no replaceCurrent; coversAssignmentId only on a cover', async () => {
    const s = await section();
    const t = await teacher();
    const subjectId = (await createSubject(db, school)).id;
    const cases: [object, string][] = [
      [cover(s, { sectionId: undefined }), 'sectionId'],
      [cover(s, { endsOn: undefined }), 'endsOn'],
      [cover(s, { endsOn: null }), 'endsOn'],
      [cover(s, { subjectId: String(subjectId) }), 'subjectId'],
      [cover(s, { replaceCurrent: true }), 'replaceCurrent'],
      [
        { role: 'class_teacher', classId: String(klass.id), sectionId: String(s.id), coversAssignmentId: '1' },
        'coversAssignmentId',
      ],
    ];
    for (const [body, path] of cases) {
      const res = await create(t, body);
      expect(res.status).toBe(422);
      expect(fieldOf(res)).toEqual([expect.objectContaining({ path, code: ErrorCode.INVALID_VALUE })]);
    }
    expect(await db.teacherAssignment.count({ where: { schoolId: school.id, staffId: t.staffId } })).toBe(0);
  });

  it('R132 / R175: dates — not before today, the last day not before the start nor after the year', async () => {
    const s = await section();
    const t = await teacher();
    for (const [body, path] of [
      [cover(s, { startsOn: schoolDay(-1) }), 'startsOn'],
      [cover(s, { startsOn: schoolDay(3), endsOn: schoolDay(2) }), 'endsOn'],
      [cover(s, { endsOn: schoolDay(400) }), 'endsOn'],
    ] as const) {
      const res = await create(t, body);
      expect(res.status).toBe(422);
      expect(fieldOf(res)[0]).toMatchObject({ path });
    }
  });

  it('R132: coversAssignmentId must be another teacher’s live class-teacher row of the section overlapping the dates', async () => {
    const { s, absent, row } = await coveredSection();
    const t = await teacher();
    const other = await section();
    const otherTeacher = await createTeacherAssignment(db, school, await teacher(), {
      role: 'class_teacher',
      section: other,
    });
    const ended = await createTeacherAssignment(db, school, await teacher(), {
      role: 'class_teacher',
      section: await section(),
      startsOn: schoolDay(-10),
      endsOn: schoolDay(-5),
    });
    expect(fieldOf(await create(t, cover(s, { coversAssignmentId: '999999999999' })))).toEqual([
      expect.objectContaining({ path: 'coversAssignmentId', code: ErrorCode.REFERENCE_NOT_FOUND }),
    ]);
    // Another section's class teacher.
    expect(fieldOf(await create(t, cover(s, { coversAssignmentId: String(otherTeacher.id) })))).toEqual([
      expect.objectContaining({ path: 'coversAssignmentId', code: ErrorCode.INVALID_VALUE }),
    ]);
    // A row that ended before the cover begins (same section check aside, it does not overlap).
    const endedSection = await db.teacherAssignment.findFirst({ where: { schoolId: school.id, id: ended.id } });
    const endedRes = await create(t, {
      role: 'cover',
      classId: String(klass.id),
      sectionId: String(endedSection!.sectionId),
      endsOn: schoolDay(2),
      coversAssignmentId: String(ended.id),
    });
    expect(fieldOf(endedRes)[0]).toMatchObject({ path: 'coversAssignmentId', code: ErrorCode.INVALID_VALUE });
    // Covering one's own row.
    const ownRes = await create(absent, cover(s, { coversAssignmentId: String(row.id) }));
    expect(fieldOf(ownRes)[0]).toMatchObject({ path: 'coversAssignmentId', code: ErrorCode.INVALID_VALUE });
  });

  it('R132 / F1: a non-principal holder of class.manage cannot assign themselves a cover; a principal may', async () => {
    const s = await section();
    const caller = await h.caller(school, 'teacher');
    const granted = await h.send(
      'post',
      `/api/v1/users/${caller.userId}/grants`,
      { capability: 'class.manage', effect: 'grant', reason: 'Timetable coordinator' },
      principal.cookie,
    );
    expect(granted.status).toBe(201);
    const res = await create(caller, cover(s), caller.cookie);
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe(ErrorCode.SELF_ACTION_FORBIDDEN);
    const self = await h.caller(school, 'principal');
    expect((await create(self, cover(s), self.cookie)).status).toBe(201);
  });

  it('R132: the covering staff member must hold attendance.student.mark — 409 CAPABILITY_NOT_HELD, nothing written', async () => {
    const s = await section();
    const t = await teacher();
    const revoked = await h.send(
      'post',
      `/api/v1/users/${t.userId}/grants`,
      { capability: 'attendance.student.mark', effect: 'revoke', reason: 'Not marking this term' },
      principal.cookie,
    );
    expect(revoked.status).toBe(201);
    const res = await create(t, cover(s));
    expect(res.status).toBe(409);
    expect(errorOf(res)).toMatchObject({
      code: ErrorCode.CAPABILITY_NOT_HELD,
      details: { capability: 'attendance.student.mark' },
    });
    expect(await db.teacherAssignment.count({ where: { schoolId: school.id, staffId: t.staffId } })).toBe(0);
    // Office staff hold it school-wide (Phase 2 §1.2), so a clerk may cover.
    const clerk = await createSchoolUser(db, school, { systemRole: 'office_staff' });
    expect((await create(clerk, cover(s))).status).toBe(201);
  });

  it('R132: a resubmit of the same cover is 409 ASSIGNMENT_EXISTS naming the row', async () => {
    const s = await section();
    const t = await teacher();
    const first = await create(t, cover(s));
    expect(first.status).toBe(201);
    const again = await create(t, cover(s, { endsOn: schoolDay(6) }));
    expect(again.status).toBe(409);
    expect(errorOf(again)).toMatchObject({
      code: ErrorCode.ASSIGNMENT_EXISTS,
      details: { assignmentId: (first.body as Assignment).id },
    });
  });

  it('R132 / R175: the cover gives the section for exactly its dates and lapses the day after with no write; /me lists it on those dates', async () => {
    const { s, row } = await coveredSection();
    const user = await teacher('Dated Cover');
    const caller = await asCaller(user);
    const res = await create(user, cover(s, { startsOn: schoolDay(1), endsOn: schoolDay(2), coversAssignmentId: String(row.id) }));
    expect(res.status).toBe(201);
    const id = BigInt((res.body as Assignment).id);
    const before = await db.teacherAssignment.findFirst({ where: { schoolId: school.id, id } });

    const clock = h.app.get(SchoolClock);
    const at = (offset: number) =>
      jest.spyOn(clock, 'now').mockReturnValue(new Date(Date.now() + offset * 86_400_000));
    const meAssignments = async () =>
      ((await h.get('/api/v1/me', caller.cookie)).body as { assignments: { id: string }[] }).assignments.map(
        (a) => a.id,
      );

    expect(await scopeIds(caller)).toEqual([]); // before startsOn
    expect(await meAssignments()).toEqual([]);
    at(1);
    expect(await scopeIds(caller)).toEqual([String(s.id)]);
    expect(await meAssignments()).toEqual([String(id)]);
    at(2);
    expect(await scopeIds(caller)).toEqual([String(s.id)]);
    at(3);
    expect(await scopeIds(caller)).toEqual([]); // the day after endsOn
    expect(await meAssignments()).toEqual([]);
    jest.restoreAllMocks();

    // Lapsing wrote nothing.
    const after = await db.teacherAssignment.findFirst({ where: { schoolId: school.id, id } });
    expect(after).toEqual(before);
  });

  it('R132: ending a cover uses the ordinary end route and sends nothing', async () => {
    const s = await section();
    const t = await teacher();
    const created = await create(t, cover(s, { startsOn: schoolDay(1) }));
    const id = (created.body as Assignment).id;
    const before = await db.message.count({ where: { schoolId: school.id } });
    const ended = await h.send('post', `/api/v1/teacher-assignments/${id}/end`, {}, principal.cookie);
    expect(ended.status).toBe(200);
    expect((ended.body as Assignment & { voidedAt: string | null }).voidedAt).not.toBeNull();
    expect(await db.message.count({ where: { schoolId: school.id } })).toBe(before);
  });

  it('R132: the covering teacher gets exactly one cover_assigned message, addressed to them', async () => {
    const { s, row } = await coveredSection();
    const t = await teacher();
    const res = await create(t, cover(s, { coversAssignmentId: String(row.id) }));
    expect(res.status).toBe(201);
    const messages = await db.message.findMany({
      where: { schoolId: school.id, subjectType: 'teacher_assignment', subjectId: BigInt((res.body as Assignment).id) },
    });
    expect(messages).toEqual([
      expect.objectContaining({ type: 'cover_assigned', staffId: t.staffId, guardianId: null, studentId: null }),
    ]);
    // No identity number or phone in the body (R111).
    expect(messages[0]?.body ?? '').not.toMatch(/[0-9]{13}|(\+?92|0)3[0-9]{2}[\s-]?[0-9]{7}/);
  });
});
