// Helpers for the platform-auth e2e tests. Each test seeds its own admin with a unique email and
// sends from its own random client IP (X-Forwarded-For; the API trusts one hop), so tests never
// share a throttle or lockout counter, and nothing is truncated.
import { randomBytes, randomInt } from 'node:crypto';
import { Controller, Get, Module, Query } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { generate } from 'otplib';
import request from 'supertest';
import { PLATFORM_COOKIE, sha256Hex } from '../../src/common/auth/platform-session';
import { PlatformSession } from '../../src/common/auth/route-access';
import { ApiErrors } from '../../src/common/openapi';
import { NoQueryDto } from '../../src/common/validation';
import { PlatformAdminSeeder } from '../../src/modules/platform/auth/platform-admin.seeder';
import { testDb } from '../support/schools';

export const ORIGIN = new URL(process.env.APP_URL ?? 'http://localhost:3460').origin;

/** A test-only route at level 'full', so the gates are tested without depending on the schools routes. */
@Controller('platform/test-only')
export class FullLevelController {
  @Get('full')
  @PlatformSession()
  @ApiErrors()
  full(@Query() _query: NoQueryDto): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [FullLevelController] })
export class TestPlatformModule {}

export const randomIp = (): string =>
  `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

export interface Admin {
  email: string;
  password: string;
  ip: string;
}

/** A freshly seeded admin: must change password, no authenticator. */
export async function seedAdmin(app: NestExpressApplication): Promise<Admin> {
  const email = `pa-${randomBytes(6).toString('hex')}@test.invalid`;
  const password = `pw-${randomBytes(9).toString('base64url')}`;
  await expect(app.get(PlatformAdminSeeder).seed(email, password)).resolves.toBe('created');
  return { email, password, ip: randomIp() };
}

export async function userIdOf(email: string): Promise<bigint> {
  const user = await testDb().platformUser.findUnique({ where: { email } });
  if (!user) throw new Error('no such platform user');
  return user.id;
}

/** The session token from a Set-Cookie header, or undefined. */
export function tokenFrom(res: request.Response): string | undefined {
  const header: unknown = res.headers['set-cookie'];
  const cookies = Array.isArray(header) ? header.filter((c) => typeof c === 'string') : [];
  const prefix = `${PLATFORM_COOKIE}=`;
  const cookie = cookies.find((c) => c.startsWith(prefix));
  return cookie?.slice(prefix.length).split(';')[0];
}

export const cookieOf = (token: string): string => `${PLATFORM_COOKIE}=${token}`;

/**
 * Moves a session's created, last-seen and expiry times `ms` into the past, as if it had been
 * minted that long ago. Returns the token hash.
 */
export async function backdateSession(token: string, ms: number): Promise<string> {
  const tokenHash = sha256Hex(token);
  const row = await testDb().platformSession.findUniqueOrThrow({ where: { tokenHash } });
  const back = (date: Date) => new Date(date.getTime() - ms);
  await testDb().platformSession.update({
    where: { tokenHash },
    data: {
      createdAt: back(row.createdAt),
      lastSeenAt: back(row.lastSeenAt),
      expiresAt: back(row.expiresAt),
    },
  });
  return tokenHash;
}

/** A TOTP code for the current step plus `offset` (−1, 0, +1 are inside the accepted window). */
export async function totpCode(secret: string, offset = 0): Promise<string> {
  // Codes are made and checked a few ms apart; keep away from a step boundary so a test never
  // straddles one.
  const intoStep = (Date.now() / 1000) % 30;
  if (intoStep > 28) await new Promise((resolve) => setTimeout(resolve, (30.2 - intoStep) * 1000));
  return generate({ secret, epoch: Math.floor(Date.now() / 1000) + offset * 30 });
}

export class Client {
  constructor(
    private readonly app: NestExpressApplication,
    readonly ip: string = randomIp(),
  ) {}

  private http = () => request(this.app.getHttpServer());

  login(body: Record<string, unknown>, extra: { cookie?: string; origin?: string | null } = {}) {
    const req = this.http().post('/api/v1/platform/auth/login').set('X-Forwarded-For', this.ip);
    if (extra.origin !== null) req.set('Origin', extra.origin ?? ORIGIN);
    if (extra.cookie) req.set('Cookie', extra.cookie);
    return req.send(body);
  }

  get(path: string, token?: string) {
    const req = this.http().get(`/api/v1/platform${path}`).set('X-Forwarded-For', this.ip);
    return token === undefined ? req : req.set('Cookie', cookieOf(token));
  }

  post(path: string, token: string | undefined, body?: object, origin: string | null = ORIGIN) {
    const req = this.http().post(`/api/v1/platform${path}`).set('X-Forwarded-For', this.ip);
    if (origin !== null) req.set('Origin', origin);
    if (token !== undefined) req.set('Cookie', cookieOf(token));
    return body === undefined ? req : req.send(body);
  }
}

/** Login with the password only: an enrolment-stage session. */
export async function enrolmentSession(client: Client, admin: Admin): Promise<string> {
  const res = await client.login({ email: admin.email, password: admin.password }).expect(200);
  const token = tokenFrom(res);
  if (!token) throw new Error('no session cookie');
  return token;
}

/** Login, enrol and confirm: a full session that must still change its password. */
export async function enrolledSession(
  client: Client,
  admin: Admin,
): Promise<{ token: string; secret: string }> {
  const enrolment = await enrolmentSession(client, admin);
  const enrol = await client.post('/auth/totp/enrol', enrolment).expect(200);
  const { secret } = enrol.body as { secret: string };
  // The previous step: the next login can then use the current one without waiting.
  const confirm = await client
    .post('/auth/totp/confirm', enrolment, { code: await totpCode(secret, -1) })
    .expect(200);
  const token = tokenFrom(confirm);
  if (!token) throw new Error('no session cookie');
  return { token, secret };
}

/** Enrolled and password changed: a session that passes every gate. */
export async function readySession(
  client: Client,
  admin: Admin,
): Promise<{ token: string; secret: string }> {
  const { token, secret } = await enrolledSession(client, admin);
  const newPassword = `${admin.password}-new`;
  const res = await client
    .post('/auth/change-password', token, { currentPassword: admin.password, newPassword })
    .expect(200);
  admin.password = newPassword;
  const rotated = tokenFrom(res);
  if (!rotated) throw new Error('no session cookie');
  return { token: rotated, secret };
}
