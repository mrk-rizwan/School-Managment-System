// One lock order for every user write: the user row, then its tokens. Reset-by-token used to
// consume the token row first and then lock the user, while office reset locks the user and then
// voids the tokens; run together they deadlocked (Postgres 40P01, surfaced as a 500).
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { newSessionToken } from '../../src/common/auth/platform-session';
import { Mailer } from '../../src/modules/auth/mailer';
import { createTestApp } from '../core/app';
import { createSchoolSession, createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import { FakeMailer, nextIp, ORIGIN, uniqueEmail } from './support';

const ITERATIONS = 20;

describe('token flows and office reset take locks in one order', () => {
  let app: NestExpressApplication;
  let school: TestSchool;
  let principalCookie: string;
  const db = () => testDb();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp({ overrides: [{ provide: Mailer, useValue: new FakeMailer() }] });
    school = await createSchool();
    const principal = await createSchoolUser(db(), school, { systemRole: 'principal' });
    principalCookie = (await createSchoolSession(db(), school, principal)).cookie;
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  async function issueToken(user: TestSchoolUser, purpose: 'password_reset' | 'email_verify', email: string | null) {
    const { token, tokenHash } = newSessionToken();
    const now = new Date();
    await db().userToken.create({
      data: { schoolId: school.id, userId: user.userId, purpose, tokenHash, email, createdAt: now, expiresAt: new Date(now.getTime() + 15 * 60_000) },
    });
    return token;
  }

  const officeReset = (user: TestSchoolUser) =>
    http()
      .post(`/api/v1/users/${user.userId}/reset-password`)
      .set('Cookie', principalCookie)
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', nextIp())
      .send({ reason: 'Forgot it at the desk', clearEmail: false });

  const publicPost = (path: string, body: object) =>
    http().post(`/api/v1${path}`).set('Origin', ORIGIN).set('X-Forwarded-For', nextIp()).send(body);

  it('reset-by-token racing an office reset: never a 500, and the end state is consistent', async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const target = await createSchoolUser(db(), school, { systemRole: 'teacher', password: 'old-password-1', email: uniqueEmail(), emailVerified: true }); // pragma: allowlist secret
      await createSchoolSession(db(), school, target);
      const token = await issueToken(target, 'password_reset', null);
      const [byToken, byOffice] = await Promise.all([
        publicPost('/auth/reset-password', { schoolCode: school.shortCode, token, newPassword: 'new-password-1' }), // pragma: allowlist secret
        officeReset(target),
      ]);
      expect(byOffice.status).toBe(200);
      expect([204, 409]).toContain(byToken.status);
      const row = await db().user.findFirst({ where: { schoolId: school.id, id: target.userId } });
      // The office reset always lands, whichever ran first.
      expect(row?.passwordIsDefault).toBe(true);
      expect(row?.officeResetAt).not.toBeNull();
      expect(await db().session.count({ where: { schoolId: school.id, userId: target.userId, revokedAt: null } })).toBe(0);
      const tokenRow = await db().userToken.findFirst({ where: { schoolId: school.id, userId: target.userId } });
      // Consumed exactly when the token reset succeeded, and audited then only.
      expect(tokenRow?.usedAt !== null).toBe(byToken.status === 204);
      const audited = await db().auditLog.count({
        where: { schoolId: school.id, subjectId: target.userId, action: 'user.password_reset_by_token' },
      });
      expect(audited).toBe(byToken.status === 204 ? 1 : 0);
    }
  });

  it('verify-email racing an office reset: never a 500', async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const email = uniqueEmail();
      const target = await createSchoolUser(db(), school, { systemRole: 'teacher', password: 'old-password-1', email }); // pragma: allowlist secret
      const token = await issueToken(target, 'email_verify', email);
      const [byToken, byOffice] = await Promise.all([
        publicPost('/auth/verify-email', { schoolCode: school.shortCode, token }),
        officeReset(target),
      ]);
      expect(byOffice.status).toBe(200);
      expect([204, 409]).toContain(byToken.status);
      const row = await db().user.findFirst({ where: { schoolId: school.id, id: target.userId } });
      expect(row?.emailVerifiedAt !== null).toBe(byToken.status === 204);
    }
  });
});
