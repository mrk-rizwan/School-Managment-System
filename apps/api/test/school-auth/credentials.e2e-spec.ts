// Password and email flows (contract slice-2 §3.3-§3.5, §4.2-§4.3): R2, R3, R7, R8, R93, R98,
// R99 (locks), R100, and the cross-school token rule.
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Mailer } from '../../src/modules/auth/mailer';
import { createTestApp } from '../core/app';
import { createSchoolSession, createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import { FakeMailer, nextIp, ORIGIN, pause, setCookies, tokenFrom, uniqueEmail } from './support';

type ErrorBody = { error: { code: string; details: { fields?: { path: string }[] } | null } };
type Me = { email: string | null; hasVerifiedEmail: boolean; passwordIsDefault: boolean };

describe('password and email flows', () => {
  let app: NestExpressApplication;
  let school: TestSchool;
  const mailer = new FakeMailer();
  const db = () => testDb();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp({ overrides: [{ provide: Mailer, useValue: mailer }] });
    school = await createSchool();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const post = (path: string, body: object, ip = nextIp()) =>
    http().post(`/api/v1${path}`).set('Origin', ORIGIN).set('X-Forwarded-For', ip).send(body);
  const asUser = (path: string, cookie: string, body: object) =>
    http().post(`/api/v1${path}`).set('Origin', ORIGIN).set('Cookie', cookie).send(body);
  const codeOf = (res: { body: unknown }) => (res.body as ErrorBody).error.code;
  const userRow = (u: TestSchoolUser) => db().user.findFirst({ where: { schoolId: u.schoolId, id: u.userId } });
  const liveSessions = (u: TestSchoolUser) =>
    db().session.count({ where: { schoolId: u.schoolId, userId: u.userId, revokedAt: null } });

  async function verifiedUser(password = 'old-password-1'): Promise<TestSchoolUser & { email: string }> { // pragma: allowlist secret
    const email = uniqueEmail();
    const user = await createSchoolUser(db(), school, { systemRole: 'teacher', password, email, emailVerified: true });
    return { ...user, email };
  }

  async function forgot(user: { cnic: string }, schoolCode = school.shortCode) {
    const res = await post('/auth/forgot-password', { schoolCode, username: user.cnic }).expect(202);
    expect(res.body).toEqual({});
  }

  describe('forgot and reset', () => {
    it('R2 / R3: forgot-password always answers 202 {} and mails only a verified, active account', async () => {
      const verified = await verifiedUser();
      const unverifiedEmail = uniqueEmail();
      const unverified = await createSchoolUser(db(), school, { systemRole: 'teacher', email: unverifiedEmail });
      const disabledEmail = uniqueEmail();
      const disabled = await createSchoolUser(db(), school, {
        systemRole: 'teacher',
        email: disabledEmail,
        emailVerified: true,
        userStatus: 'disabled',
      });
      await forgot(verified);
      await forgot(unverified);
      await forgot(disabled);
      await forgot({ cnic: '1112223334445' });
      await forgot(verified, 'nosuchschool');
      const message = await mailer.next(verified.email);
      expect(message.text).toContain(`/reset/${school.shortCode}#token=`);
      await pause(300);
      expect(mailer.to(unverifiedEmail)).toEqual([]);
      expect(mailer.to(disabledEmail)).toEqual([]);
      expect(mailer.to(verified.email)).toHaveLength(1);
    });

    it('R2: forgot-password takes no email', async () => {
      const res = await post('/auth/forgot-password', {
        schoolCode: school.shortCode,
        username: '1234567890123',
        email: 'a@b.test',
      }).expect(422);
      expect(codeOf(res)).toBe('VALIDATION_FAILED');
    });

    it('resets by token: new password, default flag off, all sessions revoked, tokens single-use', async () => {
      const user = await verifiedUser();
      const s1 = await createSchoolSession(db(), school, user);
      await db().user.update({ where: { schoolId_id: { schoolId: school.id, id: user.userId } }, data: { passwordIsDefault: true } });
      await forgot(user);
      const token = tokenFrom(await mailer.next(user.email));
      await post('/auth/reset-password', { schoolCode: school.shortCode, token, newPassword: 'brand-new-pass' }).expect(204); // pragma: allowlist secret
      expect(await liveSessions(user)).toBe(0);
      await http().get('/api/v1/me').set('Cookie', s1.cookie).expect(401);
      const row = await userRow(user);
      expect(row?.passwordIsDefault).toBe(false);
      expect(row?.passwordChangedAt).not.toBeNull();
      await post('/auth/login', { schoolCode: school.shortCode, username: user.cnic, password: 'brand-new-pass' }).expect(200); // pragma: allowlist secret
      // Single use.
      const again = await post('/auth/reset-password', { schoolCode: school.shortCode, token, newPassword: 'another-pass' }).expect(409); // pragma: allowlist secret
      expect(codeOf(again)).toBe('TOKEN_INVALID');
      const audit = await db().auditLog.findFirst({
        where: { schoolId: school.id, subjectId: user.userId, action: 'user.password_reset_by_token' },
      });
      expect(audit?.actorUserId).toBe(user.userId);
      // A notice went to the address.
      expect((await mailer.next(user.email, 1)).subject).toBe('Your password was changed');
    });

    it('a second forgot-password voids the first token', async () => {
      const user = await verifiedUser();
      await forgot(user);
      const first = tokenFrom(await mailer.next(user.email));
      await forgot(user);
      const second = tokenFrom(await mailer.next(user.email, 1));
      await post('/auth/reset-password', { schoolCode: school.shortCode, token: first, newPassword: 'first-token-pw' }).expect(409); // pragma: allowlist secret
      await post('/auth/reset-password', { schoolCode: school.shortCode, token: second, newPassword: 'second-token-pw' }).expect(204); // pragma: allowlist secret
    });

    it('a reset token from school A cannot reset the same digits in school B', async () => {
      const other = await createSchool();
      const a = await verifiedUser();
      const b = await createSchoolUser(db(), other, { systemRole: 'teacher', password: 'b-password-1' }); // pragma: allowlist secret
      await db().user.update({ where: { schoolId_id: { schoolId: other.id, id: b.userId } }, data: { usernameHash: a.usernameHash } });
      await forgot(a);
      const token = tokenFrom(await mailer.next(a.email));
      const res = await post('/auth/reset-password', { schoolCode: other.shortCode, token, newPassword: 'cross-school-pw' }).expect(409); // pragma: allowlist secret
      expect(codeOf(res)).toBe('TOKEN_INVALID');
      await post('/auth/reset-password', { schoolCode: school.shortCode, token, newPassword: 'cross-school-pw' }).expect(204); // pragma: allowlist secret
    });

    it('an expired token and an unknown token are TOKEN_INVALID', async () => {
      const user = await verifiedUser();
      await forgot(user);
      const token = tokenFrom(await mailer.next(user.email));
      await db().userToken.updateMany({
        where: { schoolId: school.id, userId: user.userId, usedAt: null },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await post('/auth/reset-password', { schoolCode: school.shortCode, token, newPassword: 'expired-pw-1' }).expect(409); // pragma: allowlist secret
      await post('/auth/reset-password', { schoolCode: school.shortCode, token: 'A'.repeat(43), newPassword: 'unknown-pw-1' }).expect(409); // pragma: allowlist secret
      await post('/auth/reset-password', { schoolCode: 'nosuchschool', token: 'A'.repeat(43), newPassword: 'unknown-pw-1' }).expect(409); // pragma: allowlist secret
    });

    it('R100: a token is refused once its user is disabled', async () => {
      const user = await verifiedUser();
      await forgot(user);
      const token = tokenFrom(await mailer.next(user.email));
      await db().user.update({ where: { schoolId_id: { schoolId: school.id, id: user.userId } }, data: { status: 'disabled' } });
      await post('/auth/reset-password', { schoolCode: school.shortCode, token, newPassword: 'disabled-pw-1' }).expect(409); // pragma: allowlist secret
    });

    it('the new password may not be the username digits (422 on newPassword); the token survives', async () => {
      const user = await verifiedUser();
      await forgot(user);
      const token = tokenFrom(await mailer.next(user.email));
      const res = await post('/auth/reset-password', { schoolCode: school.shortCode, token, newPassword: user.cnic }).expect(422);
      expect((res.body as ErrorBody).error.details?.fields?.[0]?.path).toBe('newPassword');
      await post('/auth/reset-password', { schoolCode: school.shortCode, token, newPassword: 'not-the-username' }).expect(204); // pragma: allowlist secret
    });

    it('a reset clears the login lockout', async () => {
      const user = await verifiedUser('lockout-old-pw');
      for (let i = 0; i < 5; i++) {
        await post('/auth/login', { schoolCode: school.shortCode, username: user.cnic, password: 'bad' }).expect(401);
      }
      await forgot(user);
      const token = tokenFrom(await mailer.next(user.email));
      await post('/auth/reset-password', { schoolCode: school.shortCode, token, newPassword: 'unlocked-new-pw' }).expect(204); // pragma: allowlist secret
      await post('/auth/login', { schoolCode: school.shortCode, username: user.cnic, password: 'unlocked-new-pw' }).expect(200); // pragma: allowlist secret
    });

    it('forgot-password is throttled 3/hour per school code and username', async () => {
      const body = { schoolCode: school.shortCode, username: '4445556667778' };
      for (let i = 0; i < 3; i++) await post('/auth/forgot-password', body).expect(202);
      const res = await post('/auth/forgot-password', body).expect(429);
      expect(res.headers['retry-after']).toBeDefined();
    });
  });

  describe('change email and verify', () => {
    it('R7 / R93: a new address is unverified, mails a link bound to it, and voids earlier tokens', async () => {
      const user = await createSchoolUser(db(), school, { systemRole: 'teacher', password: 'email-pass-1' }); // pragma: allowlist secret
      const { cookie } = await createSchoolSession(db(), school, user);
      const first = uniqueEmail();
      const res = await asUser('/me/change-email', cookie, { currentPassword: 'email-pass-1', email: ` ${first.toUpperCase()} ` }).expect(200); // pragma: allowlist secret
      expect(res.body as Me).toMatchObject({ email: first, hasVerifiedEmail: false });
      const firstToken = tokenFrom(await mailer.next(first));
      expect((await mailer.next(first)).text).toContain(`/verify-email/${school.shortCode}#token=`);
      const second = uniqueEmail();
      await asUser('/me/change-email', cookie, { currentPassword: 'email-pass-1', email: second }).expect(200); // pragma: allowlist secret
      const secondToken = tokenFrom(await mailer.next(second));
      // The first link is void (R93) and bound to an address no longer on the account.
      expect(codeOf(await post('/auth/verify-email', { schoolCode: school.shortCode, token: firstToken }).expect(409))).toBe('TOKEN_INVALID');
      await post('/auth/verify-email', { schoolCode: school.shortCode, token: secondToken }).expect(204);
      const me = (await http().get('/api/v1/me').set('Cookie', cookie).expect(200)).body as Me;
      expect(me).toMatchObject({ email: second, hasVerifiedEmail: true });
      const actions = (await db().auditLog.findMany({ where: { schoolId: school.id, subjectId: user.userId }, orderBy: { id: 'asc' } })).map((r) => r.action);
      expect(actions).toEqual(['user.email_changed', 'user.email_changed', 'user.email_verified']);
      const metadata = (await db().auditLog.findMany({ where: { schoolId: school.id, subjectId: user.userId } })).map((r) => JSON.stringify(r.metadata));
      expect(metadata.join()).not.toContain('@');
    });

    it('R98: change-email needs the current password', async () => {
      const user = await createSchoolUser(db(), school, { systemRole: 'teacher', password: 'email-pass-2' }); // pragma: allowlist secret
      const { cookie } = await createSchoolSession(db(), school, user);
      const res = await asUser('/me/change-email', cookie, { currentPassword: 'wrong', email: uniqueEmail() }).expect(409);
      expect(codeOf(res)).toBe('CURRENT_PASSWORD_INCORRECT');
      expect((await userRow(user))?.email).toBeNull();
    });

    it('the same verified address again changes nothing; a different one notifies the old verified address', async () => {
      const user = await verifiedUser('email-pass-3');
      const { cookie } = await createSchoolSession(db(), school, user);
      await asUser('/me/change-email', cookie, { currentPassword: 'email-pass-3', email: user.email }).expect(200); // pragma: allowlist secret
      expect((await userRow(user))?.emailVerifiedAt).not.toBeNull();
      const next = uniqueEmail();
      await asUser('/me/change-email', cookie, { currentPassword: 'email-pass-3', email: next }).expect(200); // pragma: allowlist secret
      expect((await mailer.next(user.email)).subject).toBe('Your account email was changed');
    });

    it('R8: two users of a school may share an email', async () => {
      const shared = uniqueEmail();
      const a = await createSchoolUser(db(), school, { systemRole: 'teacher', password: 'shared-pass-1' }); // pragma: allowlist secret
      const b = await createSchoolUser(db(), school, { systemRole: 'teacher', password: 'shared-pass-1' }); // pragma: allowlist secret
      for (const u of [a, b]) {
        const { cookie } = await createSchoolSession(db(), school, u);
        await asUser('/me/change-email', cookie, { currentPassword: 'shared-pass-1', email: shared }).expect(200); // pragma: allowlist secret
      }
    });

    it('a verify token is refused for a disabled user', async () => {
      const user = await createSchoolUser(db(), school, { systemRole: 'teacher', password: 'email-pass-4' }); // pragma: allowlist secret
      const { cookie } = await createSchoolSession(db(), school, user);
      const email = uniqueEmail();
      await asUser('/me/change-email', cookie, { currentPassword: 'email-pass-4', email }).expect(200); // pragma: allowlist secret
      const token = tokenFrom(await mailer.next(email));
      await db().user.update({ where: { schoolId_id: { schoolId: school.id, id: user.userId } }, data: { status: 'disabled' } });
      await post('/auth/verify-email', { schoolCode: school.shortCode, token }).expect(409);
    });
  });

  describe('change password', () => {
    it('R7: blocked until the email is verified', async () => {
      const user = await createSchoolUser(db(), school, { systemRole: 'teacher', password: 'unverified-pw' }); // pragma: allowlist secret
      const { cookie } = await createSchoolSession(db(), school, user);
      const res = await asUser('/me/change-password', cookie, { currentPassword: 'unverified-pw', newPassword: 'a-new-password' }).expect(409); // pragma: allowlist secret
      expect(codeOf(res)).toBe('EMAIL_NOT_VERIFIED');
    });

    it('R98: needs the current password', async () => {
      const user = await verifiedUser('current-pw-1');
      const { cookie } = await createSchoolSession(db(), school, user);
      const res = await asUser('/me/change-password', cookie, { currentPassword: 'nope', newPassword: 'a-new-password' }).expect(409); // pragma: allowlist secret
      expect(codeOf(res)).toBe('CURRENT_PASSWORD_INCORRECT');
    });

    it('refuses a new password equal to the current one, shorter than 8, or the username', async () => {
      const user = await verifiedUser('current-pw-2');
      const { cookie } = await createSchoolSession(db(), school, user);
      await asUser('/me/change-password', cookie, { currentPassword: 'current-pw-2', newPassword: 'current-pw-2' }).expect(422); // pragma: allowlist secret
      await asUser('/me/change-password', cookie, { currentPassword: 'current-pw-2', newPassword: 'short' }).expect(422); // pragma: allowlist secret
      const res = await asUser('/me/change-password', cookie, { currentPassword: 'current-pw-2', newPassword: user.cnic }).expect(422); // pragma: allowlist secret
      expect((res.body as ErrorBody).error.details?.fields?.[0]?.path).toBe('newPassword');
    });

    it('changes the password, rotates this session, revokes every other one and mails a notice', async () => {
      const user = await verifiedUser('current-pw-3');
      await db().user.update({ where: { schoolId_id: { schoolId: school.id, id: user.userId } }, data: { passwordIsDefault: true } });
      const mine = await createSchoolSession(db(), school, user);
      const other = await createSchoolSession(db(), school, user, { channel: 'bearer' });
      const res = await asUser('/me/change-password', mine.cookie, { currentPassword: 'current-pw-3', newPassword: 'the-new-pass-3' }).expect(200); // pragma: allowlist secret
      expect((res.body as Me).passwordIsDefault).toBe(false);
      const raw = setCookies(res)[0] ?? '';
      const rotated = raw.split(';')[0] ?? '';
      expect(rotated).not.toBe(mine.cookie);
      await http().get('/api/v1/me').set('Cookie', mine.cookie).expect(401);
      await http().get('/api/v1/me').set(other.bearer).expect(401);
      await http().get('/api/v1/me').set('Cookie', rotated).expect(200);
      expect(await liveSessions(user)).toBe(1);
      expect((await mailer.next(user.email)).subject).toBe('Your password was changed');
      const audit = await db().auditLog.findFirst({ where: { schoolId: school.id, subjectId: user.userId, action: 'user.password_changed' } });
      expect(audit).not.toBeNull();
    });

    it('is throttled 5/min per session', async () => {
      const user = await verifiedUser('current-pw-4');
      const { cookie } = await createSchoolSession(db(), school, user);
      for (let i = 0; i < 5; i++) {
        await asUser('/me/change-password', cookie, { currentPassword: 'wrong-current', newPassword: 'whatever-new' }).expect(409); // pragma: allowlist secret
      }
      await asUser('/me/change-password', cookie, { currentPassword: 'wrong-current', newPassword: 'whatever-new' }).expect(429); // pragma: allowlist secret
    });

    it('works in a suspended school', async () => {
      const suspended = await createSchool({ status: 'suspended' });
      const email = uniqueEmail();
      const user = await createSchoolUser(db(), suspended, { systemRole: 'teacher', password: 'suspended-pw', email, emailVerified: true }); // pragma: allowlist secret
      const { cookie } = await createSchoolSession(db(), suspended, user);
      const res = await asUser('/me/change-password', cookie, { currentPassword: 'suspended-pw', newPassword: 'suspended-new' }).expect(200); // pragma: allowlist secret
      const rotated = (setCookies(res)[0] ?? '').split(';')[0] ?? '';
      await asUser('/me/change-email', rotated, { currentPassword: 'wrong', email: uniqueEmail() }).expect(409);
    });
  });
});
