import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * The repo-root .env (the one the API and docker compose read), overlaid by the process
 * environment, so CI can supply values without a file. Read, never written to process.env.
 */
export function rootEnv(): Record<string, string | undefined> {
  const file = resolve(__dirname, '../../../../.env');
  const fromFile = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  return { ...fromFile, ...process.env };
}

/**
 * The environment the real-API e2e runs the API (and its seed) with: the root .env with
 * DATABASE_URL pointed at TEST_DATABASE_URL. Refuses when there is no distinct test database,
 * so the development database can never be the target.
 */
export function testApiEnv(): Record<string, string> {
  const env = rootEnv();
  const testUrl = env.TEST_DATABASE_URL;
  if (!testUrl) throw new Error('TEST_DATABASE_URL is not set (repo-root .env)');
  if (testUrl === env.DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL must differ from DATABASE_URL');
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return { ...out, DATABASE_URL: testUrl };
}
