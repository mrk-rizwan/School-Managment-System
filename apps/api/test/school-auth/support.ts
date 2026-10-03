// Helpers shared by the slice-2 e2e suites. Rows are written straight to the database, as in
// test/support/school-session.ts; requests still go through the real guard and services.
import { randomInt } from 'node:crypto';
import { Body, Controller, Get, Module, Post, Query } from '@nestjs/common';
import { Capability } from '@asms/shared';
import { FieldCipher } from '../../src/common/crypto/field-encryption';
import {
  AllowWhenSuspended,
  AuthenticatedOnly,
  RequireCapability,
  RequireStaff,
} from '../../src/common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../src/common/auth/school-session';
import { ApiErrors } from '../../src/common/openapi';
import { NoQueryDto } from '../../src/common/validation';
import { loadEnv } from '../../src/config/env';
import type { MailMessage } from '../../src/modules/auth/mailer';
import { RequestContextService } from '../../src/tenancy/request-context';
import { randomIdentityDigits, testIdentityHash } from '../support/school-session';
import type { testDb, TestSchool } from '../support/schools';

type Db = ReturnType<typeof testDb>;

export const ORIGIN = new URL(process.env.APP_URL ?? 'http://localhost:3000').origin;

/** A guardian with a login and nothing else: a parent-only account. */
export async function createGuardianUser(
  db: Db,
  school: TestSchool,
  options: { userStatus?: 'active' | 'disabled' } = {},
): Promise<{ userId: bigint; guardianId: bigint; cnic: string }> {
  const cnic = randomIdentityDigits();
  const hash = testIdentityHash(cnic);
  const cipher = new FieldCipher(loadEnv().FIELD_ENCRYPTION_KEYS);
  const guardian = await db.guardian.create({
    data: {
      schoolId: school.id,
      fullName: `Guardian ${cnic.slice(-4)}`,
      cnic: cipher.encrypt(cnic, `${school.id}|guardians|cnic`),
      cnicHash: hash,
      phone: `+923${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`,
      contactCapability: 'whatsapp',
    },
  });
  const user = await db.user.create({
    data: {
      schoolId: school.id,
      usernameHash: hash,
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$dGVzdHNhbHQ$dGVzdC1vbmx5LW5vdC1hLWhhc2g',
      status: options.userStatus ?? 'active',
      guardianId: guardian.id,
    },
  });
  return { userId: user.id, guardianId: guardian.id, cnic };
}

/** Test-only routes, one per access decorator, reporting what the guard established. */
@Controller('test-access')
export class AccessProbeController {
  constructor(private readonly context: RequestContextService) {}

  private report(session: SchoolSessionContext) {
    return {
      schoolId: this.context.schoolId?.toString() ?? null,
      userId: this.context.userId?.toString() ?? null,
      sessionId: this.context.sessionId?.toString() ?? null,
      sessionSchoolId: session.schoolId.toString(),
    };
  }

  @Get('authenticated')
  @AuthenticatedOnly()
  @ApiErrors(401)
  authenticated(@Query() _q: NoQueryDto, @CurrentSchoolSession() s: SchoolSessionContext) {
    return this.report(s);
  }

  @Get('staff')
  @RequireStaff()
  @ApiErrors(401, 403)
  staff(@Query() _q: NoQueryDto, @CurrentSchoolSession() s: SchoolSessionContext) {
    return this.report(s);
  }

  @Post('staff')
  @RequireStaff()
  @ApiErrors(401, 403)
  staffWrite(@Query() _q: NoQueryDto, @Body() _b: NoQueryDto) {
    return { ok: true };
  }

  @Post('staff-suspended-ok')
  @RequireStaff()
  @AllowWhenSuspended()
  @ApiErrors(401, 403)
  staffWriteWhenSuspended(@Query() _q: NoQueryDto, @Body() _b: NoQueryDto) {
    return { ok: true };
  }

  @Get('settings')
  @RequireCapability(Capability.SCHOOL_SETTINGS_MANAGE)
  @ApiErrors(401, 403)
  settings(@Query() _q: NoQueryDto) {
    return { ok: true };
  }

  @Get('either')
  @RequireCapability(Capability.SCHOOL_SETTINGS_MANAGE, Capability.STUDENT_VIEW)
  @ApiErrors(401, 403)
  either(@Query() _q: NoQueryDto) {
    return { ok: true };
  }
}

@Module({ controllers: [AccessProbeController] })
export class AccessProbeModule {}

/** Replaces Mailer in tests: records every message instead of sending it. */
export class FakeMailer {
  readonly messages: MailMessage[] = [];

  send(message: MailMessage): Promise<void> {
    this.messages.push(message);
    return Promise.resolve();
  }

  to(address: string): MailMessage[] {
    return this.messages.filter((m) => m.to === address);
  }

  /** Waits (up to 3 s) for a message to `address` beyond the first `after` ones. */
  async next(address: string, after = 0): Promise<MailMessage> {
    for (let i = 0; i < 60; i++) {
      const found = this.to(address)[after];
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`no mail to ${address}`);
  }
}

/** The token in a reset or verify link (it travels in the fragment). */
export function tokenFrom(message: MailMessage): string {
  const match = /#token=([A-Za-z0-9_-]{43})/.exec(message.text);
  if (!match?.[1]) throw new Error('no token in the message');
  return match[1];
}

export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A unique client IP per call, so per-IP limits do not interfere between tests. Each test file
 * starts from a random block, so files run within one rate-limit window do not collide either.
 */
let ipCounter = randomInt(0, 1 << 22) << 8;
export function nextIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

let emailCounter = 0;
export function uniqueEmail(): string {
  emailCounter += 1;
  return `user${Date.now().toString(36)}${emailCounter}@example.test`;
}

/** The Set-Cookie values of a response. */
export function setCookies(res: { headers: Record<string, unknown> }): string[] {
  const raw: unknown = res.headers['set-cookie'];
  return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string') : [];
}

/** `name=value` of the school session cookie a response set, for a later request's Cookie. */
export function sessionCookieOf(res: { headers: Record<string, unknown> }): string {
  const cookie = setCookies(res).find((c) => c.startsWith('__Host-asms_session='));
  if (!cookie) throw new Error('no session cookie');
  return cookie.split(';')[0] ?? '';
}
