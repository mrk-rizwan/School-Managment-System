// Platform admin authentication end to end (contracts/slice-1.md §1-§3, §6, §7; R56, R65, R102).
import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import request from 'supertest';
import { PLATFORM_COOKIE, sha256Hex } from '../../src/common/auth/platform-session';
import { PlatformAdminSeeder } from '../../src/modules/platform/auth/platform-admin.seeder';
import { createTestApp } from '../core/app';
import { createPlatformSession } from '../support/platform';
import { closeTestDb, testDb } from '../support/schools';
import {
  backdateSession,
  Client,
  cookieOf,
  enrolledSession,
  enrolmentSession,
  readySession,
  seedAdmin,
  tokenFrom,
  totpCode,
  TestPlatformModule,
  userIdOf,
  type Admin,
} from './support';

interface ErrorBody {
  error: { code: string; message: string; details: { fields?: { path: string; code: string }[] } | null };
}
const errorOf = (res: { body: unknown }) => (res.body as ErrorBody).error;

interface Me {
  id: string;
  email: string;
  sessionStage: string;
  totpEnrolled: boolean;
  mustChangePassword: boolean;
  sessionExpiresAt: string;
}

let app: NestExpressApplication;

beforeAll(async () => {
  app = await createTestApp({ imports: [TestPlatformModule] });
});

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

const auditRows = async (email: string, action: string) =>
  testDb().platformAuditLog.findMany({
    where: { actorPlatformUserId: await userIdOf(email), action },
  });

describe('first sign-in: login (password only) -> enrol -> confirm -> change password', () => {
  let admin: Admin;
  let client: Client;

  beforeEach(async () => {
    admin = await seedAdmin(app);
    client = new Client(app);
  });

  it('login without TOTP mints an enrolment-stage session in a strict host-only cookie', async () => {
    const res = await client
      .login({ email: `  ${admin.email.toUpperCase()} `, password: admin.password })
      .expect(200);
    const me = res.body as Me;
    expect(me).toEqual({
      id: expect.any(String),
      email: admin.email,
      sessionStage: 'totp_enrolment',
      totpEnrolled: false,
      mustChangePassword: true,
      sessionExpiresAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
    });
    // Enrolment sessions live 10 minutes, absolute.
    const lifetime = Date.parse(me.sessionExpiresAt) - Date.now();
    expect(lifetime).toBeGreaterThan(9 * 60_000);
    expect(lifetime).toBeLessThanOrEqual(10 * 60_000);

    expect(res.headers['set-cookie']).toHaveLength(1);
    expect(res.headers['set-cookie']?.[0]).toMatch(
      new RegExp(`^${PLATFORM_COOKIE}=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Strict; Path=/$`),
    );
    // The token is only in the cookie; the database keeps only its SHA-256.
    const token = tokenFrom(res)!;
    expect(JSON.stringify(res.body)).not.toContain(token);
    const stored = await testDb().platformSession.findMany({
      where: { platformUserId: BigInt(me.id) },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]!.tokenHash).not.toBe(token);

    const audit = await auditRows(admin.email, 'platform_user.login');
    expect(audit.map((row) => row.metadata)).toEqual([{ stage: 'totp_enrolment' }]);
  });

  it('an enrolment-stage session reaches only me, logout, enrol and confirm (others 403 TOTP_REQUIRED)', async () => {
    const token = await enrolmentSession(client, admin);
    await client.get('/me', token).expect(200);
    const full = await client.get('/test-only/full', token).expect(403);
    expect(errorOf(full).code).toBe('TOTP_REQUIRED');
    const change = await client
      .post('/auth/change-password', token, {
        currentPassword: admin.password,
        newPassword: `${admin.password}-new`,
      })
      .expect(403);
    expect(errorOf(change).code).toBe('TOTP_REQUIRED');
    await client.post('/auth/logout', token).expect(204);
  });

  it('enrol returns the otpauth URI and base32 secret once and stores only ciphertext', async () => {
    const token = await enrolmentSession(client, admin);
    const res = await client.post('/auth/totp/enrol', token).expect(200);
    const { otpauthUri, secret } = res.body as { otpauthUri: string; secret: string };
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUri).toBe(
      `otpauth://totp/ASMS%20Platform:${encodeURIComponent(admin.email)}?secret=${secret}` +
        '&issuer=ASMS%20Platform&algorithm=SHA1&digits=6&period=30',
    );
    const user = await testDb().platformUser.findUnique({ where: { email: admin.email } });
    expect(user!.totpSecret).toMatch(/^v1:/);
    expect(user!.totpSecret).not.toContain(secret);
    expect(user!.totpEnrolledAt).toBeNull();

    // Calling again replaces the pending secret.
    const again = await client.post('/auth/totp/enrol', token).expect(200);
    expect((again.body as { secret: string }).secret).not.toBe(secret);
  });

  it('confirm before enrol is 409 TOTP_NOT_ENROLLED; a wrong code is 409 TOTP_INVALID', async () => {
    const token = await enrolmentSession(client, admin);
    const early = await client.post('/auth/totp/confirm', token, { code: '123456' }).expect(409);
    expect(errorOf(early).code).toBe('TOTP_NOT_ENROLLED');

    const { secret } = (await client.post('/auth/totp/enrol', token).expect(200)).body as {
      secret: string;
    };
    const right = await totpCode(secret);
    const wrong = right === '000000' ? '000001' : '000000';
    const bad = await client.post('/auth/totp/confirm', token, { code: wrong }).expect(409);
    expect(errorOf(bad).code).toBe('TOTP_INVALID');
    const malformed = await client.post('/auth/totp/confirm', token, { code: '12345' }).expect(422);
    expect(errorOf(malformed).details?.fields?.[0]?.path).toBe('code');
  });

  it('confirm enrols, rotates the token to a full session and audits; enrol again is 409', async () => {
    const enrolment = await enrolmentSession(client, admin);
    const { secret } = (await client.post('/auth/totp/enrol', enrolment).expect(200)).body as {
      secret: string;
    };
    const res = await client
      .post('/auth/totp/confirm', enrolment, { code: await totpCode(secret) })
      .expect(200);
    expect(res.body).toMatchObject({ sessionStage: 'full', totpEnrolled: true, mustChangePassword: true });
    const full = tokenFrom(res)!;
    expect(full).not.toBe(enrolment);
    // The enrolment session is revoked (fixation defence).
    await client.get('/me', enrolment).expect(401);
    await client.get('/me', full).expect(200);

    const again = await client.post('/auth/totp/enrol', full).expect(409);
    expect(errorOf(again).code).toBe('TOTP_ALREADY_ENROLLED');
    const confirmAgain = await client
      .post('/auth/totp/confirm', full, { code: await totpCode(secret, 1) })
      .expect(409);
    expect(errorOf(confirmAgain).code).toBe('TOTP_ALREADY_ENROLLED');
    expect(await auditRows(admin.email, 'platform_user.totp_enrolled')).toHaveLength(1);
  });

  it('R102: the seeded admin must change its password before any full-level route', async () => {
    const { token } = await enrolledSession(client, admin);
    const me = await client.get('/me', token).expect(200);
    expect(me.body).toMatchObject({ mustChangePassword: true, sessionStage: 'full' });
    const gated = await client.get('/test-only/full', token).expect(403);
    expect(errorOf(gated).code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('change-password: wrong current is 409, same or short new is 422', async () => {
    const { token } = await enrolledSession(client, admin);
    const wrong = await client
      .post('/auth/change-password', token, {
        currentPassword: `${admin.password}x`,
        newPassword: 'a-brand-new-password', // pragma: allowlist secret
      })
      .expect(409);
    expect(errorOf(wrong).code).toBe('CURRENT_PASSWORD_INCORRECT');

    const same = await client
      .post('/auth/change-password', token, {
        currentPassword: admin.password,
        newPassword: admin.password,
      })
      .expect(422);
    expect(errorOf(same).details?.fields).toEqual([
      expect.objectContaining({ path: 'newPassword', code: 'INVALID_VALUE' }),
    ]);
    const short = await client
      .post('/auth/change-password', token, { currentPassword: admin.password, newPassword: 'short-11ch' }) // pragma: allowlist secret
      .expect(422);
    expect(errorOf(short).details?.fields?.[0]?.path).toBe('newPassword');
    // Nothing changed: the session still works.
    await client.get('/me', token).expect(200);
  });

  it('change-password rotates the token, revokes every other session, clears the gate and audits', async () => {
    const { token, secret } = await enrolledSession(client, admin);
    // A second session of the same user, from another login.
    const other = tokenFrom(
      await new Client(app)
        .login({ email: admin.email, password: admin.password, totpCode: await totpCode(secret) })
        .expect(200),
    )!;
    const oldPassword = admin.password;
    const newPassword = `${oldPassword}-new`;
    const res = await client
      .post('/auth/change-password', token, { currentPassword: oldPassword, newPassword })
      .expect(200);
    expect(res.body).toMatchObject({ sessionStage: 'full', mustChangePassword: false });
    const rotated = tokenFrom(res)!;
    expect(rotated).not.toBe(token);
    await client.get('/me', token).expect(401);
    await client.get('/me', other).expect(401);
    await client.get('/test-only/full', rotated).expect(200);

    const user = await testDb().platformUser.findUnique({ where: { email: admin.email } });
    expect(user!.passwordChangedAt).not.toBeNull();
    expect(await auditRows(admin.email, 'platform_user.password_changed')).toHaveLength(1);

    const fresh = new Client(app);
    await fresh
      .login({ email: admin.email, password: oldPassword, totpCode: await totpCode(secret, 1) })
      .expect(401);
    await fresh
      .login({ email: admin.email, password: newPassword, totpCode: await totpCode(secret, 1) })
      .expect(200);
  });

  it('change-password never extends the sign-in: the new session keeps the absolute expiry', async () => {
    const { token } = await enrolledSession(client, admin);
    // As if signed in an hour ago: a fresh 12 hours from now would be an hour later.
    await backdateSession(token, 3600_000);
    const before = (await client.get('/me', token).expect(200)).body as Me;
    const res = await client
      .post('/auth/change-password', token, {
        currentPassword: admin.password,
        newPassword: `${admin.password}-new`,
      })
      .expect(200);
    expect((res.body as Me).sessionExpiresAt).toBe(before.sessionExpiresAt);
    const rotated = tokenFrom(res)!;
    expect(((await client.get('/me', rotated).expect(200)).body as Me).sessionExpiresAt).toBe(
      before.sessionExpiresAt,
    );
    const row = await testDb().platformSession.findUnique({ where: { tokenHash: sha256Hex(rotated) } });
    expect(row!.expiresAt.toISOString()).toBe(before.sessionExpiresAt);
  });

  it('wrong current passwords count toward the login lockout (a stolen cookie cannot guess freely)', async () => {
    const { token, secret } = await enrolledSession(client, admin);
    for (let i = 0; i < 5; i++) {
      const res = await client
        .post('/auth/change-password', token, {
          currentPassword: `wrong-guess-${i}-password`,
          newPassword: 'a-brand-new-password', // pragma: allowlist secret
        })
        .expect(409);
      expect(errorOf(res).code).toBe('CURRENT_PASSWORD_INCORRECT');
    }
    // The email is now locked: the right password and a fresh code are refused.
    const locked = await new Client(app)
      .login({ email: admin.email, password: admin.password, totpCode: await totpCode(secret) })
      .expect(401);
    expect(errorOf(locked).code).toBe('AUTH_FAILED');
    // And change-password from another session refuses even the right current password.
    const other = await createPlatformSession(await userIdOf(admin.email));
    const refused = await new Client(app)
      .post('/auth/change-password', other.token, {
        currentPassword: admin.password,
        newPassword: 'a-brand-new-password', // pragma: allowlist secret
      })
      .expect(409);
    expect(errorOf(refused).code).toBe('CURRENT_PASSWORD_INCORRECT');
  });
});

describe('one-step login once enrolled', () => {
  it('requires the code; a correct code gives a full session; a replayed code is refused', async () => {
    const admin = await seedAdmin(app);
    const client = new Client(app);
    const { secret } = await readySession(client, admin);

    const noCode = await client.login({ email: admin.email, password: admin.password }).expect(401);
    expect(errorOf(noCode).code).toBe('AUTH_FAILED');

    const code = await totpCode(secret);
    const ok = await client
      .login({ email: admin.email, password: admin.password, totpCode: code })
      .expect(200);
    expect(ok.body).toMatchObject({ sessionStage: 'full', totpEnrolled: true, mustChangePassword: false });
    const lifetime = Date.parse((ok.body as Me).sessionExpiresAt) - Date.now();
    expect(lifetime).toBeGreaterThan(11.9 * 3600_000);
    expect(lifetime).toBeLessThanOrEqual(12 * 3600_000);

    const replay = await new Client(app)
      .login({ email: admin.email, password: admin.password, totpCode: code })
      .expect(401);
    expect(errorOf(replay).code).toBe('AUTH_FAILED');
  });

  it('two simultaneous logins with the same code: exactly one succeeds', async () => {
    const admin = await seedAdmin(app);
    const { secret } = await readySession(new Client(app), admin);
    const code = await totpCode(secret);
    const body = { email: admin.email, password: admin.password, totpCode: code };
    const results = await Promise.all([new Client(app).login(body), new Client(app).login(body)]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 401]);
  });

  it('a TOTP secret copied onto another user row does not work there (AAD binds the row)', async () => {
    const a = await seedAdmin(app);
    const { secret: secretA } = await readySession(new Client(app), a);
    const b = await seedAdmin(app);
    await readySession(new Client(app), b);
    const rowA = await testDb().platformUser.findUniqueOrThrow({ where: { email: a.email } });
    await testDb().platformUser.update({
      where: { email: b.email },
      data: { totpSecret: rowA.totpSecret, totpLastStep: null },
    });
    await new Client(app)
      .login({ email: b.email, password: b.password, totpCode: await totpCode(secretA) })
      .expect(401);
  });

  it('login revokes the session presented with it', async () => {
    const admin = await seedAdmin(app);
    const client = new Client(app);
    const first = await enrolmentSession(client, admin);
    const second = tokenFrom(
      await client
        .login({ email: admin.email, password: admin.password }, { cookie: cookieOf(first) })
        .expect(200),
    )!;
    await client.get('/me', first).expect(401);
    await client.get('/me', second).expect(200);
  });
});

describe('every login failure is the same 401 AUTH_FAILED', () => {
  it('wrong password, unknown email, wrong code and a disabled account are indistinguishable', async () => {
    const admin = await seedAdmin(app);
    const { secret } = await readySession(new Client(app), admin);
    const disabled = await seedAdmin(app);
    await testDb().platformUser.update({
      where: { email: disabled.email },
      data: { status: 'disabled' },
    });
    const wrongCode = (await totpCode(secret)) === '000000' ? '000001' : '000000';

    const attempts = [
      { email: admin.email, password: `${admin.password}x`, totpCode: await totpCode(secret) },
      { email: `nobody-${randomBytes(4).toString('hex')}@test.invalid`, password: 'whatever-it-is' }, // pragma: allowlist secret
      { email: admin.email, password: admin.password, totpCode: wrongCode },
      { email: disabled.email, password: disabled.password },
    ];
    const bodies = [];
    for (const body of attempts) {
      const res = await new Client(app).login(body).expect(401);
      expect(res.headers['set-cookie']).toBeUndefined();
      const { code, message, details } = errorOf(res);
      bodies.push({ code, message, details });
    }
    expect(bodies).toEqual(
      attempts.map(() => ({
        code: 'AUTH_FAILED',
        message: 'Email, password or code is incorrect.',
        details: null,
      })),
    );
  });

  it('a disabled user loses an existing session immediately', async () => {
    const admin = await seedAdmin(app);
    const client = new Client(app);
    const token = await enrolmentSession(client, admin);
    await testDb().platformUser.update({ where: { email: admin.email }, data: { status: 'disabled' } });
    await client.get('/me', token).expect(401);
  });
});

describe('throttling and lockout', () => {
  it('locks an email after 5 failures: correct credentials then fail too, other emails do not', async () => {
    const admin = await seedAdmin(app);
    for (let i = 0; i < 5; i++) {
      // A new IP each time, so the per-email+IP limit (5/min) is not what stops it.
      await new Client(app).login({ email: admin.email, password: 'wrong-password' }).expect(401); // pragma: allowlist secret
    }
    const locked = await new Client(app)
      .login({ email: admin.email, password: admin.password })
      .expect(401);
    expect(errorOf(locked).code).toBe('AUTH_FAILED');

    const other = await seedAdmin(app);
    await new Client(app).login({ email: other.email, password: other.password }).expect(200);
  });

  it('a success resets the failure count', async () => {
    const admin = await seedAdmin(app);
    for (let i = 0; i < 4; i++) {
      await new Client(app).login({ email: admin.email, password: 'wrong-password' }).expect(401); // pragma: allowlist secret
    }
    await new Client(app).login({ email: admin.email, password: admin.password }).expect(200);
    for (let i = 0; i < 4; i++) {
      await new Client(app).login({ email: admin.email, password: 'wrong-password' }).expect(401); // pragma: allowlist secret
    }
    await new Client(app).login({ email: admin.email, password: admin.password }).expect(200);
  });

  it('the 6th attempt in a minute from one email+IP is 429 RATE_LIMITED with Retry-After', async () => {
    const client = new Client(app);
    const email = `nobody-${randomBytes(4).toString('hex')}@test.invalid`;
    for (let i = 0; i < 5; i++) {
      await client.login({ email, password: 'wrong-password' }).expect(401); // pragma: allowlist secret
    }
    const limited = await client.login({ email, password: 'wrong-password' }).expect(429); // pragma: allowlist secret
    expect(errorOf(limited).code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('TOTP confirm is limited to 5 per minute per session', async () => {
    const admin = await seedAdmin(app);
    const client = new Client(app);
    const token = await enrolmentSession(client, admin);
    await client.post('/auth/totp/enrol', token).expect(200);
    for (let i = 0; i < 5; i++) {
      await client.post('/auth/totp/confirm', token, { code: '000000' });
    }
    const limited = await client.post('/auth/totp/confirm', token, { code: '000000' }).expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('Origin check (R65): every non-GET under /platform, login included', () => {
  it('refuses login with no Origin or a foreign one', async () => {
    const admin = await seedAdmin(app);
    const client = new Client(app);
    for (const origin of [null, 'https://evil.example', 'http://localhost:3000.evil.example']) {
      const res = await client.login({ email: admin.email, password: admin.password }, { origin }).expect(403);
      expect(errorOf(res).code).toBe('ORIGIN_REJECTED');
    }
    // Express matches routes case-insensitively; the check must too.
    const res = await request(app.getHttpServer())
      .post('/api/v1/PLATFORM/auth/login')
      .set('X-Forwarded-For', client.ip)
      .send({ email: admin.email, password: admin.password })
      .expect(403);
    expect(errorOf(res).code).toBe('ORIGIN_REJECTED');
  });

  it('refuses logout from a foreign Origin; GET needs none', async () => {
    const admin = await seedAdmin(app);
    const client = new Client(app);
    const token = await enrolmentSession(client, admin);
    await client.get('/me', token).expect(200);
    const res = await client.post('/auth/logout', token, undefined, 'https://evil.example').expect(403);
    expect(errorOf(res).code).toBe('ORIGIN_REJECTED');
    await client.get('/me', token).expect(200);
  });
});

describe('session resolution (R56: only the platform cookie, only platform_sessions)', () => {
  it('refuses a bearer header even alongside a valid cookie, and a missing or school cookie', async () => {
    const admin = await seedAdmin(app);
    const client = new Client(app);
    const token = await enrolmentSession(client, admin);
    const http = request(app.getHttpServer());

    const withBearer = await http
      .get('/api/v1/platform/me')
      .set('Cookie', cookieOf(token))
      .set('Authorization', `Bearer ${token}`)
      // The app-version floor (R161) checks every bearer request first; with a current version
      // the request reaches platform resolution, which refuses the bearer.
      .set('X-App-Version', '1.0.0')
      .expect(401);
    expect(errorOf(withBearer).code).toBe('AUTH_REQUIRED');
    await http
      .get('/api/v1/platform/me')
      .set({ Authorization: `Bearer ${token}`, 'X-App-Version': '1.0.0' })
      .expect(401);
    await http.get('/api/v1/platform/me').expect(401);
    // The platform token in the school cookie is not read.
    await http.get('/api/v1/platform/me').set('Cookie', `__Host-asms_session=${token}`).expect(401);
    // A token that is not a platform session (as a school session token would be).
    const foreign = randomBytes(32).toString('base64url');
    await http.get('/api/v1/platform/me').set('Cookie', cookieOf(foreign)).expect(401);
    // The cookie sent twice is ambiguous and refused.
    await http
      .get('/api/v1/platform/me')
      .set('Cookie', `${cookieOf(foreign)}; ${cookieOf(token)}`)
      .expect(401);
    await http.get('/api/v1/platform/me').set('Cookie', cookieOf(token)).expect(200);
  });

  it('logout revokes the session and clears the cookie; a second logout is 401', async () => {
    const admin = await seedAdmin(app);
    const client = new Client(app);
    const token = await enrolmentSession(client, admin);
    const res = await client.post('/auth/logout', token).expect(204);
    expect(res.headers['set-cookie']).toEqual([
      `${PLATFORM_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
    ]);
    await client.get('/me', token).expect(401);
    await client.post('/auth/logout', token).expect(401);
  });

  const ageSession = async (token: string, data: { createdAt?: Date; lastSeenAt?: Date; expiresAt?: Date }) => {
    const tokenHash = sha256Hex(token);
    await testDb().platformSession.update({ where: { tokenHash }, data });
    return tokenHash;
  };

  it('refuses a session past its absolute expiry', async () => {
    const admin = await seedAdmin(app);
    const client = new Client(app);
    const { token } = await readySession(client, admin);
    const hour = 3600_000;
    await ageSession(token, {
      createdAt: new Date(Date.now() - 13 * hour),
      lastSeenAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() - hour),
    });
    await client.get('/me', token).expect(401);
  });

  it('an enrolment-stage session ends 10 minutes after login, however recently used', async () => {
    const admin = await seedAdmin(app);
    const client = new Client(app);
    const token = await enrolmentSession(client, admin);
    await backdateSession(token, 9 * 60_000);
    await client.get('/me', token).expect(200);
    // Just past 10 minutes since login; it was last used a moment ago.
    await backdateSession(token, 61_000);
    await client.get('/me', token).expect(401);
  });

  it('refuses a full session idle for 2 hours', async () => {
    const admin = await seedAdmin(app);
    const client = new Client(app);
    const { token } = await readySession(client, admin);
    await ageSession(token, { lastSeenAt: new Date(Date.now() - 2 * 3600_000 - 1000) });
    await client.get('/me', token).expect(401);
  });

  it('writes last_seen_at only when it is more than 5 minutes old', async () => {
    const admin = await seedAdmin(app);
    const client = new Client(app);
    const { token } = await readySession(client, admin);
    const recent = new Date(Date.now() - 60_000);
    const tokenHash = await ageSession(token, { lastSeenAt: recent });
    await client.get('/me', token).expect(200);
    let row = await testDb().platformSession.findUnique({ where: { tokenHash } });
    expect(row!.lastSeenAt.getTime()).toBe(recent.getTime());

    await ageSession(token, { lastSeenAt: new Date(Date.now() - 6 * 60_000) });
    await client.get('/me', token).expect(200);
    row = await testDb().platformSession.findUnique({ where: { tokenHash } });
    expect(Date.now() - row!.lastSeenAt.getTime()).toBeLessThan(60_000);
  });
});

describe('seed (contract §7)', () => {
  it('creates once, then reports exists and never resets the password, TOTP or status', async () => {
    const seeder = app.get(PlatformAdminSeeder);
    const email = `seed-${randomBytes(6).toString('hex')}@test.invalid`;
    await expect(seeder.seed(`  ${email.toUpperCase()}  `, 'first-password-1')).resolves.toBe('created');
    const before = await testDb().platformUser.findUnique({ where: { email } });
    expect(before).toMatchObject({ mustChangePassword: true, status: 'active', totpSecret: null });
    expect(before!.passwordHash).toMatch(/^\$argon2id\$/);

    await testDb().platformUser.update({ where: { email }, data: { status: 'disabled' } });
    await expect(seeder.seed(email, 'second-password-2')).resolves.toBe('exists');
    const after = await testDb().platformUser.findUnique({ where: { email } });
    expect(after!.passwordHash).toBe(before!.passwordHash);
    expect(after!.status).toBe('disabled');

    const seeded = await testDb().platformAuditLog.findMany({
      where: { subjectType: 'platform_user', subjectId: before!.id, action: 'platform_user.seeded' },
    });
    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toMatchObject({ actorPlatformUserId: null, schoolId: null, metadata: {} });
  });
});

describe('lockout storage (Redis) failures', () => {
  type Call = (...args: unknown[]) => Promise<unknown>;

  /** Makes one of the lockout's own Redis commands reject; every other command (the throttle's) still runs. */
  const failCommand = (failing: string) => {
    const redis = app.get(ThrottlerStorageRedisService).redis;
    const call = redis.call.bind(redis) as Call;
    const fake: Call = (command, ...args) =>
      command === failing ? Promise.reject(new Error('Redis unreachable')) : call(command, ...args);
    return jest.spyOn(redis, 'call').mockImplementation(fake);
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('the lockout check failing is 503 SERVICE_UNAVAILABLE, not 500, and mints no session', async () => {
    const admin = await seedAdmin(app);
    const spy = failCommand('EXISTS');
    const res = await new Client(app).login({ email: admin.email, password: admin.password });
    expect(spy).toHaveBeenCalledWith('EXISTS', expect.any(String));
    expect(res.status).toBe(503);
    expect(errorOf(res).code).toBe('SERVICE_UNAVAILABLE');
    expect(res.headers['set-cookie']).toBeUndefined();
    const sessions = await testDb().platformSession.count({
      where: { platformUserId: await userIdOf(admin.email) },
    });
    expect(sessions).toBe(0);
  });

  it('the counter reset failing after a committed login still returns the session', async () => {
    const admin = await seedAdmin(app);
    const spy = failCommand('DEL');
    const client = new Client(app);
    const res = await client.login({ email: admin.email, password: admin.password });
    expect(spy).toHaveBeenCalledWith('DEL', expect.any(String));
    expect(res.status).toBe(200);
    jest.restoreAllMocks();
    await client.get('/me', tokenFrom(res)).expect(200);
  });
});

describe('with Redis unreachable', () => {
  let down: NestExpressApplication;

  beforeAll(async () => {
    const failingStorage = {
      increment: () => Promise.reject(new Error('Redis unreachable')),
      onModuleDestroy: () => undefined,
    };
    down = await createTestApp({
      overrides: [{ provide: ThrottlerStorageRedisService, useValue: failingStorage }],
    });
  });

  afterAll(async () => {
    await down.close();
  });

  it('login is 503 when the throttle counters cannot be reached, never evaluated without them', async () => {
    const res = await request(down.getHttpServer())
      .post('/api/v1/platform/auth/login')
      .set('Origin', new URL(process.env.APP_URL ?? 'http://localhost:3000').origin)
      .send({ email: 'anyone@test.invalid', password: 'whatever-password' }); // pragma: allowlist secret
    expect(res.status).toBe(503);
    expect(errorOf(res).code).toBe('SERVICE_UNAVAILABLE');
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});
