import { defineConfig, devices } from '@playwright/test';

// The mocked specs only: every /api/v1/* request is answered in the browser by page.route, so
// no API process is started (the `*-real.spec.ts` files need one and are left out). Its own port,
// so it never collides with a dev server on 3000. Run with
// `pnpm exec playwright test -c playwright.mocked.config.ts --workers 1 [spec…]`.
const port = 3100;

export default defineConfig({
  testDir: './e2e',
  testIgnore: /-real\.spec\.ts$/,
  fullyParallel: true,
  reporter: 'list',
  use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec next dev --port ${port}`,
    url: `http://localhost:${port}/login`,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
