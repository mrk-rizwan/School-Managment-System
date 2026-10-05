import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
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

/**
 * Rule 24 (R225): a principal on the default password cannot manage user accounts or roles. The
 * real flow (add and verify an email, then change the password) needs the mailbox, so the e2e
 * records the change directly in TEST_DATABASE_URL for the school's principals; they keep signing
 * in with the identity digits.
 */
export function recordPrincipalPasswordChanged(shortCode: string) {
  const sql =
    'UPDATE users SET password_is_default = false, password_changed_at = now() ' +
    'WHERE school_id = (SELECT id FROM schools WHERE short_code = $1) AND id IN (' +
    "SELECT user_id FROM user_roles WHERE system_role = 'principal' AND ended_at IS NULL " +
    'AND school_id = (SELECT id FROM schools WHERE short_code = $1))';
  const script =
    "const { Client } = require('pg');" +
    '(async () => { const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();' +
    ` const r = await c.query(${JSON.stringify(sql)}, [process.argv[1]]); await c.end();` +
    " if (r.rowCount !== 1) { console.error('principals updated: ' + r.rowCount); process.exit(1); } })()" +
    '.catch((e) => { console.error(e.message); process.exit(1); });';
  // Run from apps/api, where pg is installed.
  const run = spawnSync(process.execPath, ['-e', script, shortCode], {
    cwd: resolve(__dirname, '../../../api'),
    encoding: 'utf8',
    env: { ...process.env, ...testApiEnv() },
    timeout: 60_000,
  });
  if (run.status !== 0) throw new Error(`Recording the principal's password change failed:\n${run.stderr}`);
}
