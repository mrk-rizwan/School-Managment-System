// A request whose session is revoked while it waits for the user-row lock must not finish its
// write (wave-A security re-check: a planted session racing issue-principal-login could still set
// its own email on the new principal account).
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from '../core/app';
import { createSchoolSession, createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb } from '../support/schools';
import { ORIGIN, pause, uniqueEmail } from './support';

const PASSWORD = 'a-known-test-password'; // pragma: allowlist secret

describe('session revoked while a locked write waits', () => {
  let app: NestExpressApplication;
  const db = () => testDb();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it.each([
    ['change-email', (password: string) => ({ currentPassword: password, email: uniqueEmail() })],
    [
      'change-password',
      (password: string) => ({ currentPassword: password, newPassword: 'another-test-password' }), // pragma: allowlist secret
    ],
  ])('%s: 401 and nothing written when the session is revoked under the lock', async (path, body) => {
    const school = await createSchool();
    const user = await createSchoolUser(db(), school, {
      systemRole: 'office_staff',
      password: PASSWORD,
      email: uniqueEmail(),
      emailVerified: true,
    });
    const session = await createSchoolSession(db(), school, user);
    const before = await db().user.findFirst({ where: { schoolId: school.id, id: user.userId } });
    if (!before) throw new Error('no user');

    // Another transaction (standing in for issue-principal-login or an office reset) holds the
    // user row and revokes the session; the request reads its session, then waits on the lock.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked = () => {};
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const other = db().$transaction(
      async (tx) => {
        await tx.user.updateMany({ where: { schoolId: school.id, id: user.userId }, data: { updatedAt: new Date() } });
        await tx.session.updateMany({
          where: { schoolId: school.id, id: session.sessionId },
          data: { revokedAt: new Date() },
        });
        locked();
        await held;
      },
      { timeout: 10_000 },
    );
    await isLocked;
    let settled = false;
    const sent = http()
      .post(`/api/v1/me/${path}`)
      .set('Cookie', session.cookie)
      .set('Origin', ORIGIN)
      .send(body(PASSWORD))
      .then((res) => {
        settled = true;
        return res;
      });
    await pause(500);
    expect(settled).toBe(false);
    release();
    await other;
    const res = await sent;
    expect(res.status).toBe(401);
    const after = await db().user.findFirst({ where: { schoolId: school.id, id: user.userId } });
    expect(after?.email).toBe(before.email);
    expect(after?.passwordHash).toBe(before.passwordHash);
  });
});
