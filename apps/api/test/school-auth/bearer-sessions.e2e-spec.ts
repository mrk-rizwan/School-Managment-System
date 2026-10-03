// Slice 9 part B (contracts/slice-9.md §1, §3): bearer sessions, devices, the app-version floor,
// the Origin and bearer rules, revocation of other sessions, sign-out-everywhere and the /me
// additions. R153, R154, R115 (devices die with their session), R159, R161, R163 (decorator),
// R166, R169, R170, R173.
import { NestExpressApplication } from '@nestjs/platform-express';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import request from 'supertest';
import { PasswordHasher } from '../../src/common/crypto/password';
import { loadEnv } from '../../src/config/env';
import { Mailer } from '../../src/modules/auth/mailer';
import { resetOnStaffLink } from '../../src/modules/people/staff/reset-on-staff-link';
import { AuditLogRepository } from '../../src/repositories/audit-log.repository';
import { DeviceRepository } from '../../src/repositories/device.repository';
import { SessionRepository } from '../../src/repositories/session.repository';
import { UserTokenRepository } from '../../src/repositories/user-token.repository';
import { UserRepository } from '../../src/repositories/user.repository';
import { createTestApp } from '../core/app';
import {
  createSchoolSession,
  createSchoolUser,
  randomIdentityDigits,
  TEST_APP_VERSION,
  testIdentityHash,
  type TestSchoolSession,
} from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import {
  createAcademicYear,
  createClass,
  createSection,
  createStudent,
  createSubject,
  day,
  isoDay,
} from '../support/students';
import {
  AccessProbeModule,
  createGuardianUser,
  FakeMailer,
  nextIp,
  ORIGIN,
  sessionCookieOf,
  setCookies,
  uniqueEmail,
} from './support';

type ErrorBody = { error: { code: string; details: Record<string, unknown> | null } };
type LoginResult = {
  id: string;
  bearerToken: string | null;
  sessionExpiresAt: string;
  capacities: string[];
  assignments: Record<string, unknown>[];
  school: { status: string };
};

const DAY = 24 * 60 * 60_000;
const APP = { 'X-App-Version': TEST_APP_VERSION };

describe('bearer sessions, devices and /me (slice 9 part B)', () => {
  let app: NestExpressApplication;
  let school: TestSchool;
  let hasher: PasswordHasher;
  const db = () => testDb();
  const http = () => request(app.getHttpServer());
  const codeOf = (res: { body: unknown }) => (res.body as ErrorBody).error.code;

  beforeAll(async () => {
    app = await createTestApp({
      imports: [AccessProbeModule],
      overrides: [{ provide: Mailer, useValue: new FakeMailer() }],
    });
    hasher = new PasswordHasher(loadEnv());
    school = await createSchool();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const loginBearer = (username: string, password: string, extra: Record<string, string> = {}) =>
    http()
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', nextIp())
      .set({ ...APP, ...extra })
      .send({ schoolCode: school.shortCode, username, password, channel: 'bearer' });

  const loginCookie = (username: string, password: string) =>
    http()
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', nextIp())
      .send({ schoolCode: school.shortCode, username, password });

  const bearerOf = (token: string) => ({ Authorization: `Bearer ${token}`, ...APP });

  const registerDevice = (session: { bearer: Record<string, string> }, pushToken: string) =>
    http().post('/api/v1/me/devices').set(session.bearer).send({ platform: 'android', pushToken });

  const devices = () => app.get(DeviceRepository);
  const liveDevices = (userId: bigint) => devices().liveForUsers(school.id, [userId], 30 * DAY, new Date());

  /** A staff user with a known password. */
  const staffUser = (systemRole: 'principal' | 'office_staff' | 'teacher', password = 'staff-pass-1') => // pragma: allowlist secret
    createSchoolUser(db(), school, { systemRole, password });

  /** A guardian-only login with a known password. */
  async function guardianUser(password = 'parent-pass-1') { // pragma: allowlist secret
    const parent = await createGuardianUser(db(), school);
    await db().user.update({
      where: { schoolId_id: { schoolId: school.id, id: parent.userId } },
      data: { passwordHash: await hasher.hash(password) },
    });
    return parent;
  }

  // ------------------------------------------------------------------------------ R153 login

  describe('R153: POST /auth/login with a channel', () => {
    it('R153: a cookie login sets the cookie and returns bearerToken null', async () => {
      const user = await staffUser('teacher');
      const res = await loginCookie(user.cnic, 'staff-pass-1').expect(200); // pragma: allowlist secret
      const body = res.body as LoginResult;
      expect(body.bearerToken).toBeNull();
      const token = sessionCookieOf(res).split('=')[1] ?? '';
      expect(token).toHaveLength(43);
      expect(JSON.stringify(res.body)).not.toContain(token);
    });

    it('R153: a bearer login returns the token in the body only, no Set-Cookie, and it works as a bearer', async () => {
      const user = await staffUser('teacher');
      const res = await loginBearer(user.cnic, 'staff-pass-1').expect(200); // pragma: allowlist secret
      const body = res.body as LoginResult;
      expect(body.bearerToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(setCookies(res)).toEqual([]);
      const row = await db().session.findFirst({
        where: { schoolId: school.id, userId: user.userId },
        orderBy: { id: 'desc' },
      });
      expect(row?.channel).toBe('bearer');
      await http().get('/api/v1/me').set(bearerOf(body.bearerToken ?? '')).expect(200);
    });

    it('R153: channel bearer without X-App-Version is 422 on channel', async () => {
      const user = await staffUser('teacher');
      const res = await http()
        .post('/api/v1/auth/login')
        .set('Origin', ORIGIN)
        .set('X-Forwarded-For', nextIp())
        .send({ schoolCode: school.shortCode, username: user.cnic, password: 'x', channel: 'bearer' })
        .expect(422);
      expect((res.body as { error: { details: { fields: { path: string }[] } } }).error.details.fields[0]?.path).toBe('channel');
    });

    it('R170: a bearer login carrying Origin or a school cookie is 401 AUTH_FAILED and is not counted toward the lockout', async () => {
      const user = await staffUser('teacher');
      for (let i = 0; i < 3; i++) {
        const res = await loginBearer(user.cnic, 'staff-pass-1', { Origin: ORIGIN }).expect(401); // pragma: allowlist secret
        expect(codeOf(res)).toBe('AUTH_FAILED');
        const withCookie = await loginBearer(user.cnic, 'staff-pass-1', { Cookie: `__Host-asms_session=${'a'.repeat(43)}` }).expect(401); // pragma: allowlist secret
        expect(codeOf(withCookie)).toBe('AUTH_FAILED');
      }
      // Six refusals, past the lockout's five: had they counted, this would be refused.
      await loginBearer(user.cnic, 'staff-pass-1').expect(200); // pragma: allowlist secret
    });

    it('R159: a sign-in presenting the old bearer token revokes it, and its device stops receiving push', async () => {
      const first = await guardianUser();
      const second = await guardianUser();
      const a = (await loginBearer(first.cnic, 'parent-pass-1').expect(200)).body as LoginResult; // pragma: allowlist secret
      await http().post('/api/v1/me/devices').set(bearerOf(a.bearerToken ?? '')).send({ platform: 'android', pushToken: 'shared-phone:1' }).expect(201);
      expect(await liveDevices(first.userId)).toHaveLength(1);
      // The second parent signs in on the same phone; the app presents the old token.
      await loginBearer(second.cnic, 'parent-pass-1', { Authorization: `Bearer ${a.bearerToken}` }).expect(200); // pragma: allowlist secret
      await http().get('/api/v1/me').set(bearerOf(a.bearerToken ?? '')).expect(401);
      expect(await liveDevices(first.userId)).toEqual([]);
    });
  });

  // --------------------------------------------------------------------- R154 lifetimes

  describe('R154: lifetimes per channel and capacity', () => {
    it('R154: a staff bearer login expires in 90 days; a guardian-only one in 180; cookie in 30', async () => {
      const teacher = await staffUser('teacher');
      const t = (await loginBearer(teacher.cnic, 'staff-pass-1').expect(200)).body as LoginResult; // pragma: allowlist secret
      const parent = await guardianUser();
      const p = (await loginBearer(parent.cnic, 'parent-pass-1').expect(200)).body as LoginResult; // pragma: allowlist secret
      const c = (await loginCookie(teacher.cnic, 'staff-pass-1').expect(200)).body as LoginResult; // pragma: allowlist secret
      const days = (iso: string) => (new Date(iso).getTime() - Date.now()) / DAY;
      expect(days(t.sessionExpiresAt)).toBeGreaterThan(89.9);
      expect(days(t.sessionExpiresAt)).toBeLessThanOrEqual(90);
      expect(days(p.sessionExpiresAt)).toBeGreaterThan(179.9);
      expect(days(p.sessionExpiresAt)).toBeLessThanOrEqual(180);
      expect(days(c.sessionExpiresAt)).toBeLessThanOrEqual(30);
    });

    it('R154: bearer idle is 14 days with staff capacity, 30 days without; cookie stays 24 hours', async () => {
      const teacher = await staffUser('teacher');
      const parent = await guardianUser();
      const far = new Date(Date.now() + 100 * DAY);
      const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY);
      const staff13 = await createSchoolSession(db(), school, teacher, { channel: 'bearer', lastSeenAt: at(13), expiresAt: far });
      const staff15 = await createSchoolSession(db(), school, teacher, { channel: 'bearer', lastSeenAt: at(15), expiresAt: far });
      const parent29 = await createSchoolSession(db(), school, parent, { channel: 'bearer', lastSeenAt: at(29), expiresAt: far });
      const parent31 = await createSchoolSession(db(), school, parent, { channel: 'bearer', lastSeenAt: at(31), expiresAt: far });
      const cookie2 = await createSchoolSession(db(), school, teacher, { lastSeenAt: at(2) });
      await http().get('/api/v1/me').set(staff13.bearer).expect(200);
      await http().get('/api/v1/me').set(staff15.bearer).expect(401);
      await http().get('/api/v1/me').set(parent29.bearer).expect(200);
      await http().get('/api/v1/me').set(parent31.bearer).expect(401);
      await http().get('/api/v1/me').set('Cookie', cookie2.cookie).expect(401);
    });

    it('R154: gaining staff capacity tightens idle at once (a teacher-parent idles at 14 days)', async () => {
      const parent = await guardianUser();
      const s = await createSchoolSession(db(), school, parent, {
        channel: 'bearer',
        lastSeenAt: new Date(Date.now() - 20 * DAY),
        expiresAt: new Date(Date.now() + 100 * DAY),
      });
      await http().get('/api/v1/me').set(s.bearer).expect(200);
      // Make the same login staff too: one login, both capacities (rule 12).
      const staff = await db().staff.create({
        data: { schoolId: school.id, fullName: 'Teacher Parent', phone: '+923001234567' },
      });
      await db().user.update({ where: { schoolId_id: { schoolId: school.id, id: parent.userId } }, data: { staffId: staff.id } });
      const principal = await staffUser('principal');
      await db().userRole.create({ data: { schoolId: school.id, userId: parent.userId, systemRole: 'teacher', assignedBy: principal.userId } });
      await db().session.update({ where: { schoolId_id: { schoolId: school.id, id: s.sessionId } }, data: { lastSeenAt: new Date(Date.now() - 20 * DAY) } });
      await http().get('/api/v1/me').set(s.bearer).expect(401);
    });
  });

  // ----------------------------------------------------------- R161 floor, R170 Origin rules

  describe('R161 and R170: the app-version floor and the Origin rules', () => {
    it('R161: a bearer request without X-App-Version is 426 before any session is read', async () => {
      const res = await http().get('/api/v1/me').set('Authorization', `Bearer ${'z'.repeat(43)}`).expect(426);
      expect(codeOf(res)).toBe('UPGRADE_REQUIRED');
      expect((res.body as ErrorBody).error.details).toEqual({ minimumVersion: '0.0.0' });
    });

    it('R161: a malformed X-App-Version is 426 even without a bearer; cookie clients and /health are exempt', async () => {
      await http().get('/api/v1/me').set('X-App-Version', '1.0').expect(426);
      await http().get('/api/v1/me').set('X-App-Version', '1.0.0.1').expect(426);
      await http().get('/api/v1/health').set('X-App-Version', 'nonsense').expect(200);
      const user = await staffUser('teacher');
      const s = await createSchoolSession(db(), school, user);
      await http().get('/api/v1/me').set('Cookie', s.cookie).expect(200);
    });

    it('R170: a bearer request carrying Origin is 401 AUTH_REQUIRED', async () => {
      const user = await staffUser('teacher');
      const s = await createSchoolSession(db(), school, user, { channel: 'bearer' });
      await http().get('/api/v1/me').set(s.bearer).expect(200);
      const res = await http().get('/api/v1/me').set(s.bearer).set('Origin', ORIGIN).expect(401);
      expect(codeOf(res)).toBe('AUTH_REQUIRED');
    });

    it('R170: a non-GET needs Origin unless it carries Authorization or X-App-Version', async () => {
      const user = await staffUser('teacher');
      const cookie = await createSchoolSession(db(), school, user);
      const noOrigin = await http().post('/api/v1/me/sessions/revoke-others').set('Cookie', cookie.cookie).expect(403);
      expect(codeOf(noOrigin)).toBe('ORIGIN_REJECTED');
      const bearer = await createSchoolSession(db(), school, user, { channel: 'bearer' });
      await http().post('/api/v1/me/sessions/revoke-others').set(bearer.bearer).expect(200);
      // An app login without Origin passes the Origin check (it is then judged on credentials).
      await http()
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', nextIp())
        .set(APP)
        .send({ schoolCode: school.shortCode, username: user.cnic, password: 'wrong-pass' }) // pragma: allowlist secret
        .expect(401);
    });
  });

  // ---------------------------------------------------------------------- devices, R159

  describe('POST /me/devices (R159, R173)', () => {
    it('409 BEARER_SESSION_REQUIRED on a cookie session, before the body is validated', async () => {
      const user = await staffUser('teacher');
      const s = await createSchoolSession(db(), school, user);
      const res = await http().post('/api/v1/me/devices').set('Cookie', s.cookie).set('Origin', ORIGIN).send({}).expect(409);
      expect(codeOf(res)).toBe('BEARER_SESSION_REQUIRED');
    });

    it('201 on first registration, 200 on refresh; the token is never returned', async () => {
      const user = await staffUser('teacher');
      const s = await createSchoolSession(db(), school, user, { channel: 'bearer' });
      const first = await registerDevice(s, 'fcm:token-one').expect(201);
      expect(Object.keys(first.body as object).sort()).toEqual(['appVersion', 'createdAt', 'id', 'lastSeenAt', 'platform']);
      expect(JSON.stringify(first.body)).not.toContain('token-one');
      const again = await registerDevice(s, 'fcm:token-one').expect(200);
      expect((again.body as { id: string }).id).toBe((first.body as { id: string }).id);
      // An FCM refresh replaces the token on the same row.
      await registerDevice(s, 'fcm:token-two').expect(200);
      const live = await liveDevices(user.userId);
      expect(live.map((d) => d.pushToken)).toEqual(['fcm:token-two']);
    });

    it('422 on a malformed push token', async () => {
      const user = await staffUser('teacher');
      const s = await createSchoolSession(db(), school, user, { channel: 'bearer' });
      await registerDevice(s, 'has spaces').expect(422);
      await registerDevice(s, '').expect(422);
    });

    it('R159: two parents on one phone: the latest registration replaces the earlier device row', async () => {
      const a = await guardianUser();
      const b = await guardianUser();
      const sa = await createSchoolSession(db(), school, a, { channel: 'bearer' });
      const sb = await createSchoolSession(db(), school, b, { channel: 'bearer' });
      await registerDevice(sa, 'fcm:one-phone').expect(201);
      await registerDevice(sb, 'fcm:one-phone').expect(201);
      expect(await liveDevices(a.userId)).toEqual([]);
      expect(await liveDevices(b.userId)).toHaveLength(1);
      const ended = await db().device.findFirst({ where: { schoolId: school.id, sessionId: sa.sessionId } });
      expect(ended?.unregisteredReason).toBe('replaced');
    });

    it('R159: a bearer logout ends the session and its device (sign_out) server-side', async () => {
      const user = await staffUser('teacher');
      const s = await createSchoolSession(db(), school, user, { channel: 'bearer' });
      await registerDevice(s, 'fcm:logout').expect(201);
      const res = await http().post('/api/v1/auth/logout').set(s.bearer).expect(204);
      expect(setCookies(res)).toEqual([]);
      await http().get('/api/v1/me').set(s.bearer).expect(401);
      const row = await db().device.findFirst({ where: { schoolId: school.id, sessionId: s.sessionId } });
      expect(row?.unregisteredReason).toBe('sign_out');
      expect(await liveDevices(user.userId)).toEqual([]);
    });

    it('R173: no response of /me carries a push token', async () => {
      const user = await staffUser('teacher');
      const s = await createSchoolSession(db(), school, user, { channel: 'bearer' });
      await registerDevice(s, 'fcm:secret-push-token').expect(201);
      const me = await http().get('/api/v1/me').set(s.bearer).expect(200);
      expect(JSON.stringify(me.body)).not.toContain('secret-push-token');
    });
  });

  // ------------------------------------------------- R154 / R115: every revocation path

  describe('R154, R115: every revocation path ends bearer sessions and stops push', () => {
    async function bearerWithDevice(userId: bigint): Promise<TestSchoolSession> {
      const s = await createSchoolSession(db(), school, { userId }, { channel: 'bearer' });
      await registerDevice(s, `fcm:dev-${s.sessionId}`).expect(201);
      expect(await liveDevices(userId)).toHaveLength(1);
      return s;
    }
    async function expectDead(s: TestSchoolSession, userId: bigint): Promise<void> {
      await http().get('/api/v1/me').set(s.bearer).expect(401);
      expect(await liveDevices(userId)).toEqual([]);
    }
    let principalCookie: string;
    let principalId: bigint;
    beforeAll(async () => {
      const principal = await createSchoolUser(db(), school, { systemRole: 'principal' });
      principalId = principal.userId;
      principalCookie = (await createSchoolSession(db(), school, principal)).cookie;
    });
    const asPrincipal = (path: string, body: object) =>
      http().post(`/api/v1${path}`).set('Cookie', principalCookie).set('Origin', ORIGIN).send(body);

    it('R154 / R115: user disable', async () => {
      const target = await staffUser('teacher');
      const s = await bearerWithDevice(target.userId);
      await asPrincipal(`/users/${target.userId}/disable`, { reason: 'Left the school' }).expect(200);
      await expectDead(s, target.userId);
    });

    it('R154 / R115: office reset', async () => {
      const target = await staffUser('teacher');
      const s = await bearerWithDevice(target.userId);
      await asPrincipal(`/users/${target.userId}/reset-password`, { reason: 'Forgot it', clearEmail: false }).expect(200);
      await expectDead(s, target.userId);
    });

    it('R154 / R115: staff left and staff suspended', async () => {
      for (const status of ['left', 'suspended'] as const) {
        const target = await staffUser('teacher');
        const s = await bearerWithDevice(target.userId);
        await asPrincipal(`/staff/${target.staffId}/change-status`, { status, reason: 'Recorded by office' }).expect(200);
        await expectDead(s, target.userId);
      }
    });

    it('R154 / R115: student status change', async () => {
      // The fixture school has no settings row; student login needs one with the switch on.
      if ((await db().schoolSettings.count({ where: { schoolId: school.id } })) === 0) {
        await db().schoolSettings.create({ data: { schoolId: school.id, feeDueDay: 10, studentLoginEnabled: true } });
      } else {
        await db().schoolSettings.updateMany({ where: { schoolId: school.id }, data: { studentLoginEnabled: true } });
      }
      const student = await createStudent(db(), school, { admittedOn: isoDay(-30) });
      const user = await db().user.create({
        data: {
          schoolId: school.id,
          usernameHash: testIdentityHash(randomIdentityDigits()),
          passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$dGVzdHNhbHQ$dGVzdC1vbmx5LW5vdC1hLWhhc2g',
          studentId: student.id,
        },
      });
      const s = await bearerWithDevice(user.id);
      await asPrincipal(`/students/${student.id}/change-status`, { status: 'suspended', reason: 'Recorded by office', effectiveOn: isoDay() }).expect(200);
      await expectDead(s, user.id);
    });

    it('R154 / R115: the issue-login reset (an existing login gaining staff capacity)', async () => {
      const target = await guardianUser();
      const s = await bearerWithDevice(target.userId);
      await resetOnStaffLink(
        {
          users: app.get(UserRepository),
          sessions: app.get(SessionRepository),
          tokens: app.get(UserTokenRepository),
          audit: app.get(AuditLogRepository),
        },
        school.id,
        target.userId,
        { defaultHash: await hasher.hash(target.cnic), now: new Date(), actor: { actorUserId: principalId }, capacity: 'teacher' },
      );
      await expectDead(s, target.userId);
    });

    it('R154 / R115 / R153: a password change on a bearer session rotates on bearer, kills the others and moves the device', async () => {
      const email = uniqueEmail();
      const user = await createSchoolUser(db(), school, { systemRole: 'teacher', password: 'old-pass-77', email, emailVerified: true }); // pragma: allowlist secret
      const mine = await bearerWithDevice(user.userId);
      const other = await createSchoolSession(db(), school, user, { channel: 'bearer' });
      await registerDevice(other, 'fcm:other-phone').expect(201);
      const res = await http()
        .post('/api/v1/me/change-password')
        .set(mine.bearer)
        .send({ currentPassword: 'old-pass-77', newPassword: 'new-pass-77' }) // pragma: allowlist secret
        .expect(200);
      const body = res.body as LoginResult;
      expect(setCookies(res)).toEqual([]);
      expect(body.bearerToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      await http().get('/api/v1/me').set(mine.bearer).expect(401);
      await http().get('/api/v1/me').set(other.bearer).expect(401);
      await http().get('/api/v1/me').set(bearerOf(body.bearerToken ?? '')).expect(200);
      // The presented session's device moved to the new session; the other phone's died.
      const live = await liveDevices(user.userId);
      expect(live.map((d) => d.pushToken)).toEqual([`fcm:dev-${mine.sessionId}`]);
      const audit = await db().auditLog.findFirst({ where: { schoolId: school.id, subjectId: user.userId, action: 'user.password_changed' } });
      expect(audit?.metadata).toEqual({ channel: 'bearer' });
    });

    it('R153: a password change on a cookie session sets the cookie and returns bearerToken null', async () => {
      const email = uniqueEmail();
      const user = await createSchoolUser(db(), school, { systemRole: 'teacher', password: 'old-pass-78', email, emailVerified: true }); // pragma: allowlist secret
      const s = await createSchoolSession(db(), school, user);
      const res = await http()
        .post('/api/v1/me/change-password')
        .set('Cookie', s.cookie)
        .set('Origin', ORIGIN)
        .send({ currentPassword: 'old-pass-78', newPassword: 'new-pass-78' }) // pragma: allowlist secret
        .expect(200);
      expect((res.body as LoginResult).bearerToken).toBeNull();
      expect(setCookies(res)[0]).toMatch(/^__Host-asms_session=/);
    });
  });

  // -------------------------------------------------------------------------- R169

  describe('R169: revoke-others and sign-out-everywhere', () => {
    it('R169: revoke-others ends every other session of the caller, any channel, and audits only when one ended', async () => {
      const user = await staffUser('teacher');
      const mine = await createSchoolSession(db(), school, user, { channel: 'bearer' });
      const cookie = await createSchoolSession(db(), school, user);
      const phone = await createSchoolSession(db(), school, user, { channel: 'bearer' });
      await registerDevice(phone, 'fcm:lost-phone').expect(201);
      const res = await http().post('/api/v1/me/sessions/revoke-others').set(mine.bearer).expect(200);
      expect(res.body).toEqual({ revoked: 2 });
      await http().get('/api/v1/me').set('Cookie', cookie.cookie).expect(401);
      await http().get('/api/v1/me').set(phone.bearer).expect(401);
      await http().get('/api/v1/me').set(mine.bearer).expect(200);
      expect(await liveDevices(user.userId)).toEqual([]);
      const again = await http().post('/api/v1/me/sessions/revoke-others').set(mine.bearer).expect(200);
      expect(again.body).toEqual({ revoked: 0 });
      const audits = await db().auditLog.findMany({ where: { schoolId: school.id, subjectId: user.userId, action: 'user.sessions_revoked' } });
      expect(audits.map((a) => a.metadata)).toEqual([{ revoked: 2 }]);
    });

    it('R169: sign-out-everywhere ends the target sessions, leaves the password, and audits with the reason', async () => {
      const office = await staffUser('office_staff');
      const officeCookie = (await createSchoolSession(db(), school, office)).cookie;
      const boss = await staffUser('principal');
      const bossCookie = (await createSchoolSession(db(), school, boss)).cookie;
      const target = await staffUser('teacher', 'keep-this-pass'); // pragma: allowlist secret
      const before = await db().user.findFirst({ where: { schoolId: school.id, id: target.userId } });
      const s = await createSchoolSession(db(), school, target, { channel: 'bearer' });
      await registerDevice(s, 'fcm:teacher-phone').expect(201);
      const post = (id: bigint, body: object, cookie = officeCookie) =>
        http().post(`/api/v1/users/${id}/sign-out-everywhere`).set('Cookie', cookie).set('Origin', ORIGIN).send(body);
      const res = await post(target.userId, { reason: 'Phone stolen' }, bossCookie).expect(200);
      expect(res.body).toEqual({ revoked: 1 });
      await http().get('/api/v1/me').set(s.bearer).expect(401);
      expect(await liveDevices(target.userId)).toEqual([]);
      const after = await db().user.findFirst({ where: { schoolId: school.id, id: target.userId } });
      expect(after?.passwordHash).toBe(before?.passwordHash);
      expect(after?.status).toBe('active');
      // Nothing left to revoke: 200 { revoked: 0 } and no second audit row.
      expect((await post(target.userId, { reason: 'Again please' }, bossCookie).expect(200)).body).toEqual({ revoked: 0 });
      const audits = await db().auditLog.findMany({ where: { schoolId: school.id, subjectId: target.userId, action: 'user.signed_out_everywhere' } });
      expect(audits.map((a) => [a.actorUserId, a.reason, a.metadata])).toEqual([[boss.userId, 'Phone stolen', { revoked: 1 }]]);
      // R10, R12, R14: not oneself; a principal only by a role.manage holder; a target holding more
      // than the caller is out of reach; 404 for an absent id; 422 without a reason.
      expect(codeOf(await post(office.userId, { reason: 'Myself' }).expect(409))).toBe('SELF_ACTION_FORBIDDEN');
      const exceeds = await post(target.userId, { reason: 'Not mine' }).expect(403);
      expect((exceeds.body as ErrorBody).error.details).toEqual({ reason: 'target_exceeds_actor' });
      const principal = await staffUser('principal');
      const refused = await post(principal.userId, { reason: 'Not allowed' }).expect(403);
      expect((refused.body as ErrorBody).error.details).toEqual({ reason: 'target_is_principal' });
      await post(999_999_999n, { reason: 'Nobody' }).expect(404);
      await post(target.userId, {}).expect(422);
    });
  });

  // -------------------------------------------------------------------- /me additions

  describe('GET /me: capacities and assignments (R156)', () => {
    it('a teacher sees staff capacity and today\'s assignments, sorted, with the class attendance mode', async () => {
      const teacher = await staffUser('teacher');
      const year = await createAcademicYear(db(), school);
      const klass = await createClass(db(), school, year, { name: 'Class B', attendanceMode: 'period' });
      const section = await createSection(db(), school, klass);
      const other = await createClass(db(), school, year, { name: 'Class A' });
      const subject = await createSubject(db(), school);
      const base = { schoolId: school.id, staffId: teacher.staffId, academicYearId: year.id, subjectId: null };
      await db().teacherAssignment.create({ data: { ...base, classId: klass.id, sectionId: section.id, role: 'class_teacher', startsOn: day(isoDay(-5)) } });
      await db().teacherAssignment.create({ data: { ...base, classId: other.id, sectionId: null, subjectId: subject.id, role: 'subject_teacher', startsOn: day(isoDay(-5)), endsOn: day(isoDay(-1)) } });
      await db().teacherAssignment.create({ data: { ...base, classId: other.id, sectionId: (await createSection(db(), school, other)).id, role: 'class_teacher', startsOn: day(isoDay(2)) } });
      const s = await createSchoolSession(db(), school, teacher);
      const me = (await http().get('/api/v1/me').set('Cookie', s.cookie).expect(200)).body as LoginResult;
      expect(me.capacities).toEqual(['staff']);
      // Ended yesterday and starting in two days are not active today.
      expect(me.assignments).toEqual([
        expect.objectContaining({
          role: 'class_teacher',
          classId: klass.id.toString(),
          className: 'Class B',
          sectionId: section.id.toString(),
          subjectId: null,
          attendanceMode: 'period',
          startsOn: isoDay(-5),
          endsOn: null,
        }),
      ]);
    });

    it('a guardian-only login has capacity guardian and no assignments', async () => {
      const parent = await guardianUser();
      const s = await createSchoolSession(db(), school, parent);
      const me = (await http().get('/api/v1/me').set('Cookie', s.cookie).expect(200)).body as LoginResult;
      expect(me.capacities).toEqual(['guardian']);
      expect(me.assignments).toEqual([]);
    });
  });

  // ------------------------------------------------------------- DeviceRepository tenancy

  it('isolation: DeviceRepository as school B neither reads nor writes school A devices; a same token in B is untouched by A', async () => {
    const other = await createSchool();
    const user = await staffUser('teacher');
    const s = await createSchoolSession(db(), school, user, { channel: 'bearer' });
    await registerDevice(s, 'fcm:cross-tenant').expect(201);
    const repo = devices();
    expect(await repo.findForSession(other.id, s.sessionId)).toBeNull();
    expect(await repo.liveForUsers(other.id, [user.userId], 30 * DAY, new Date())).toEqual([]);
    expect(await repo.unregisterForSession(other.id, s.sessionId, 'sign_out', new Date())).toBe(0);
    expect(await repo.unregisterForUser(other.id, user.userId, 'fcm_unregistered', new Date())).toBe(0);
    expect(await repo.replaceOthersWithToken(other.id, 'fcm:cross-tenant', 0n, new Date())).toBe(0);
    expect(await liveDevices(user.userId)).toHaveLength(1);
  });

  // --------------------------------------------------------- R163 @RequireCapacity

  describe('R163: @RequireCapacity admits only that capacity', () => {
    it('R163: a guardian reaches a guardian route; staff and students are 403', async () => {
      const parent = await guardianUser();
      const p = await createSchoolSession(db(), school, parent);
      await http().get('/api/v1/test-access/guardian').set('Cookie', p.cookie).expect(200);
      await http().get('/api/v1/test-access/student').set('Cookie', p.cookie).expect(403);
      const teacher = await staffUser('teacher');
      const t = await createSchoolSession(db(), school, teacher);
      const res = await http().get('/api/v1/test-access/guardian').set('Cookie', t.cookie).expect(403);
      expect(codeOf(res)).toBe('PERMISSION_DENIED');
      await http().get('/api/v1/test-access/guardian').expect(401);
    });
  });

  // ------------------------------------------------------------------------- R166

  describe('R166: per-user throttles on /me', () => {
    const fill = async (name: string, key: string, hits: number, limit: number) => {
      const storage = app.get(ThrottlerStorageRedisService);
      for (let i = 0; i < hits; i++) await storage.increment(`asms:${name}:${key}`, 60_000, limit, 60_000, name);
    };

    it('R166: GET /me is limited to 120 a minute per user', async () => {
      const user = await staffUser('teacher');
      const s = await createSchoolSession(db(), school, user, { channel: 'bearer' });
      await fill('me-reads-minute', `${school.id}:${user.userId}`, 119, 120);
      await http().get('/api/v1/me').set(s.bearer).expect(200);
      const res = await http().get('/api/v1/me').set(s.bearer).expect(429);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('R166: POST /me/devices is limited to 10 a minute per user', async () => {
      const user = await staffUser('teacher');
      const s = await createSchoolSession(db(), school, user, { channel: 'bearer' });
      for (let i = 0; i < 10; i++) await registerDevice(s, 'fcm:throttled');
      await registerDevice(s, 'fcm:throttled').expect(429);
    });

    it('R166: POST /me/sessions/revoke-others is limited to 5 a minute per user', async () => {
      const user = await staffUser('teacher');
      const s = await createSchoolSession(db(), school, user, { channel: 'bearer' });
      for (let i = 0; i < 5; i++) await http().post('/api/v1/me/sessions/revoke-others').set(s.bearer).expect(200);
      await http().post('/api/v1/me/sessions/revoke-others').set(s.bearer).expect(429);
    });
  });
});
