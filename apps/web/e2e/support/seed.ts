import { spawnSync } from 'node:child_process';
import { testApiEnv } from './root-env';

/**
 * Seeds a platform admin into TEST_DATABASE_URL by running the API's own seed script
 * (idempotent, one admin per email) with these values in its environment; `dotenv run` does not
 * override variables already set, so the root .env cannot redirect it to the development
 * database.
 */
export function seedPlatformAdmin(email: string, password: string) {
  const seed = spawnSync('pnpm --filter @asms/api seed:platform-admin', [], {
    // A fixed command line; shell only so Windows resolves pnpm.cmd.
    shell: true,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...testApiEnv(),
      PLATFORM_ADMIN_EMAIL: email,
      PLATFORM_ADMIN_PASSWORD: password,
    },
    timeout: 120_000,
  });
  if (seed.status !== 0 || !/\bcreated\b/.test(seed.stdout)) {
    throw new Error(`Seeding the e2e platform admin failed:\n${seed.stdout}\n${seed.stderr}`);
  }
}
