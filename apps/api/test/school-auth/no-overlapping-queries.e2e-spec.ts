// §3.3: no concurrent statements inside one interactive transaction. Prisma loads several
// relations of one select concurrently, which pg reports ("Calling client.query() when the client
// is already executing a query", a hard error in pg@9). This suite drives every slice-2 flow that
// opens a transaction and fails if pg sees the condition it warns about: a query issued while
// another is still queued on the same client. (Node's own 'warning' event does not reach the Jest
// sandbox, so the condition is checked where pg checks it.)
import { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import request from 'supertest';
import { Mailer } from '../../src/modules/auth/mailer';
import { createTestApp } from '../core/app';
import { signedInPlatformAdmin } from '../support/platform';
import { createSchoolSession, createSchoolUser, randomIdentityDigits } from '../support/school-session';
import { closeTestDb, createSchool, testDb } from '../support/schools';
import { createGuardianUser, FakeMailer, nextIp, ORIGIN, sessionCookieOf, tokenFrom, uniqueEmail } from './support';

describe('no overlapping statements in a transaction', () => {
  let app: NestExpressApplication;
  let overlaps = 0;
  const proto: object = Client.prototype;
  const original: unknown = Reflect.get(proto, 'query');
  const mailer = new FakeMailer();
  const db = () => testDb();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    if (typeof original !== 'function') throw new Error('pg Client.query not found');
    Reflect.set(proto, 'query', function (this: object, ...args: unknown[]): unknown {
      const queue: unknown = Reflect.get(this, '_queryQueue');
      if (Array.isArray(queue) && queue.length > 0 && Reflect.get(this, 'pipeline') !== true) overlaps++;
      const result: unknown = Reflect.apply(original, this, args);
      return result;
    });
    app = await createTestApp({ overrides: [{ provide: Mailer, useValue: mailer }] });
  });

  afterAll(async () => {
    Reflect.set(proto, 'query', original);
    await app.close();
    await closeTestDb();
  });

  it('detects overlapping statements in one transaction (the check below is not vacuous)', async () => {
    // A select loading several relations: Prisma issues their queries concurrently.
    const school = await createSchool();
    const user = await createSchoolUser(db(), school, { systemRole: 'teacher' });
    await db().$transaction(async (tx) => {
      await tx.user.findFirst({
        where: { schoolId: school.id, id: user.userId },
        select: {
          id: true,
          staff: { select: { status: true } },
          guardian: { select: { fullName: true } },
          roles: { select: { systemRole: true } },
        },
      });
    });
    expect(overlaps).toBeGreaterThan(0);
    overlaps = 0;
  });

  it('issue-login, login, /me, users, settings and the credential flows run without one', async () => {
    const school = await createSchool();
    await db().schoolSettings.create({ data: { schoolId: school.id, feeDueDay: 10 } });
    const admin = await signedInPlatformAdmin();
    const cnic = randomIdentityDigits();
    const post = (path: string, body: object, cookie?: string) => {
      const req = http().post(`/api/v1${path}`).set('Origin', ORIGIN).set('X-Forwarded-For', nextIp());
      return (cookie ? req.set('Cookie', cookie) : req).send(body);
    };

    // A guardian first, so issue-login links (R22) and the user read joins both people.
    const parent = await createGuardianUser(db(), school);
    await post(`/platform/schools/${school.id}/issue-principal-login`, { fullName: 'Overlap Principal', cnic, phone: '03001234567' }, admin.cookie).expect(201);
    await post(`/platform/schools/${school.id}/issue-principal-login`, { fullName: 'Parent Principal', cnic: parent.cnic, phone: '03001234567', reason: 'Second one', confirmLinkExisting: true }, admin.cookie).expect(201);

    const login = await post('/auth/login', { schoolCode: school.shortCode, username: cnic, password: cnic }).expect(200);
    let cookie = sessionCookieOf(login);
    await http().get('/api/v1/me').set('Cookie', cookie).expect(200);
    await http().get('/api/v1/users?limit=50').set('Cookie', cookie).expect(200);

    const email = uniqueEmail();
    await post('/me/change-email', { currentPassword: cnic, email }, cookie).expect(200);
    await post('/auth/verify-email', { schoolCode: school.shortCode, token: tokenFrom(await mailer.next(email)) }).expect(204);
    const changed = await post('/me/change-password', { currentPassword: cnic, newPassword: 'overlap-new-pass' }, cookie).expect(200); // pragma: allowlist secret
    expect(sessionCookieOf(changed)).not.toBe(cookie);
    await post('/auth/forgot-password', { schoolCode: school.shortCode, username: cnic }).expect(202);
    await mailer.next(email, 2);
    const reset = mailer.to(email).find((m) => m.subject === 'Reset your password');
    if (!reset) throw new Error('no reset mail');
    await post('/auth/reset-password', { schoolCode: school.shortCode, token: tokenFrom(reset), newPassword: 'overlap-reset-pass' }).expect(204); // pragma: allowlist secret
    cookie = sessionCookieOf(await post('/auth/login', { schoolCode: school.shortCode, username: cnic, password: 'overlap-reset-pass' }).expect(200)); // pragma: allowlist secret

    const teacher = await createSchoolUser(db(), school, { systemRole: 'teacher' });
    await http().get(`/api/v1/users/${teacher.userId}`).set('Cookie', cookie).expect(200);
    await post(`/users/${teacher.userId}/reset-password`, { reason: 'Overlap check', clearEmail: false }, cookie).expect(200);
    await post(`/users/${teacher.userId}/disable`, { reason: 'Overlap check' }, cookie).expect(200);
    await post(`/users/${teacher.userId}/enable`, { reason: 'Overlap check' }, cookie).expect(200);
    await http().patch('/api/v1/school/settings').set('Cookie', cookie).set('Origin', ORIGIN).send({ feeDueDay: 11 }).expect(200);
    await createSchoolSession(db(), school, teacher);
    await post('/auth/logout', {}, cookie).expect(204);

    expect(overlaps).toBe(0);
  });
});
