import { expect as baseExpect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { seedPlatformAdmin } from './support/seed';
import { totp } from './support/totp';

// The platform console against the REAL API (started by playwright.config.ts on the TEST
// database). Covers the whole first sign-in (contracts/slice-1.md §7): login → enrol → confirm →
// forced password change → schools → create → activate.
//
// Isolation: each run seeds its own platform admin, with a unique email and a random password,
// into TEST_DATABASE_URL by running the API's own seed script (idempotent, one admin per email)
// with those values in its environment; `dotenv run` does not override variables already set,
// so the root .env cannot redirect it. The development database and its admin are never
// touched. Schools created here use a unique short code and stay in the test database.

const expect = baseExpect.configure({ timeout: 15_000 });

const runId = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`.slice(-9);
const email = `e2e-${runId}@localhost`;
const initialPassword = `E2e-${randomBytes(12).toString('hex')}`;
const newPassword = `E2e-${randomBytes(12).toString('hex')}`;
const shortCode = `e2e${runId}`; // 12 lower-case letters or digits at most
const schoolName = `E2E School ${runId}`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => seedPlatformAdmin(email, initialPassword));

test('first sign-in through to activating a new school', async ({ page }) => {
  test.setTimeout(120_000);

  // Login, password only: not yet enrolled. Wait for hydration so the click calls the API
  // instead of submitting the form natively.
  await page.goto('/platform/login');
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(initialPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Fails here, before anything is written, if the API on :3001 is not on the test database.
  await expect(page, 'the API must run on TEST_DATABASE_URL').toHaveURL(/\/platform\/enrol$/);

  // Enrol: the QR and the setup key are shown; the code is computed from the key.
  await page.getByRole('button', { name: 'Set up authenticator' }).click();
  const qr = page.getByRole('img', { name: 'QR code for your authenticator app' });
  await expect(qr).toBeVisible();
  expect(await qr.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  const secret = (await page.getByTestId('totp-secret').textContent())?.replace(/\s/g, '') ?? '';
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  await page.getByLabel('Authenticator code').fill(totp(secret));
  await page.getByRole('button', { name: 'Confirm' }).click();

  // Forced password change.
  await expect(page).toHaveURL(/\/platform\/change-password$/);
  await page.getByLabel('Current password').fill(initialPassword);
  await page.getByLabel('New password', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirm new password').fill(newPassword);
  await page.getByRole('button', { name: 'Change password' }).click();

  // The school list.
  await expect(page).toHaveURL(/\/platform\/schools$/);
  await expect(page.getByRole('heading', { name: 'Schools' })).toBeVisible();

  // Create a school: 201, then its detail page, on trial.
  await page.getByRole('link', { name: 'New school' }).first().click();
  await expect(page).toHaveURL(/\/platform\/schools\/new$/);
  await page.getByLabel('School name').fill(schoolName);
  await page.getByLabel('Short code').fill(shortCode);
  await page.getByRole('button', { name: 'Create school' }).click();
  await expect(page).toHaveURL(/\/platform\/schools\/(?!new$)[^/]+$/);
  await expect(page.getByRole('heading', { name: schoolName })).toBeVisible();
  const record = page.locator('dl');
  await expect(record).toContainText('Trial');

  // Activate it with a reason.
  await page.getByRole('button', { name: 'Change status' }).click();
  await page.getByRole('menuitem', { name: 'Activate' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason').fill('Subscription paid, e2e run.');
  await dialog.getByRole('button', { name: 'Activate' }).click();
  await expect(dialog).toBeHidden();
  await expect(record).toContainText('Active');

  // The list shows it active too.
  await page.getByRole('link', { name: 'Schools' }).first().click();
  await expect(page).toHaveURL(/\/platform\/schools$/);
  await page.getByLabel('Search').fill(shortCode);
  const row = page.getByRole('row').filter({ hasText: schoolName });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Active');
});
