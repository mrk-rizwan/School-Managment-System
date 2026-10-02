// Prisma 7 reads the connection URL from here, not from schema.prisma, and no longer loads .env
// itself. The repository-root .env is loaded below when present; it never overrides a variable
// already set, so CI and scripts/migrate-test-db.js (which sets DATABASE_URL to the test
// database) keep control. `url` stays optional so `prisma generate` runs without a database.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'prisma/config';

const rootEnv = resolve(__dirname, '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL },
});
