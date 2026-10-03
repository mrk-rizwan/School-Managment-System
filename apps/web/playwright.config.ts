import { defineConfig, devices } from '@playwright/test';
import { testApiEnv } from './e2e/support/root-env';

const port = 3000;
const apiPort = 3001;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `pnpm exec next dev --port ${port}`,
      url: `http://localhost:${port}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // The real API for e2e/platform-real.spec.ts, from its build (`pnpm --filter @asms/api
      // build` first), against TEST_DATABASE_URL, never the development database. Next proxies
      // /api/* to this port. A server already on the port is reused locally: if it is a dev API
      // on the development database the real test fails at its first sign-in (its admin exists
      // only in the test database) before it writes anything.
      command: 'node ../api/dist/main.js',
      url: `http://127.0.0.1:${apiPort}/api/v1/health`,
      env: { ...testApiEnv(), API_PORT: String(apiPort) },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
