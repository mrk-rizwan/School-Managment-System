// The refusals of seed-dev-school.ts, pure so each has a unit test (test/scripts/seed-dev-guard.spec.ts).
// Security review of slice 15, M2 and L4: the script creates a principal whose password is a
// known identity number, so it runs only against a database that is plainly a developer's own.

import { normaliseIdentityDigits, normalisePhone } from '@asms/shared';

export class SeedRefusal extends Error {}

/** The made-up principal of CI's throwaway school (ci.yml): known to anyone who reads the repo. */
export const CI_PRINCIPAL_DIGITS = '3520299999991';

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

/**
 * Throws a SeedRefusal unless seeding is allowed, and returns which condition allowed it:
 * never in production; only against a loopback database host, or anywhere with ALLOW_DEV_SEED=1;
 * and the CI identity number only against a loopback host, whatever the flag says.
 */
export function assertSeedAllowed(env: SeedEnv, cnic: string): string {
  if (env.NODE_ENV === 'production') {
    throw new SeedRefusal('Refusing to seed a development school in production');
  }
  const host = databaseHost(env.DATABASE_URL);
  const loopback = host !== null && LOOPBACK_HOSTS.has(host);
  if (cnic === CI_PRINCIPAL_DIGITS && !loopback) {
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
