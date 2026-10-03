// School login, logout and /me (contract slice-2 §3.1, §3.2, §4.1): R1, R11, R16 (logs), R64,
// R65, R81, plus the cookie and body shape of a session.
import { randomBytes, randomInt } from 'node:crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import request from 'supertest';
import { PasswordHasher } from '../../src/common/crypto/password';
import { loadEnv } from '../../src/config/env';
import { Mailer } from '../../src/modules/auth/mailer';
import { createTestApp } from '../core/app';
import { createSchoolSession, createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import { createGuardianUser, FakeMailer, nextIp, ORIGIN, sessionCookieOf, setCookies } from './support';

type ErrorBody = { error: { code: string; message: string; details: unknown; requestId: string } };
type Me = {
  id: string;
  fullName: string;
  email: string | null;
  hasVerifiedEmail: boolean;
  passwordIsDefault: boolean;
  school: { id: string; name: string; shortCode: string; status: string };
  roles: string[];
  capabilities: string[];
  sessionExpiresAt: string;
};

describe('school login, logout and /me', () => {
  let app: NestExpressApplication;
  let school: TestSchool;
  const logLines: string[] = [];
  const db = () => testDb();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp({
      logStream: { write: (line: string) => void logLines.push(line) },
      overrides: [{ provide: Mailer, useValue: new FakeMailer() }],
    });
    school = await createSchool();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  // Fresh per test, like nextIp(): the limits live in Redis, which outlives a run, so fixed values
  // would start a rerun (or a parallel run) with spent counters.
  const randomUsername = () => String(randomInt(1e12, 1e13));
  const randomCode = () => `t${randomBytes(5).toString('hex')}`;
  const login = (body: object, ip = nextIp()) =>
    http().post('/api/v1/auth/login').set('Origin', ORIGIN).set('X-Forwarded-For', ip).send(body);
  const sessionCookie = sessionCookieOf;

  describe('POST /auth/login', () => {
    it('logs in with school code, CNIC digits and the default password', async () => {
      const user = await createSchoolUser(db(), school, { systemRole: 'principal', defaultPassword: true });
      const dashed = `${user.cnic.slice(0, 5)}-${user.cnic.slice(5, 12)}-${user.cnic.slice(12)}`;
      const res = await login({ schoolCode: ` ${school.shortCode.toUpperCase()} `, username: dashed, password: user.cnic }).expect(200);
      const me = res.body as Me;
      expect(me.id).toBe(user.userId.toString());
      expect(me.passwordIsDefault).toBe(true);
      expect(me.roles).toEqual(['principal']);
      expect(me.capabilities).toContain('role.manage');
      expect(me.school).toMatchObject({ id: school.id.toString(), shortCode: school.shortCode });
      // The token is in the cookie only; no identity number anywhere in the body.
      expect(JSON.stringify(res.body)).not.toMatch(/[0-9]{13}/);
      const raw = setCookies(res)[0] ?? '';
      expect(raw).toMatch(/^__Host-asms_session=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=\d+$/);
      const maxAge = Number(/Max-Age=(\d+)/.exec(raw)?.[1]);
      expect(maxAge).toBeGreaterThan(29 * 24 * 3600);
      expect(maxAge).toBeLessThanOrEqual(30 * 24 * 3600);
      expect(JSON.stringify(res.body)).not.toContain(sessionCookie(res).split('=')[1]);

      const row = await db().user.findFirst({ where: { schoolId: school.id, id: user.userId } });
      expect(row?.lastLoginAt).not.toBeNull();
      const session = await db().session.findFirst({
        where: { schoolId: school.id, userId: user.userId },
        orderBy: { id: 'desc' },
      });
      expect(session?.channel).toBe('cookie');
      // The cookie works.
      await http().get('/api/v1/me').set('Cookie', sessionCookie(res)).expect(200);
    });

    it('R1: the same digits in two schools log into the school whose code was typed', async () => {
      const other = await createSchool();
      const a = await createSchoolUser(db(), school, { systemRole: 'teacher', password: 'password-in-a' }); // pragma: allowlist secret
      // The same person (same digits) in school B, with a different password.
      const b = await createSchoolUser(db(), other, { systemRole: 'teacher', password: 'password-in-b' }); // pragma: allowlist secret
      await db().user.update({
        where: { schoolId_id: { schoolId: other.id, id: b.userId } },
        data: { usernameHash: a.usernameHash },
      });
      const inA = await login({ schoolCode: school.shortCode, username: a.cnic, password: 'password-in-a' }).expect(200); // pragma: allowlist secret
      expect((inA.body as Me).school.id).toBe(school.id.toString());
      const inB = await login({ schoolCode: other.shortCode, username: a.cnic, password: 'password-in-b' }).expect(200); // pragma: allowlist secret
      expect((inB.body as Me).school.id).toBe(other.id.toString());
      expect((inB.body as Me).id).toBe(b.userId.toString());
      // A's password does not open B.
      await login({ schoolCode: other.shortCode, username: a.cnic, password: 'password-in-a' }).expect(401); // pragma: allowlist secret
    });

    it('revokes a session presented with the login request', async () => {
      const user = await createSchoolUser(db(), school, { systemRole: 'teacher', password: 'presented-pass' }); // pragma: allowlist secret
      const old = await createSchoolSession(db(), school, user);
      await login({ schoolCode: school.shortCode, username: user.cnic, password: 'presented-pass' }) // pragma: allowlist secret
        .set('Cookie', old.cookie)
        .expect(200);
      await http().get('/api/v1/me').set('Cookie', old.cookie).expect(401);
    });

    it('R11: every refusal is the same 401 AUTH_FAILED with the same headers', async () => {
      const ok = await createSchoolUser(db(), school, { systemRole: 'teacher', password: 'right-password' }); // pragma: allowlist secret
      const disabled = await createSchoolUser(db(), school, { systemRole: 'teacher', password: 'right-password', userStatus: 'disabled' }); // pragma: allowlist secret
      const left = await createSchoolUser(db(), school, { systemRole: 'teacher', password: 'right-password', staffStatus: 'left' }); // pragma: allowlist secret
      const gone = await createSchool();
      const inGone = await createSchoolUser(db(), gone, { systemRole: 'principal', password: 'right-password' }); // pragma: allowlist secret
      await db().school.update({ where: { id: gone.id }, data: { status: 'terminated' } });
      const attempts = [
        { schoolCode: school.shortCode, username: ok.cnic, password: 'wrong-password' }, // pragma: allowlist secret
        { schoolCode: school.shortCode, username: '1234567890123', password: 'right-password' }, // pragma: allowlist secret
        { schoolCode: 'nosuchschool', username: ok.cnic, password: 'right-password' }, // pragma: allowlist secret
        { schoolCode: school.shortCode, username: disabled.cnic, password: 'right-password' }, // pragma: allowlist secret
        { schoolCode: school.shortCode, username: left.cnic, password: 'right-password' }, // pragma: allowlist secret
        { schoolCode: gone.shortCode, username: inGone.cnic, password: 'right-password' }, // pragma: allowlist secret
      ];
      const shapes = [];
      for (const body of attempts) {
        const res = await login(body).expect(401);
        const { requestId: _r, ...error } = (res.body as ErrorBody).error;
        const headers = Object.keys(res.headers)
          .filter((h) => !['x-request-id', 'date', 'etag', 'content-length'].includes(h))
          .sort();
        shapes.push({ error, headers, cookie: res.headers['set-cookie'] ?? null });
      }
      expect(shapes[0]?.error).toEqual({
        code: 'AUTH_FAILED',
        message: 'School code, username or password is incorrect.',
        details: null,
      });
      for (const shape of shapes) expect(shape).toEqual(shapes[0]);
    });

    it('R11 / R81: five failures lock the account for 15 minutes; the right password during the lock fails and does not clear it', async () => {
      const user = await createSchoolUser(db(), school, { systemRole: 'teacher', password: 'lock-me-pass' }); // pragma: allowlist secret
      for (let i = 0; i < 5; i++) {
        await login({ schoolCode: school.shortCode, username: user.cnic, password: `wrong-${i}` }).expect(401);
      }
      const locked = await login({ schoolCode: school.shortCode, username: user.cnic, password: 'lock-me-pass' }).expect(401); // pragma: allowlist secret
      expect((locked.body as ErrorBody).error.code).toBe('AUTH_FAILED');
      await login({ schoolCode: school.shortCode, username: user.cnic, password: 'lock-me-pass' }).expect(401); // pragma: allowlist secret
      // A typed code that differs only in case and spacing is the same account key.
      await login({ schoolCode: ` ${school.shortCode.toUpperCase()}`, username: user.cnic, password: 'lock-me-pass' }).expect(401); // pragma: allowlist secret
    });

    it('R11: a success resets the consecutive-failure count', async () => {
      const user = await createSchoolUser(db(), school, { systemRole: 'teacher', password: 'reset-count-pass' }); // pragma: allowlist secret
      for (let i = 0; i < 4; i++) {
        await login({ schoolCode: school.shortCode, username: user.cnic, password: 'nope' }).expect(401);
      }
      await login({ schoolCode: school.shortCode, username: user.cnic, password: 'reset-count-pass' }).expect(200); // pragma: allowlist secret
      for (let i = 0; i < 4; i++) {
        await login({ schoolCode: school.shortCode, username: user.cnic, password: 'nope' }).expect(401);
      }
      await login({ schoolCode: school.shortCode, username: user.cnic, password: 'reset-count-pass' }).expect(200); // pragma: allowlist secret
    });

    it('throttles 5/min per school code + username + IP with 429 and Retry-After, whether or not the account exists', async () => {
      const ip = nextIp();
      const body = { schoolCode: randomCode(), username: randomUsername(), password: 'x' };
      for (let i = 0; i < 5; i++) await login(body, ip).expect(401);
      const res = await login(body, ip).expect(429);
      expect((res.body as ErrorBody).error.code).toBe('RATE_LIMITED');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('throttles 10/min per username across schools and IPs', async () => {
      const username = randomUsername();
      const body = () => ({ schoolCode: randomCode(), username, password: 'x' });
      for (let i = 0; i < 10; i++) await login(body()).expect(401);
      await login(body()).expect(429);
    });

    it('throttles 30/min per IP', async () => {
      const ip = nextIp();
      for (let i = 0; i < 30; i++) {
        await login({ schoolCode: randomCode(), username: randomUsername(), password: 'x' }, ip).expect(401);
      }
      await login({ schoolCode: randomCode(), username: randomUsername(), password: 'x' }, ip).expect(429);
    });

    it('R65: login without the app Origin is 403 ORIGIN_REJECTED', async () => {
      const res = await http()
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', nextIp())
        .send({ schoolCode: school.shortCode, username: '1234567890123', password: 'x' })
        .expect(403);
      expect((res.body as ErrorBody).error.code).toBe('ORIGIN_REJECTED');
      await http()
        .post('/api/v1/auth/login')
        .set('Origin', 'https://evil.example')
        .send({ schoolCode: school.shortCode, username: '1234567890123', password: 'x' })
        .expect(403);
    });

    it('422 on a malformed body, without echoing it', async () => {
      const res = await login({ schoolCode: 'a!', username: '12345', password: '' }).expect(422);
      const paths = (res.body as { error: { details: { fields: { path: string }[] } } }).error.details.fields.map((f) => f.path);
      expect(paths).toEqual(expect.arrayContaining(['schoolCode', 'username', 'password']));
      await login({ schoolCode: school.shortCode, username: '1234567890123', password: 'x', schoolId: '1' }).expect(422);
    });

    it('a suspended school may log in (it is read-only afterwards)', async () => {
      const suspended = await createSchool({ status: 'suspended' });
      const user = await createSchoolUser(db(), suspended, { systemRole: 'principal', password: 'suspended-pass' }); // pragma: allowlist secret
      const res = await login({ schoolCode: suspended.shortCode, username: user.cnic, password: 'suspended-pass' }).expect(200); // pragma: allowlist secret
      expect((res.body as Me).school.status).toBe('suspended');
    });

    it('a parent-only account logs in with role parent and no capabilities', async () => {
      const parent = await createGuardianUser(db(), school);
      await db().user.update({
        where: { schoolId_id: { schoolId: school.id, id: parent.userId } },
        data: { passwordHash: await new PasswordHasher(loadEnv()).hash('parent-password') },
      });
      const res = await login({ schoolCode: school.shortCode, username: parent.cnic, password: 'parent-password' }).expect(200); // pragma: allowlist secret
      const me = res.body as Me;
      expect(me.roles).toEqual(['parent']);
      expect(me.capabilities).toEqual([]);
      expect(me.fullName).toMatch(/^Guardian /);
    });

    const defaultPasswordLogins = (userId: bigint) =>
      db().auditLog.findMany({
        where: { schoolId: school.id, subjectId: userId, action: 'user.login_on_default_password' },
        orderBy: { id: 'asc' },
      });

    it('F2: audits every login on a freshly issued default password; none once it is changed', async () => {
      const user = await createSchoolUser(db(), school, { systemRole: 'teacher', defaultPassword: true });
      await login({ schoolCode: school.shortCode, username: user.cnic, password: user.cnic }).expect(200);
      await login({ schoolCode: school.shortCode, username: user.cnic, password: user.cnic }).expect(200);
      const rows = await defaultPasswordLogins(user.userId);
      expect(rows.map((r) => [r.actorUserId, r.subjectType, r.metadata])).toEqual([
        [user.userId, 'user', { afterOfficeReset: false }],
        [user.userId, 'user', { afterOfficeReset: false }],
      ]);
      // No identity data in the row: the metadata is the one flag, and no column holds the digits.
      expect(JSON.stringify(rows, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(user.cnic);
      // A user on a password of their own is not audited at sign-in.
      const own = await createSchoolUser(db(), school, { systemRole: 'teacher', password: 'own-pass-1' }); // pragma: allowlist secret
      await login({ schoolCode: school.shortCode, username: own.cnic, password: 'own-pass-1' }).expect(200); // pragma: allowlist secret
      expect(await defaultPasswordLogins(own.userId)).toEqual([]);
    });

    it('F2: after an office reset the first default-password login says so; later ones do not', async () => {
      const user = await createSchoolUser(db(), school, { systemRole: 'teacher', defaultPassword: true });
      await db().user.update({
        where: { schoolId_id: { schoolId: school.id, id: user.userId } },
        data: { officeResetAt: new Date(Date.now() - 1000), lastLoginAt: new Date(Date.now() - 60_000) },
      });
      await login({ schoolCode: school.shortCode, username: user.cnic, password: user.cnic }).expect(200);
      await login({ schoolCode: school.shortCode, username: user.cnic, password: user.cnic }).expect(200);
      expect((await defaultPasswordLogins(user.userId)).map((r) => r.metadata)).toEqual([
        { afterOfficeReset: true },
        { afterOfficeReset: false },
      ]);
      // The single row replaced the old action (contract slice-2 §3.1 step 5, §9).
      expect(
        await db().auditLog.count({
          where: { schoolId: school.id, subjectId: user.userId, action: 'user.login_after_office_reset' },
        }),
      ).toBe(0);
    });
  });

  describe('POST /auth/logout', () => {
    it('revokes the session and clears the cookie (204)', async () => {
      const user = await createSchoolUser(db(), school, { systemRole: 'teacher' });
      const s = await createSchoolSession(db(), school, user);
      const res = await http().post('/api/v1/auth/logout').set('Cookie', s.cookie).set('Origin', ORIGIN).expect(204);
      expect(setCookies(res)[0]).toBe(
        '__Host-asms_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
      );
      await http().get('/api/v1/me').set('Cookie', s.cookie).expect(401);
    });

    it('R65: a cookie logout without Origin is refused', async () => {
      const user = await createSchoolUser(db(), school, { systemRole: 'teacher' });
      const s = await createSchoolSession(db(), school, user);
      await http().post('/api/v1/auth/logout').set('Cookie', s.cookie).expect(403);
      await http().get('/api/v1/me').set('Cookie', s.cookie).expect(200);
    });

    it('a bearer logout needs no Origin', async () => {
      const user = await createSchoolUser(db(), school, { systemRole: 'teacher' });
      const s = await createSchoolSession(db(), school, user, { channel: 'bearer' });
      await http().post('/api/v1/auth/logout').set('Authorization', s.authorization).expect(204);
      await http().get('/api/v1/me').set('Authorization', s.authorization).expect(401);
    });

    it('works in a suspended school', async () => {
      const suspended = await createSchool({ status: 'suspended' });
      const user = await createSchoolUser(db(), suspended, { systemRole: 'teacher' });
      const s = await createSchoolSession(db(), suspended, user);
      await http().post('/api/v1/auth/logout').set('Cookie', s.cookie).set('Origin', ORIGIN).expect(204);
    });
  });

  describe('GET /me', () => {
    it('returns the caller with sorted capabilities and never a username', async () => {
      const user = await createSchoolUser(db(), school, {
        systemRole: 'office_staff',
        email: 'Office@Example.test',
        emailVerified: true,
        fullName: 'Office Person',
      });
      const s = await createSchoolSession(db(), school, user);
      const me = (await http().get('/api/v1/me').set('Cookie', s.cookie).expect(200)).body as Me;
      expect(me).toMatchObject({
        id: user.userId.toString(),
        fullName: 'Office Person',
        email: 'office@example.test',
        hasVerifiedEmail: true,
        passwordIsDefault: false,
        roles: ['office_staff'],
      });
      expect(me.capabilities[0]).toBe('user.account.manage');
      expect(me.capabilities).not.toContain('role.manage');
      expect(Object.keys(me).sort()).toEqual(
        ['capabilities', 'email', 'fullName', 'hasVerifiedEmail', 'id', 'passwordIsDefault', 'roles', 'school', 'sessionExpiresAt'],
      );
      expect(JSON.stringify(me)).not.toMatch(/[0-9]{13}/);
    });

    it('refuses an unknown query parameter', async () => {
      const user = await createSchoolUser(db(), school, { systemRole: 'teacher' });
      const s = await createSchoolSession(db(), school, user);
      await http().get('/api/v1/me?schoolId=1').set('Cookie', s.cookie).expect(422);
    });
  });

  it('R16: no identity number reached the logs of this suite', () => {
    expect(logLines.join('')).not.toMatch(/[0-9]{13}|[0-9]{5}-[0-9]{7}-[0-9]/);
  });
});

describe('school login with Redis unreachable', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const failing = {
      increment: () => Promise.reject(new Error('Redis unreachable')),
      onModuleDestroy: () => undefined,
    };
    app = await createTestApp({ overrides: [{ provide: ThrottlerStorageRedisService, useValue: failing }] });
  });

  afterAll(async () => {
    await app.close();
  });

  it('R81: login is 503 SERVICE_UNAVAILABLE, never evaluated without its counters', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ schoolCode: 'anyschool', username: '1234567890123', password: 'x' })
      .expect(503);
    expect((res.body as ErrorBody).error.code).toBe('SERVICE_UNAVAILABLE');
  });
});
