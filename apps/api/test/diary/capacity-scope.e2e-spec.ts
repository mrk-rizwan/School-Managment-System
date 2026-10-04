// The guardian and student capacity scope (contracts/slice-13.md §1.2; R163, R164, R165): a
// third Scope kind, `students`, bound by the access guard on every @RequireCapacity route, and
// GET /me's `children` and `staffId`.
import { StaffHarness } from '../staff/support';
import { createTestApp } from '../core/app';
import { closeTestDb, createSchool, type TestSchool } from '../support/schools';
import {
  createClassWithSection,
  createGuardian,
  createStudent,
  enrol,
  linkGuardian,
} from '../support/students';
import type { MeDto } from '../../src/modules/auth/dto';
import { CapacityScopeProbeModule, guardianLogin, studentLogin } from './support';

describe('capacity scope (e2e)', () => {
  const h = new StaffHarness();
  const db = h.db;
  let school: TestSchool;

  beforeAll(async () => {
    h.app = await createTestApp({ imports: [CapacityScopeProbeModule] });
    school = await createSchool();
    await db.schoolSettings.create({
      data: { schoolId: school.id, feeDueDay: 10, studentLoginEnabled: true },
    });
  });

  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  type Probe = { kind: string; ids: string[] };
  const probe = async (who: 'guardian' | 'student', cookie: string) => {
    const res = await h.get(`/api/v1/me/test-capacity-scope/${who}`, cookie);
    return { status: res.status, body: res.body as Probe };
  };
  const getMe = async (cookie: string): Promise<{ status: number; body: MeDto }> => {
    const res = await h.get('/api/v1/me', cookie);
    return { status: res.status, body: res.body as MeDto };
  };

  it('R163: a guardian is scoped to the children of live links with can_login, merged guardians excluded', async () => {
    const { section } = await createClassWithSection(db, school);
    const guardian = await createGuardian(db, school);
    const [a, b, c, d] = [
      await createStudent(db, school, { fullName: 'Aaliya' }),
      await createStudent(db, school, { fullName: 'Bilal' }),
      await createStudent(db, school),
      await createStudent(db, school),
    ];
    await enrol(db, school, a, section, { rollNo: 4 });
    await linkGuardian(db, school, a, guardian, { canLogin: true, relationship: 'mother' });
    await linkGuardian(db, school, b, guardian, { canLogin: true });
    // No login flag: not in scope. Ended: not in scope.
    await linkGuardian(db, school, c, guardian, { canLogin: false });
    await linkGuardian(db, school, d, guardian, { canLogin: true, endedAt: new Date() });
    // Another guardian's child, linked with login to them only.
    const other = await createGuardian(db, school);
    const e = await createStudent(db, school);
    await linkGuardian(db, school, e, other, { canLogin: true });

    const signed = await guardianLogin(db, school, guardian);
    const res = await probe('guardian', signed.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: 'students', ids: [String(a.id), String(b.id)].sort() });

    // MeDto.children: this guardian's own relationship, the current enrolment, and nothing else
    // (R165: no admission number, identity number, or another guardian's data).
    const me = await getMe(signed.cookie);
    expect(me.status).toBe(200);
    expect(me.body.staffId).toBeNull();
    expect(me.body.children).toEqual([
      {
        studentId: String(a.id),
        fullName: 'Aaliya',
        status: 'active',
        relationship: 'mother',
        current: expect.objectContaining({ sectionId: String(section.id), rollNo: 4 }),
      },
      { studentId: String(b.id), fullName: 'Bilal', status: 'active', relationship: 'father', current: null },
    ]);
    for (const child of me.body.children) {
      expect(Object.keys(child).sort()).toEqual(
        ['current', 'fullName', 'relationship', 'status', 'studentId'],
      );
    }

    // A merged guardian keeps no scope.
    const target = await createGuardian(db, school);
    await db.guardian.updateMany({
      where: { schoolId: school.id, id: guardian.id },
      data: { status: 'merged', mergedIntoId: target.id },
    });
    expect((await probe('guardian', signed.cookie)).body).toEqual({ kind: 'students', ids: [] });
  });

  it('R164: ending a link removes the child on the next request; a child who left stays while the link is live', async () => {
    const guardian = await createGuardian(db, school);
    const stays = await createStudent(db, school, { status: 'withdrawn' });
    const goes = await createStudent(db, school);
    await linkGuardian(db, school, stays, guardian, { canLogin: true });
    const link = await linkGuardian(db, school, goes, guardian, { canLogin: true, isPrimaryContact: false });
    const signed = await guardianLogin(db, school, guardian);
    expect((await probe('guardian', signed.cookie)).body.ids).toEqual(
      [String(stays.id), String(goes.id)].sort(),
    );

    await db.studentGuardian.updateMany({
      where: { schoolId: school.id, id: link.id },
      data: { endedAt: new Date() },
    });
    expect((await probe('guardian', signed.cookie)).body).toEqual({
      kind: 'students',
      ids: [String(stays.id)],
    });
    const me = await getMe(signed.cookie);
    expect(me.body.children.map((c) => c.studentId)).toEqual([String(stays.id)]);
    expect(me.body.children[0]?.status).toBe('withdrawn');
  });

  it('a guardian with no live login link is permitted and scoped to nothing', async () => {
    const guardian = await createGuardian(db, school);
    const signed = await guardianLogin(db, school, guardian);
    const res = await probe('guardian', signed.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: 'students', ids: [] });
    expect((await getMe(signed.cookie)).body.children).toEqual([]);
  });

  it('a student is scoped to their own id; other capacities are refused', async () => {
    const student = await createStudent(db, school);
    const signed = await studentLogin(db, school, student);
    expect((await probe('student', signed.cookie)).body).toEqual({
      kind: 'students',
      ids: [String(student.id)],
    });
    expect((await probe('guardian', signed.cookie)).status).toBe(403);
    const me = await getMe(signed.cookie);
    expect(me.body).toMatchObject({ staffId: null, children: [] });

    const teacher = await h.caller(school, 'teacher');
    expect((await probe('guardian', teacher.cookie)).status).toBe(403);
    expect((await probe('student', teacher.cookie)).status).toBe(403);
    expect((await getMe(teacher.cookie)).body.staffId).toBe(String(teacher.staffId));
  });

  it('a staff member who is also a guardian carries both: staffId and children', async () => {
    const teacher = await h.caller(school, 'teacher');
    const guardian = await createGuardian(db, school);
    const child = await createStudent(db, school);
    await linkGuardian(db, school, child, guardian, { canLogin: true });
    await db.user.updateMany({
      where: { schoolId: school.id, id: teacher.userId },
      data: { guardianId: guardian.id },
    });
    const me = await getMe(teacher.cookie);
    expect(me.body.staffId).toBe(String(teacher.staffId));
    expect(me.body.children.map((c) => c.studentId)).toEqual([String(child.id)]);
    expect((await probe('guardian', teacher.cookie)).body.ids).toEqual([String(child.id)]);
  });
});
