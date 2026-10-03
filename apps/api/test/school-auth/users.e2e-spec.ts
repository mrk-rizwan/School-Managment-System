// Users administration (contract slice-2 §5): R4, R5, R6, R9, R10, R12, R14, R57, R62 (users via
// the API), R67, R72, R73, R80 (office reset and disable while suspended), R99.
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Mailer } from '../../src/modules/auth/mailer';
import { createTestApp } from '../core/app';
import { createSchoolSession, createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import { createStudent, linkGuardian } from '../support/students';
import { createGuardianUser, FakeMailer, nextIp, ORIGIN, uniqueEmail } from './support';

type ErrorBody = { error: { code: string; details: { reason?: string } | null } };
type UserBody = {
  id: string;
  staffId: string | null;
  guardianId: string | null;
  studentId: string | null;
  fullName: string;
  systemRoles: string[];
  status: string;
  emailMasked: string | null;
  hasEmail: boolean;
  hasVerifiedEmail: boolean;
  passwordIsDefault: boolean;
  lastLoginAt: string | null;
  createdAt: string;
};
type PageBody = { data: UserBody[]; page: number; limit: number; total: number };

describe('users administration', () => {
  let app: NestExpressApplication;
  let school: TestSchool;
  let principal: TestSchoolUser;
  let principalCookie: string;
  let office: TestSchoolUser;
  let officeCookie: string;
  const mailer = new FakeMailer();
  const db = () => testDb();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp({ overrides: [{ provide: Mailer, useValue: mailer }] });
    school = await createSchool();
    principal = await createSchoolUser(db(), school, { systemRole: 'principal', fullName: 'Pat Principal' });
    principalCookie = (await createSchoolSession(db(), school, principal)).cookie;
    office = await createSchoolUser(db(), school, { systemRole: 'office_staff', fullName: 'Olive Office' });
    officeCookie = (await createSchoolSession(db(), school, office)).cookie;
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const get = (path: string, cookie: string) => http().get(`/api/v1${path}`).set('Cookie', cookie);
  const post = (path: string, cookie: string, body: object) =>
    http().post(`/api/v1${path}`).set('Cookie', cookie).set('Origin', ORIGIN).send(body);
  const codeOf = (res: { body: unknown }) => (res.body as ErrorBody).error.code;
  const reasonOf = (res: { body: unknown }) => (res.body as ErrorBody).error.details?.reason;
  const auditFor = (userId: bigint, action: string) =>
    db().auditLog.findMany({ where: { schoolId: school.id, subjectId: userId, action } });

  describe('GET /users', () => {
    it('lists the school’s users with masked email and no identity number', async () => {
      const email = uniqueEmail();
      const teacher = await createSchoolUser(db(), school, { systemRole: 'teacher', email, emailVerified: true, fullName: 'Tara Teacher' });
      const res = await get('/users?limit=50&q=Tara', officeCookie).expect(200);
      const page = res.body as PageBody;
      const row = page.data.find((u) => u.id === teacher.userId.toString());
      expect(row).toMatchObject({
        staffId: teacher.staffId.toString(),
        guardianId: null,
        studentId: null,
        fullName: 'Tara Teacher',
        systemRoles: ['teacher'],
        status: 'active',
        emailMasked: `${email.slice(0, 1)}***@example.test`,
        hasEmail: true,
        hasVerifiedEmail: true,
        passwordIsDefault: false,
        lastLoginAt: null,
      });
      expect(JSON.stringify(res.body)).not.toMatch(/[0-9]{13}/);
      expect(JSON.stringify(res.body)).not.toContain(email);
    });

    it('filters by status, default password, email and kind', async () => {
      const filtered = await createSchool();
      const p = await createSchoolUser(db(), filtered, { systemRole: 'principal' });
      const cookie = (await createSchoolSession(db(), filtered, p)).cookie;
      await createSchoolUser(db(), filtered, { systemRole: 'teacher', userStatus: 'disabled' });
      await createSchoolUser(db(), filtered, { systemRole: 'teacher', defaultPassword: true });
      await createSchoolUser(db(), filtered, { systemRole: 'teacher', email: uniqueEmail() });
      await createGuardianUser(db(), filtered);
      const count = async (q: string) => ((await get(`/users?${q}`, cookie).expect(200)).body as PageBody).total;
      expect(await count('')).toBe(5);
      expect(await count('status=disabled')).toBe(1);
      // The default-password teacher and the guardian (column default true).
      expect(await count('passwordIsDefault=true')).toBe(2);
      expect(await count('hasEmail=true')).toBe(1);
      expect(await count('hasEmail=false')).toBe(4);
      expect(await count('kind=guardian')).toBe(1);
      expect(await count('kind=staff')).toBe(4);
      expect(await count('kind=student')).toBe(0);
    });

    it('R67 / §3.6: limit above 50, a 13-digit q, a bad boolean, an unknown sort are 422', async () => {
      await get('/users?limit=51', officeCookie).expect(422);
      await get('/users?q=3520212345671', officeCookie).expect(422);
      await get('/users?q=35202-1234567-1', officeCookie).expect(422);
      // Spaces and `+` (a space in a query string) do not hide one either.
      await get('/users?q=35202+1234567+1', officeCookie).expect(422);
      await get('/users?q=35202%201234567%201', officeCookie).expect(422);
      await get('/users?q=35202%2B1234567%2B1', officeCookie).expect(422);
      await get('/users?hasEmail=yes', officeCookie).expect(422);
      await get('/users?sort=email', officeCookie).expect(422);
      await get('/users?schoolId=1', officeCookie).expect(422);
    });

    it('sorts by full name with an id tiebreak, and pages', async () => {
      const sorted = await createSchool();
      const p = await createSchoolUser(db(), sorted, { systemRole: 'principal', fullName: 'Bravo' });
      const cookie = (await createSchoolSession(db(), sorted, p)).cookie;
      await createSchoolUser(db(), sorted, { systemRole: 'teacher', fullName: 'Alpha' });
      await createSchoolUser(db(), sorted, { systemRole: 'teacher', fullName: 'Charlie' });
      const names = (q: string) => get(`/users?${q}`, cookie).then((r) => (r.body as PageBody).data.map((u) => u.fullName));
      expect(await names('')).toEqual(['Alpha', 'Bravo', 'Charlie']);
      expect(await names('sort=-fullName')).toEqual(['Charlie', 'Bravo', 'Alpha']);
      expect(await names('limit=1&page=2')).toEqual(['Bravo']);
    });

    it('R62: another school’s user is 404 and never listed', async () => {
      const other = await createSchool();
      const stranger = await createSchoolUser(db(), other, { systemRole: 'teacher' });
      await get(`/users/${stranger.userId}`, principalCookie).expect(404);
      const all = (await get('/users?limit=50', principalCookie).expect(200)).body as PageBody;
      expect(all.data.map((u) => u.id)).not.toContain(stranger.userId.toString());
      await post(`/users/${stranger.userId}/disable`, principalCookie, { reason: 'not mine' }).expect(404);
      expect((await db().user.findFirst({ where: { schoolId: other.id, id: stranger.userId } }))?.status).toBe('active');
    });

    it('a teacher (no user.account.manage) is 403; a malformed id is 404', async () => {
      const teacher = await createSchoolUser(db(), school, { systemRole: 'teacher' });
      const { cookie } = await createSchoolSession(db(), school, teacher);
      expect(codeOf(await get('/users', cookie).expect(403))).toBe('PERMISSION_DENIED');
      await get('/users/abc', officeCookie).expect(404);
      await get('/users/0', officeCookie).expect(404);
    });
  });

  describe('POST /users/:id/reset-password', () => {
    it('R4 / R5: default password, flag on, sessions revoked, tokens voided, lockout cleared, email kept', async () => {
      const email = uniqueEmail();
      const target = await createSchoolUser(db(), school, { systemRole: 'teacher', password: 'chosen-pass-1', email, emailVerified: true }); // pragma: allowlist secret
      const s = await createSchoolSession(db(), school, target);
      await db().userToken.create({
        data: { schoolId: school.id, userId: target.userId, purpose: 'password_reset', tokenHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60_000) },
      });
      // Lock the account first.
      for (let i = 0; i < 5; i++) {
        await http().post('/api/v1/auth/login').set('Origin', ORIGIN).set('X-Forwarded-For', nextIp())
          .send({ schoolCode: school.shortCode, username: target.cnic, password: 'wrong' }).expect(401);
      }
      const res = await post(`/users/${target.userId}/reset-password`, principalCookie, { reason: 'Forgot it at the desk', clearEmail: false }).expect(200);
      expect(res.body as UserBody).toMatchObject({ passwordIsDefault: true, hasEmail: true, status: 'active' });
      await http().get('/api/v1/me').set('Cookie', s.cookie).expect(401);
      const tokens = await db().userToken.count({ where: { schoolId: school.id, userId: target.userId, usedAt: null, expiresAt: { gt: new Date() } } });
      expect(tokens).toBe(0);
      // The lock is cleared and the default password (the digits) works.
      await http().post('/api/v1/auth/login').set('Origin', ORIGIN).set('X-Forwarded-For', nextIp())
        .send({ schoolCode: school.shortCode, username: target.cnic, password: target.cnic }).expect(200);
      const [audit] = await auditFor(target.userId, 'user.office_reset');
      expect(audit).toMatchObject({ actorUserId: principal.userId, reason: 'Forgot it at the desk', metadata: { clearEmail: false } });
      // A kept, verified address is told.
      expect((await mailer.next(email)).subject).toBe('Your password was reset by the school office');
      // The first login after it is audited.
      expect(await auditFor(target.userId, 'user.login_after_office_reset')).toHaveLength(1);
    });

    it('R4: clearEmail removes the address and its verification', async () => {
      const email = uniqueEmail();
      const target = await createSchoolUser(db(), school, { systemRole: 'teacher', email, emailVerified: true });
      const res = await post(`/users/${target.userId}/reset-password`, principalCookie, { reason: 'Planted address', clearEmail: true }).expect(200);
      expect(res.body as UserBody).toMatchObject({ hasEmail: false, hasVerifiedEmail: false, emailMasked: null });
      expect(mailer.to(email)).toEqual([]);
    });

    it('R6: a disabled user stays disabled', async () => {
      const target = await createSchoolUser(db(), school, { systemRole: 'teacher', userStatus: 'disabled' });
      const res = await post(`/users/${target.userId}/reset-password`, principalCookie, { reason: 'Reset anyway', clearEmail: false }).expect(200);
      expect((res.body as UserBody).status).toBe('disabled');
    });

    it('resets a guardian login to the guardian’s CNIC digits', async () => {
      const parent = await createGuardianUser(db(), school);
      await post(`/users/${parent.userId}/reset-password`, officeCookie, { reason: 'Parent forgot', clearEmail: false }).expect(200);
      const me = await http().post('/api/v1/auth/login').set('Origin', ORIGIN).set('X-Forwarded-For', nextIp())
        .send({ schoolCode: school.shortCode, username: parent.cnic, password: parent.cnic }).expect(200);
      expect((me.body as { roles: string[] }).roles).toEqual(['parent']);
    });

    it('409 IDENTITY_NUMBER_MISSING when there is no identity number to reset to', async () => {
      const target = await createSchoolUser(db(), school, { systemRole: 'teacher' });
      await db().staff.update({ where: { schoolId_id: { schoolId: school.id, id: target.staffId } }, data: { cnic: null, cnicHash: null } });
      const res = await post(`/users/${target.userId}/reset-password`, principalCookie, { reason: 'No number', clearEmail: false }).expect(409);
      expect(codeOf(res)).toBe('IDENTITY_NUMBER_MISSING');
    });

    it('422: clearEmail is required; a reason with an identity number is refused', async () => {
      const target = await createSchoolUser(db(), school, { systemRole: 'teacher' });
      await post(`/users/${target.userId}/reset-password`, principalCookie, { reason: 'No choice made' }).expect(422);
      await post(`/users/${target.userId}/reset-password`, principalCookie, { reason: 'cnic 35202-1234567-1', clearEmail: false }).expect(422);
      await post(`/users/${target.userId}/reset-password`, principalCookie, { reason: 'x', clearEmail: false }).expect(422);
    });
  });

  describe('target rules (§5.3)', () => {
    it('R10: nobody resets, disables or enables themselves', async () => {
      const reset = await post(`/users/${office.userId}/reset-password`, officeCookie, { reason: 'Myself', clearEmail: false }).expect(409);
      expect(codeOf(reset)).toBe('SELF_ACTION_FORBIDDEN');
      const disable = await post(`/users/${office.userId}/disable`, officeCookie, { reason: 'Myself' }).expect(409);
      expect(codeOf(disable)).toBe('SELF_ACTION_FORBIDDEN');
      const enable = await post(`/users/${office.userId}/enable`, officeCookie, { reason: 'Myself' }).expect(409);
      expect(codeOf(enable)).toBe('SELF_ACTION_FORBIDDEN');
    });

    it('R12: office staff cannot act on a principal (target_is_principal); a principal can', async () => {
      const second = await createSchoolUser(db(), school, { systemRole: 'principal' });
      const res = await post(`/users/${second.userId}/reset-password`, officeCookie, { reason: 'Try it', clearEmail: false }).expect(403);
      expect(codeOf(res)).toBe('PERMISSION_DENIED');
      expect(reasonOf(res)).toBe('target_is_principal');
      await post(`/users/${second.userId}/disable`, officeCookie, { reason: 'Try it' }).expect(403);
      await post(`/users/${second.userId}/reset-password`, principalCookie, { reason: 'Principal may', clearEmail: false }).expect(200);
    });

    it('R14: office staff cannot act on a user holding capabilities the clerk lacks (target_exceeds_actor)', async () => {
      // Office staff + teacher holds attendance.student.mark etc., which office staff alone lacks.
      const target = await createSchoolUser(db(), school, { systemRole: 'teacher' });
      const res = await post(`/users/${target.userId}/disable`, officeCookie, { reason: 'Too strong' }).expect(403);
      expect(reasonOf(res)).toBe('target_exceeds_actor');
      // Another office clerk is within the clerk's set.
      const peer = await createSchoolUser(db(), school, { systemRole: 'office_staff' });
      await post(`/users/${peer.userId}/disable`, officeCookie, { reason: 'Peer is fine' }).expect(200);
    });

    it('R14 reads live role rows whatever the staff status: a suspended teacher is still out of reach', async () => {
      // Suspended: no effective capability (R59), but reinstating it restores the teacher set.
      const target = await createSchoolUser(db(), school, { systemRole: 'teacher', staffStatus: 'suspended' });
      for (const [path, body] of [
        ['reset-password', { reason: 'Suspended reset', clearEmail: false }],
        ['disable', { reason: 'Suspended disable' }],
      ] as const) {
        const res = await post(`/users/${target.userId}/${path}`, officeCookie, body).expect(403);
        expect(reasonOf(res)).toBe('target_exceeds_actor');
      }
      // Guardian issue-login links an existing login by CNIC; the same rule applies there.
      const guardian = await post('/guardians', officeCookie, {
        fullName: 'Suspended Teacher As Parent',
        cnic: target.cnic,
        contactCapability: 'keypad',
      }).expect(201);
      // Guardian issue-login needs a live link with can_login (contracts/slice-6.md §9).
      const child = await createStudent(db(), school);
      await linkGuardian(db(), school, child, { id: BigInt((guardian.body as { id: string }).id) }, { canLogin: true });
      const linked = await post(`/guardians/${(guardian.body as { id: string }).id}/issue-login`, officeCookie, {}).expect(403);
      expect(reasonOf(linked)).toBe('target_exceeds_actor');
      const row = await db().user.findFirst({ where: { schoolId: school.id, id: target.userId } });
      expect(row).toMatchObject({ status: 'active', guardianId: null });
    });
  });

  describe('disable and enable', () => {
    it('R9: disabling revokes every session at once and voids tokens; enable restores login', async () => {
      const target = await createSchoolUser(db(), school, { systemRole: 'office_staff', password: 'disable-me-1' }); // pragma: allowlist secret
      const cookie = await createSchoolSession(db(), school, target);
      const bearer = await createSchoolSession(db(), school, target, { channel: 'bearer' });
      const res = await post(`/users/${target.userId}/disable`, principalCookie, { reason: 'Left the office' }).expect(200);
      expect((res.body as UserBody).status).toBe('disabled');
      await http().get('/api/v1/me').set('Cookie', cookie.cookie).expect(401);
      await http().get('/api/v1/me').set('Authorization', bearer.authorization).expect(401);
      await http().post('/api/v1/auth/login').set('Origin', ORIGIN).set('X-Forwarded-For', nextIp())
        .send({ schoolCode: school.shortCode, username: target.cnic, password: 'disable-me-1' }).expect(401); // pragma: allowlist secret
      // Already disabled: 200, no second audit row.
      await post(`/users/${target.userId}/disable`, principalCookie, { reason: 'Again' }).expect(200);
      expect(await auditFor(target.userId, 'user.disabled')).toHaveLength(1);
      await post(`/users/${target.userId}/enable`, principalCookie, { reason: 'Came back' }).expect(200);
      await http().post('/api/v1/auth/login').set('Origin', ORIGIN).set('X-Forwarded-For', nextIp())
        .send({ schoolCode: school.shortCode, username: target.cnic, password: 'disable-me-1' }).expect(200); // pragma: allowlist secret
      const [enabled] = await auditFor(target.userId, 'user.enabled');
      expect(enabled).toMatchObject({ actorUserId: principal.userId, reason: 'Came back' });
    });

    it('R72: the last active principal cannot be disabled', async () => {
      const lone = await createSchool();
      const only = await createSchoolUser(db(), lone, { systemRole: 'principal' });
      const backup = await createSchoolUser(db(), lone, { systemRole: 'principal' });
      const backupCookie = (await createSchoolSession(db(), lone, backup)).cookie;
      // Two principals: one may disable the other.
      await post(`/users/${only.userId}/disable`, backupCookie, { reason: 'One is enough' }).expect(200);
      // Now `backup` is the last; a third principal cannot remove them.
      const third = await createSchoolUser(db(), lone, { systemRole: 'principal', staffStatus: 'active' });
      await db().userRole.updateMany({ where: { schoolId: lone.id, userId: third.userId }, data: { endedAt: new Date(), endedBy: third.userId } });
      await db().userRole.create({ data: { schoolId: lone.id, userId: third.userId, systemRole: 'office_staff', assignedBy: backup.userId } });
      await db().userRole.create({ data: { schoolId: lone.id, userId: third.userId, systemRole: 'principal', assignedBy: backup.userId } });
      const thirdCookie = (await createSchoolSession(db(), lone, third)).cookie;
      await post(`/users/${backup.userId}/disable`, thirdCookie, { reason: 'Leave one' }).expect(200);
      const res = await post(`/users/${third.userId}/disable`, backupCookie, { reason: 'Last one' });
      // backup is disabled now, so its session is gone.
      expect(res.status).toBe(401);
      // The last principal standing (third) cannot be disabled by anyone holding role.manage.
      const fourth = await createSchoolUser(db(), lone, { systemRole: 'office_staff' });
      const fourthCookie = (await createSchoolSession(db(), lone, fourth)).cookie;
      const refused = await post(`/users/${third.userId}/disable`, fourthCookie, { reason: 'Clerk tries' }).expect(403);
      expect(reasonOf(refused)).toBe('target_is_principal');
    });

    it('R72 / R73: two principals disabling each other concurrently, exactly one succeeds', async () => {
      const pair = await createSchool();
      const a = await createSchoolUser(db(), pair, { systemRole: 'principal' });
      const b = await createSchoolUser(db(), pair, { systemRole: 'principal' });
      const aCookie = (await createSchoolSession(db(), pair, a)).cookie;
      const bCookie = (await createSchoolSession(db(), pair, b)).cookie;
      const [x, y] = await Promise.all([
        post(`/users/${b.userId}/disable`, aCookie, { reason: 'Race A' }),
        post(`/users/${a.userId}/disable`, bCookie, { reason: 'Race B' }),
      ]);
      const statuses = [x.status, y.status].sort();
      expect(statuses[0]).toBe(200);
      expect([401, 409]).toContain(statuses[1]);
      const active = await db().user.count({ where: { schoolId: pair.id, status: 'active' } });
      expect(active).toBe(1);
    });

    it('R80: in a suspended school disable and office reset work; enable does not', async () => {
      const suspended = await createSchool({ status: 'suspended' });
      const p = await createSchoolUser(db(), suspended, { systemRole: 'principal' });
      const cookie = (await createSchoolSession(db(), suspended, p)).cookie;
      const target = await createSchoolUser(db(), suspended, { systemRole: 'teacher' });
      await post(`/users/${target.userId}/reset-password`, cookie, { reason: 'Suspended reset', clearEmail: false }).expect(200);
      await post(`/users/${target.userId}/disable`, cookie, { reason: 'Suspended disable' }).expect(200);
      const res = await post(`/users/${target.userId}/enable`, cookie, { reason: 'Suspended enable' }).expect(403);
      expect(codeOf(res)).toBe('SCHOOL_SUSPENDED');
      await get('/users', cookie).expect(200);
    });
  });
});
