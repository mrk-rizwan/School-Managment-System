// Platform users and sessions written straight to the database, so tests of platform routes can
// authenticate without driving login, TOTP enrolment and password change each time. The rows
// satisfy every CHECK on platform_users / platform_sessions; nothing here bypasses the guard: the
// request still carries a real cookie that the real access check resolves.
import { randomBytes } from 'node:crypto';
import { newSessionToken, PLATFORM_COOKIE } from '../../src/common/auth/platform-session';
import { testDb } from './schools';

/** Passes platform_users_password_hash_check; verifies against no password. */
const UNUSABLE_ARGON2_HASH = '$argon2id$v=19$m=19456,t=2,p=1$dGVzdHNhbHQ$dGVzdC1vbmx5LW5vdC1hLWhhc2g';

export interface TestPlatformUser {
  id: bigint;
  email: string;
}

export async function createPlatformUser(
  options: {
    /** An argon2id encoded hash; default verifies against nothing. */
    passwordHash?: string;
    mustChangePassword?: boolean;
    /** Default true: an enrolled authenticator (placeholder ciphertext). */
    totpEnrolled?: boolean;
    status?: 'active' | 'disabled';
  } = {},
): Promise<TestPlatformUser> {
  const enrolled = options.totpEnrolled ?? true;
  const email = `platform-${randomBytes(6).toString('hex')}@example.test`;
  const row = await testDb().platformUser.create({
    data: {
      email,
      passwordHash: options.passwordHash ?? UNUSABLE_ARGON2_HASH,
      mustChangePassword: options.mustChangePassword ?? false,
      status: options.status ?? 'active',
      ...(enrolled ? { totpSecret: 'v1:test-placeholder', totpEnrolledAt: new Date() } : {}),
    },
  });
  return { id: row.id, email: row.email };
}

export interface TestPlatformSession {
  sessionId: bigint;
  token: string;
  /** The value for a supertest `.set('Cookie', ...)`. */
  cookie: string;
}

/** A live session for `userId`, stored as the server stores it (SHA-256 of the token only). */
export async function createPlatformSession(
  userId: bigint,
  options: {
    stage?: 'totp_enrolment' | 'full';
    expiresAt?: Date;
    lastSeenAt?: Date;
    revokedAt?: Date;
  } = {},
): Promise<TestPlatformSession> {
  const { token, tokenHash } = newSessionToken();
  const now = new Date();
  const row = await testDb().platformSession.create({
    data: {
      platformUserId: userId,
      tokenHash,
      stage: options.stage ?? 'full',
      createdAt: new Date(now.getTime() - 1000),
      lastSeenAt: options.lastSeenAt ?? now,
      expiresAt: options.expiresAt ?? new Date(now.getTime() + 12 * 60 * 60_000),
      ...(options.revokedAt ? { revokedAt: options.revokedAt } : {}),
    },
  });
  return { sessionId: row.id, token, cookie: `${PLATFORM_COOKIE}=${token}` };
}

/** A fully signed-in platform admin: enrolled, password changed, full-stage session. */
export async function signedInPlatformAdmin(): Promise<TestPlatformUser & TestPlatformSession> {
  const user = await createPlatformUser();
  return { ...user, ...(await createPlatformSession(user.id)) };
}
