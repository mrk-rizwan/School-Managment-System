// The refusals of seed-dev-school.ts, pure so each has a unit test (test/scripts/seed-dev-guard.spec.ts).
// Security review of slice 15, M2 and L4: the script creates a principal whose password is a
// known identity number, so it runs only against a database that is plainly a developer's own.

import { normaliseIdentityDigits, normalisePhone } from '@asms/shared';

export class SeedRefusal extends Error {}

/** The made-up principal of CI's throwaway school (ci.yml): known to anyone who reads the repo. */
export const CI_PRINCIPAL_DIGITS = '3520299999991';
/** The classroom fixture's made-up teacher and guardian (contracts/slice-16.md §15.3). */
export const CI_TEACHER_DIGITS = '3520299999992';
export const CI_GUARDIAN_DIGITS = '3520299999993';

/** Every identity number the repository publishes: allowed against a loopback database only. */
export const CI_IDENTITY_DIGITS: ReadonlySet<string> = new Set([
  CI_PRINCIPAL_DIGITS,
  CI_TEACHER_DIGITS,
  CI_GUARDIAN_DIGITS,
]);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export type SeedEnv = {
  NODE_ENV?: string;
  DATABASE_URL?: string;
  ALLOW_DEV_SEED?: string;
  DEV_SCHOOL_PRINCIPAL_CNIC?: string;
  DEV_SCHOOL_CODE?: string;
  DEV_SCHOOL_NAME?: string;
  DEV_SCHOOL_PRINCIPAL_NAME?: string;
  DEV_SCHOOL_PRINCIPAL_PHONE?: string;
  DEV_SCHOOL_CLASSROOM?: string;
  DEV_SCHOOL_TEACHER_CNIC?: string;
  DEV_SCHOOL_TEACHER_PHONE?: string;
  DEV_SCHOOL_TEACHER_NAME?: string;
  DEV_SCHOOL_GUARDIAN_CNIC?: string;
  DEV_SCHOOL_GUARDIAN_PHONE?: string;
  DEV_SCHOOL_GUARDIAN_NAME?: string;
};

/** The database host, or null when the URL does not parse (never the URL: it holds a password). */
export function databaseHost(url: string | undefined): string | null {
  if (url === undefined || url === '') return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export type SeedSettings = {
  cnic: string;
  shortCode: string;
  name: string;
  fullName: string;
  phone: string;
};

/** What to create. The identity number and the phone are required: no live-looking default. */
export function readSeedSettings(env: SeedEnv): SeedSettings {
  const cnic = normaliseIdentityDigits(env.DEV_SCHOOL_PRINCIPAL_CNIC ?? '');
  if (cnic === null) throw new SeedRefusal('DEV_SCHOOL_PRINCIPAL_CNIC: missing or not 13 digits');
  const given = env.DEV_SCHOOL_PRINCIPAL_PHONE?.trim() ?? '';
  if (given === '') throw new SeedRefusal('DEV_SCHOOL_PRINCIPAL_PHONE: required');
  // Stored as E.164, as the console's PhoneField would store it.
  const phone = normalisePhone(given);
  if (phone === null) throw new SeedRefusal('DEV_SCHOOL_PRINCIPAL_PHONE: not a phone number');
  return {
    cnic,
    shortCode: env.DEV_SCHOOL_CODE ?? 'demo',
    name: env.DEV_SCHOOL_NAME ?? 'Demo School',
    fullName: env.DEV_SCHOOL_PRINCIPAL_NAME ?? 'Demo Principal',
    phone,
  };
}

/** A person the classroom fixture creates with a login: identity number, phone, name. */
export type SeedPerson = { cnic: string; phone: string; fullName: string };

export type ClassroomSettings = { teacher: SeedPerson; guardian: SeedPerson };

function readPerson(env: SeedEnv, who: 'TEACHER' | 'GUARDIAN', defaultName: string): SeedPerson {
  const key = `DEV_SCHOOL_${who}` as const;
  const cnic = normaliseIdentityDigits(env[`${key}_CNIC`] ?? '');
  if (cnic === null) throw new SeedRefusal(`${key}_CNIC: missing or not 13 digits`);
  const given = env[`${key}_PHONE`]?.trim() ?? '';
  if (given === '') throw new SeedRefusal(`${key}_PHONE: required`);
  const phone = normalisePhone(given);
  if (phone === null) throw new SeedRefusal(`${key}_PHONE: not a phone number`);
  return { cnic, phone, fullName: env[`${key}_NAME`] ?? defaultName };
}

/**
 * The classroom fixture (contracts/slice-16.md §15.3), only behind DEV_SCHOOL_CLASSROOM=1: a
 * teacher and a guardian, each with an identity number and a phone (no live-looking default).
 * Returns null when the flag is not set. The three people must be three different numbers.
 */
export function readClassroomSettings(
  env: SeedEnv,
  principalCnic: string,
): ClassroomSettings | null {
  if (env.DEV_SCHOOL_CLASSROOM !== '1') return null;
  const teacher = readPerson(env, 'TEACHER', 'Demo Teacher');
  const guardian = readPerson(env, 'GUARDIAN', 'Demo Guardian');
  if (new Set([principalCnic, teacher.cnic, guardian.cnic]).size !== 3) {
    throw new SeedRefusal(
      'The principal, the teacher and the guardian need three different identity numbers',
    );
  }
  return { teacher, guardian };
}

/**
 * Throws a SeedRefusal unless seeding is allowed, and returns which condition allowed it:
 * never in production; only against a loopback database host, or anywhere with ALLOW_DEV_SEED=1;
 * and a CI identity number (principal, teacher or guardian) only against a loopback host,
 * whatever the flag says.
 */
export function assertSeedAllowed(env: SeedEnv, ...cnics: string[]): string {
  if (env.NODE_ENV === 'production') {
    throw new SeedRefusal('Refusing to seed a development school in production');
  }
  const host = databaseHost(env.DATABASE_URL);
  const loopback = host !== null && LOOPBACK_HOSTS.has(host);
  if (cnics.some((cnic) => CI_IDENTITY_DIGITS.has(cnic)) && !loopback) {
    throw new SeedRefusal(
      'Refusing the CI identity number against a non-loopback database: anyone can read it',
    );
  }
  if (loopback) return `the database host ${host} is loopback`;
  if (env.ALLOW_DEV_SEED === '1') return `ALLOW_DEV_SEED=1 is set (database host ${host ?? '?'})`;
  throw new SeedRefusal(
    `Refusing to seed: the database host ${host ?? '(unparsed)'} is not loopback. ` +
      'Set ALLOW_DEV_SEED=1 if it is a development database.',
  );
}
