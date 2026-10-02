// Applies committed migrations to TEST_DATABASE_URL. Loads the root .env itself so it works
// whatever wrapper launches it, and refuses to run without a distinct test URL, so it can
// never migrate the development database by accident.
const { config } = require('dotenv');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

config({ path: resolve(__dirname, '../../../.env'), quiet: true });

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  console.error('TEST_DATABASE_URL is not set');
  process.exit(1);
}
if (testUrl === process.env.DATABASE_URL) {
  console.error('TEST_DATABASE_URL must differ from DATABASE_URL');
  process.exit(1);
}

// Run the CLI through node directly: no shell, no reliance on PATH or .bin shims.
const cli = require.resolve('prisma/build/index.js');
const result = spawnSync(process.execPath, [cli, 'migrate', 'deploy'], {
  cwd: resolve(__dirname, '..'),
  env: { ...process.env, DATABASE_URL: testUrl },
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
