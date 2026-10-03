// The student capacity (contracts/slice-6.md §9; contracts/slice-2.md §1.1): users.student_id set,
// the student `active`, and the school's student login enabled. A student session carries the
// fixed role and no capability (rule 13), so every staff route is 403 (R78). Office reset of a
// student login returns it to the B-Form digits.
import request from 'supertest';
import { PasswordHasher } from '../../src/common/crypto/password';
import { nextIp } from '../school-auth/support';
import { testIdentityHash } from '../support/school-session';
import { closeTestDb, createSchool, type TestSchool } from '../support/schools';
import { createStudent, type TestStudent } from '../support/students';
import { errorOf, ORIGIN, StaffHarness, type Caller } from './support';

describe('student capacity (e2e)', () => {
  const h = new StaffHarness();
  const db = h.db;
  let school: TestSchool;
  let office: Caller;

  const login = (s: TestSchool, digits: string, password = digits) =>
    request(h.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', nextIp())
      .send({ schoolCode: s.shortCode, username: digits, password });
  const setLoginEnabled = (s: TestSchool, studentLoginEnabled: boolean) =>
    db.schoolSettings.updateMany({ where: { schoolId: s.id }, data: { studentLoginEnabled } });

  /** A student with a login whose password is the default (the B-Form digits). */
  async function studentLogin(s: TestSchool): Promise<{ student: TestStudent; userId: bigint; digits: string }> {
    const student = await createStudent(db, s, { fullName: 'Hamza Student' });
    const digits = student.bForm ?? '';
    const user = await db.user.create({
      data: {
        schoolId: s.id,
        usernameHash: testIdentityHash(digits),
        passwordHash: await h.app.get(PasswordHasher).hash(digits),
        passwordIsDefault: true,
        studentId: student.id,
      },
    });
    return { student, userId: user.id, digits };
  }

  beforeAll(async () => {
    await h.start();
    school = await createSchool();
    await db.schoolSettings.create({ data: { schoolId: school.id, feeDueDay: 10, studentLoginEnabled: true } });
    office = await h.caller(school, 'office_staff');
  });

  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  it('an active student with login enabled signs in with the student role and no capability', async () => {
    const { userId, digits } = await studentLogin(school);
    const res = await login(school, digits);
    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']).split(';')[0] ?? '';
    const me = await h.get('/api/v1/me', cookie);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ roles: ['student'], capabilities: [] });
    // R78: nothing but /auth and /me.
    for (const path of ['/api/v1/staff', '/api/v1/users', '/api/v1/classes', '/api/v1/test-scope']) {
      expect((await h.get(path, cookie)).status).toBe(403);
    }
    const listed = await h.get('/api/v1/users?kind=student&q=hamza', office.cookie);
    expect(listed.body).toMatchObject({
      data: [{ id: String(userId), studentId: expect.any(String), staffId: null, fullName: 'Hamza Student' }],
    });
  });

  it('student login disabled, or a student not active: login fails and sessions are refused', async () => {
    const { digits } = await studentLogin(school);
    const res = await login(school, digits);
    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']).split(';')[0] ?? '';

    await setLoginEnabled(school, false);
    try {
      expect(errorOf(await login(school, digits)).code).toBe('AUTH_FAILED');
      expect((await h.get('/api/v1/me', cookie)).status).toBe(401);
    } finally {
      await setLoginEnabled(school, true);
    }

    const other = await studentLogin(school);
    await db.student.updateMany({ where: { schoolId: school.id, id: other.student.id }, data: { status: 'withdrawn' } });
    expect(errorOf(await login(school, other.digits)).code).toBe('AUTH_FAILED');
    // The first is still fine once the setting is back on.
    expect((await login(school, digits)).status).toBe(200);
  });

  it('a school with no settings row has student login off', async () => {
    const bare = await createSchool();
    const { digits } = await studentLogin(bare);
    expect((await login(bare, digits)).status).toBe(401);
  });

  it('office reset returns a student login to its B-Form digits', async () => {
    const { userId, digits } = await studentLogin(school);
    await db.user.updateMany({
      where: { schoolId: school.id, id: userId },
      data: { passwordHash: await h.app.get(PasswordHasher).hash('a chosen password'), passwordIsDefault: false },
    });
    const res = await h.send(
      'post',
      `/api/v1/users/${userId}/reset-password`,
      { reason: 'Forgot the password', clearEmail: false },
      office.cookie,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ passwordIsDefault: true, studentId: expect.any(String) });
    expect((await login(school, digits)).status).toBe(200);
  });

  it('R16: no B-Form digits in any response or log line', () => {
    const everything = [...h.bodies, ...h.logs].join('\n');
    expect(everything).not.toMatch(/[0-9]{13}/);
  });
});
