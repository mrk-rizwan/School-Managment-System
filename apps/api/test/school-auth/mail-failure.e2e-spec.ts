// R92 end to end: with the SMTP server failing every attempt, the credential flows answer exactly
// as they do when mail works, their state is committed, and the failure is logged once per
// message without the address, the token or identity digits.
import { createServer, type AddressInfo, type Server } from 'node:net';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { loadEnv } from '../../src/config/env';
import { Mailer } from '../../src/modules/auth/mailer';
import { createTestApp } from '../core/app';
import { createSchoolSession, createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import { nextIp, ORIGIN, pause, uniqueEmail } from './support';

describe('mail failure never alters a response or committed state (R92)', () => {
  let app: NestExpressApplication;
  let school: TestSchool;
  let server: Server;
  let mailer: Mailer;
  let connections = 0;
  const logs: string[] = [];
  const db = () => testDb();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    mailer = new Mailer({ ...loadEnv(), SMTP_HOST: '127.0.0.1', SMTP_PORT: port });
    app = await createTestApp({
      overrides: [{ provide: Mailer, useValue: mailer }],
      logStream: { write: (line: string) => void logs.push(line) },
    });
    school = await createSchool();
  });

  afterAll(async () => {
    await app.close();
    mailer.onModuleDestroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb();
  });

  /**
   * Waits until `messages` sends have each given up (3 attempts, 2.5 s of backoff, then one log
   * line) and every attempt has reached the server. Polls the condition itself, not a fixed number
   * of ticks, so a cold start (slow first connection, slow logger) only makes it wait longer; it
   * gives up just inside the test's own timeout so a real failure still reports its assertion.
   */
  async function settled(messages: number, since: number, deadlineMs = 25_000) {
    const done = () =>
      logs.filter((l) => l.includes('mail not sent')).length >= messages &&
      connections - since >= messages * 3;
    const deadline = Date.now() + deadlineMs;
    while (!done() && Date.now() < deadline) await pause(50);
  }

  it('R92: change-email answers 200 and commits the address and its token; forgot-password answers 202 {} and commits its token', async () => {
    const before = connections;
    const user = await createSchoolUser(db(), school, { systemRole: 'teacher', password: 'mail-fail-pw-1' }); // pragma: allowlist secret
    const { cookie } = await createSchoolSession(db(), school, user);
    const email = uniqueEmail();

    const changed = await http()
      .post('/api/v1/me/change-email')
      .set('Origin', ORIGIN)
      .set('Cookie', cookie)
      .send({ currentPassword: 'mail-fail-pw-1', email }); // pragma: allowlist secret
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ email, hasVerifiedEmail: false });
    const row = await db().user.findFirst({ where: { schoolId: school.id, id: user.userId } });
    expect(row?.email).toBe(email);
    expect(
      await db().userToken.count({ where: { schoolId: school.id, userId: user.userId, purpose: 'email_verify', usedAt: null } }),
    ).toBe(1);
    expect(
      await db().auditLog.count({ where: { schoolId: school.id, subjectId: user.userId, action: 'user.email_changed' } }),
    ).toBe(1);

    // A verified, active account, so forgot-password really does try to mail it.
    await db().user.update({
      where: { schoolId_id: { schoolId: school.id, id: user.userId } },
      data: { emailVerifiedAt: new Date() },
    });
    const forgot = await http()
      .post('/api/v1/auth/forgot-password')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', nextIp())
      .send({ schoolCode: school.shortCode, username: user.cnic });
    expect(forgot.status).toBe(202);
    expect(forgot.body).toEqual({});
    await settled(2, before);
    // forgot-password does its work after the 202 (R2); by the time its mail has failed, the
    // token it issued is committed.
    expect(
      await db().userToken.count({ where: { schoolId: school.id, userId: user.userId, purpose: 'password_reset', usedAt: null } }),
    ).toBe(1);
    // Two messages, three attempts each, then one log line each.
    expect(connections - before).toBe(6);
    const failures = logs.filter((l) => l.includes('mail not sent'));
    expect(failures).toHaveLength(2);
    const all = logs.join('\n');
    expect(all).not.toContain(email);
    expect(all).not.toContain(user.cnic);
    expect(all).not.toMatch(/token=|[0-9]{13}|[0-9]{5}-[0-9]{7}-[0-9]/);
  }, 30_000);
});
