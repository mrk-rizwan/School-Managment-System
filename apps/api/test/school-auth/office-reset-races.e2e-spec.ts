// R99: office reset, disable, change-password and token reset each lock the user row and re-check
// under the lock. Whatever the interleaving with an office reset, the end state is the default
// password, password_is_default = true and zero live sessions. Token reset racing an office reset
// is in token-lock-order.e2e-spec.ts; this file covers change-password and disable.
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { PasswordHasher } from '../../src/common/crypto/password';
import { loadEnv } from '../../src/config/env';
import { Mailer } from '../../src/modules/auth/mailer';
import { createTestApp } from '../core/app';
import { createSchoolSession, createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import { FakeMailer, nextIp, ORIGIN, uniqueEmail } from './support';

const ITERATIONS = 15;

describe('R99: whatever the interleaving with an office reset, the reset wins', () => {
  let app: NestExpressApplication;
  let school: TestSchool;
  let principalCookie: string;
  const hasher = new PasswordHasher(loadEnv());
  const db = () => testDb();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp({ overrides: [{ provide: Mailer, useValue: new FakeMailer() }] });
    school = await createSchool();
    // Targets are teachers, so the last-principal rule (R72) never decides a race here.
    const principal = await createSchoolUser(db(), school, { systemRole: 'principal' });
    principalCookie = (await createSchoolSession(db(), school, principal)).cookie;
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const asPrincipal = (path: string, body: object) =>
    http()
      .post(`/api/v1${path}`)
      .set('Cookie', principalCookie)
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', nextIp())
      .send(body);
  const officeReset = (user: TestSchoolUser) =>
    asPrincipal(`/users/${user.userId}/reset-password`, { reason: 'Forgot it at the desk', clearEmail: false });

  async function expectResetEndState(user: TestSchoolUser) {
    const row = await db().user.findFirst({ where: { schoolId: school.id, id: user.userId } });
    if (!row) throw new Error('no user');
    expect(row.passwordIsDefault).toBe(true);
    expect(await hasher.verify(row.passwordHash, user.cnic)).toBe(true);
    expect(await db().session.count({ where: { schoolId: school.id, userId: user.userId, revokedAt: null } })).toBe(0);
    return row;
  }

  it('R99: change-password racing an office reset ends on the default password with no live session', async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const target = await createSchoolUser(db(), school, {
        systemRole: 'teacher',
        password: 'old-password-1', // pragma: allowlist secret
        email: uniqueEmail(),
        emailVerified: true,
      });
      const own = await createSchoolSession(db(), school, target);
      const [byUser, byOffice] = await Promise.all([
        http()
          .post('/api/v1/me/change-password')
          .set('Cookie', own.cookie)
          .set('Origin', ORIGIN)
          .send({ currentPassword: 'old-password-1', newPassword: 'brand-new-password-1' }), // pragma: allowlist secret
        officeReset(target),
      ]);
      expect(byOffice.status).toBe(200);
      // Either the change landed first (and the reset then overrode it and ended the rotated
      // session) or the reset revoked the session it was waiting behind.
      expect([200, 401]).toContain(byUser.status);
      await expectResetEndState(target);
    }
  });

  it('R99 / R6: disable racing an office reset ends disabled, on the default password, with no live session', async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const target = await createSchoolUser(db(), school, { systemRole: 'teacher', password: 'old-password-2' }); // pragma: allowlist secret
      await createSchoolSession(db(), school, target);
      await createSchoolSession(db(), school, target, { channel: 'bearer' });
      const [disabled, reset] = await Promise.all([
        asPrincipal(`/users/${target.userId}/disable`, { reason: 'Left without notice' }),
        officeReset(target),
      ]);
      expect(disabled.status).toBe(200);
      expect(reset.status).toBe(200);
      const row = await expectResetEndState(target);
      expect(row.status).toBe('disabled');
    }
  });
});
