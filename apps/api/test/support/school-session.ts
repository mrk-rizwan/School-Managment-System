// School users and sessions written straight to the database, so e2e tests of school routes can
// authenticate before (and without driving) the slice-2 login flow. The rows satisfy every CHECK
// on staff / users / user_roles / sessions, and nothing here bypasses a guard: the request still
// carries a real token that the real session resolver looks up by its SHA-256.
//
// Identity values follow plan §3.6 exactly, so a test can also log in or office-reset these users:
// the CNIC is AES-256-GCM under FIELD_ENCRYPTION_KEYS with AAD `schoolId|staff|cnic`, and
// cnic_hash = username_hash = HMAC-SHA256(IDENTITY_HASH_KEY, 13 digits) in lower hex (the same
// definition as identityHash in src/common/identity.ts).
import { createHmac, randomInt } from 'node:crypto';
import { newSessionToken } from '../../src/common/auth/platform-session';
import { FieldCipher } from '../../src/common/crypto/field-encryption';
import { PasswordHasher } from '../../src/common/crypto/password';
import { loadEnv, type Env } from '../../src/config/env';
import type {
  SessionChannel,
  StaffStatus,
  SystemRole,
  UserStatus,
} from '../../src/repositories/generated/prisma/client';
import type { GuardedPrismaClient } from '../../src/repositories/prisma';
import type { SchoolId } from '../../src/tenancy/school-id';
import type { TestSchool } from './schools';

/** The school session cookie (plan §3.5, contract slice-2 §1.2). */
export const SCHOOL_SESSION_COOKIE = '__Host-asms_session';

/** Passes users_password_hash_check; verifies against no password. */
const UNUSABLE_ARGON2_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$dGVzdHNhbHQ$dGVzdC1vbmx5LW5vdC1hLWhhc2g';

let env: Env | undefined;
const testEnv = (): Env => (env ??= loadEnv());

/** 13 random digits, first digit 1-9 (no real CNIC starts with 0). */
export function randomIdentityDigits(): string {
  let digits = String(randomInt(1, 10));
  for (let i = 0; i < 12; i++) digits += String(randomInt(0, 10));
  return digits;
}

/** Lower-hex HMAC-SHA256 of the 13 digits under IDENTITY_HASH_KEY: cnic_hash and username_hash. */
export function testIdentityHash(digits: string): string {
  return createHmac('sha256', Buffer.from(testEnv().IDENTITY_HASH_KEY, 'base64'))
    .update(digits)
    .digest('hex');
}

export interface SchoolUserOptions {
  systemRole: SystemRole;
  /** Default `active`. */
  staffStatus?: StaffStatus;
  /** Default `active`. */
  userStatus?: UserStatus;
  /**
   * True: the real default password (the CNIC digits, peppered argon2id) and
   * password_is_default = true. Takes precedence over `password`.
   */
  defaultPassword?: boolean;
  /**
   * A real password (peppered argon2id), password_is_default = false. With neither option the
   * hash verifies against nothing (fast; for tests that never log in).
   */
  password?: string;
  /** Default null. Stored trimmed and lower-cased, as users_email_normalised_check requires. */
  email?: string | null;
  /** Default false; needs `email`. */
  emailVerified?: boolean;
  /**
   * The user_roles.assigned_by. Default: the user itself for office_staff / teacher (the CHECK
   * requires an assigner) and null for principal (as issue-principal-login writes it).
   */
  assignedBy?: bigint | null;
  fullName?: string;
}

export interface TestSchoolUser {
  schoolId: SchoolId;
  userId: bigint;
  staffId: bigint;
  userRoleId: bigint;
  /** The 13 digits: the username, and the password when `defaultPassword` is set. */
  cnic: string;
  usernameHash: string;
}

/** A staff member with a login and one live system role, in `school`. */
export async function createSchoolUser(
  db: GuardedPrismaClient,
  school: TestSchool,
  options: SchoolUserOptions,
): Promise<TestSchoolUser> {
  const schoolId = school.id;
  const cnic = randomIdentityDigits();
  const usernameHash = testIdentityHash(cnic);
  const cipher = new FieldCipher(testEnv().FIELD_ENCRYPTION_KEYS);

  const staff = await db.staff.create({
    data: {
      schoolId,
      fullName: options.fullName ?? `Test ${options.systemRole} ${cnic.slice(-4)}`,
      cnic: cipher.encrypt(cnic, `${schoolId}|staff|cnic`),
      cnicHash: usernameHash,
      phone: `+923${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`,
      status: options.staffStatus ?? 'active',
    },
  });

  const isDefault = options.defaultPassword === true;
  const plain = isDefault ? cnic : options.password;
  const passwordHash =
    plain === undefined ? UNUSABLE_ARGON2_HASH : await new PasswordHasher(testEnv()).hash(plain);
  const email = options.email?.trim().toLowerCase() ?? null;
  if (options.emailVerified && !email)
    throw new Error('createSchoolUser: emailVerified needs email');

  const user = await db.user.create({
    data: {
      schoolId,
      usernameHash,
      passwordHash,
      passwordIsDefault: isDefault,
      email,
      emailVerifiedAt: options.emailVerified ? new Date() : null,
      status: options.userStatus ?? 'active',
      staffId: staff.id,
    },
  });

  const assignedBy =
    options.assignedBy !== undefined
      ? options.assignedBy
      : options.systemRole === 'principal'
        ? null
        : user.id;
  const role = await db.userRole.create({
    data: { schoolId, userId: user.id, systemRole: options.systemRole, assignedBy },
  });

  return { schoolId, userId: user.id, staffId: staff.id, userRoleId: role.id, cnic, usernameHash };
}

export interface TestSchoolSession {
  sessionId: bigint;
  /** The raw token; only its SHA-256 is stored. */
  token: string;
  /** For supertest `.set('Cookie', ...)` on a cookie session. */
  cookie: string;
  /** For supertest `.set('Authorization', ...)` on a bearer session. */
  authorization: string;
}

/** A live session for `user`, stored as the server stores it (SHA-256 lower hex of the token). */
export async function createSchoolSession(
  db: GuardedPrismaClient,
  school: TestSchool,
  user: Pick<TestSchoolUser, 'userId'>,
  options: {
    /** Default `cookie`. A token is accepted only on its own channel. */
    channel?: SessionChannel;
    /** Default 30 days from now (absolute lifetime). */
    expiresAt?: Date;
    /** Default now; set it 24 h back to test the idle timeout. */
    lastSeenAt?: Date;
    revokedAt?: Date;
  } = {},
): Promise<TestSchoolSession> {
  const { token, tokenHash } = newSessionToken();
  const now = Date.now();
  const expiresAt = options.expiresAt ?? new Date(now + 30 * 24 * 60 * 60_000);
  const row = await db.session.create({
    data: {
      schoolId: school.id,
      userId: user.userId,
      tokenHash,
      channel: options.channel ?? 'cookie',
      // Before both now and expiresAt, so an already-expired session still passes
      // sessions_expires_at_check (expires_at > created_at).
      createdAt: new Date(Math.min(now, expiresAt.getTime()) - 60_000),
      lastSeenAt: options.lastSeenAt ?? new Date(now),
      expiresAt,
      revokedAt: options.revokedAt ?? null,
    },
  });
  return {
    sessionId: row.id,
    token,
    cookie: `${SCHOOL_SESSION_COOKIE}=${token}`,
    authorization: `Bearer ${token}`,
  };
}
