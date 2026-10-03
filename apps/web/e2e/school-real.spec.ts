import { expect as baseExpect, test, type Page } from '@playwright/test';
import { randomBytes, randomInt } from 'node:crypto';
import { seedPlatformAdmin } from './support/seed';
import { totp } from './support/totp';

// The school console against the REAL API (started by playwright.config.ts on the TEST
// database), from an empty school to its first records: a platform admin creates a school and
// issues a principal login (contracts/slice-2.md §7); the principal signs in with the school code
// and CNIC digits on the default password (§4.1, rule 12), sees the default-password banner,
// creates an academic year and a class (slice-3.md) and a guardian (slice-5.md).
//
// Isolation as in platform-real.spec.ts: a platform admin seeded per run into TEST_DATABASE_URL
// with unique credentials, a unique school short code and a random CNIC. The development
// database is never touched; the rows stay in the test database.

const expect = baseExpect.configure({ timeout: 15_000 });

const digits = (count: number) =>
  Array.from({ length: count }, () => String(randomInt(0, 10))).join('');

const runId = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`.slice(-9);
const email = `e2e-${runId}@localhost`;
const initialPassword = `E2e-${randomBytes(12).toString('hex')}`;
const newPassword = `E2e-${randomBytes(12).toString('hex')}`;
const shortCode = `e2e${runId}`; // 12 lower-case letters or digits at most
const schoolName = `E2E School ${runId}`;
// 13 digits, not starting with 0; the default password is the same digits (rule 12).
const cnic = `${randomInt(1, 10)}${digits(12)}`;
const guardianName = `Bilal Guardian ${runId}`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => seedPlatformAdmin(email, initialPassword));

/** The platform admin's first sign-in: password, authenticator enrolment, password change. */
async function platformFirstSignIn(page: Page) {
  await page.goto('/platform/login');
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(initialPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Fails here, before anything is written, if the API on :3001 is not on the test database.
  await expect(page, 'the API must run on TEST_DATABASE_URL').toHaveURL(/\/platform\/enrol$/);

  await page.getByRole('button', { name: 'Set up authenticator' }).click();
  const secretText = page.getByTestId('totp-secret');
  await expect(secretText).toBeVisible();
  const secret = (await secretText.textContent())?.replace(/\s/g, '') ?? '';
  await page.getByLabel('Authenticator code').fill(totp(secret));
  await page.getByRole('button', { name: 'Confirm' }).click();

  await expect(page).toHaveURL(/\/platform\/change-password$/);
  await page.getByLabel('Current password').fill(initialPassword);
  await page.getByLabel('New password', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirm new password').fill(newPassword);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page).toHaveURL(/\/platform\/schools$/);
}

test('a new school: principal login, academic year, class and guardian', async ({ browser }) => {
  test.setTimeout(180_000);

  // ---- Platform admin: create the school and issue the principal login.
  const platformContext = await browser.newContext();
  const admin = await platformContext.newPage();
  await platformFirstSignIn(admin);

  await admin.getByRole('link', { name: 'New school' }).first().click();
  await expect(admin).toHaveURL(/\/platform\/schools\/new$/);
  await admin.getByLabel('School name').fill(schoolName);
  await admin.getByLabel('Short code').fill(shortCode);
  await admin.getByRole('button', { name: 'Create school' }).click();
  await expect(admin.getByRole('heading', { name: schoolName })).toBeVisible();

  await admin.getByRole('button', { name: 'Issue principal login' }).click();
  const issue = admin.getByRole('dialog');
  await issue.getByLabel('Full name').fill('Amina Principal');
  await issue.getByLabel('CNIC').fill(cnic);
  await issue.getByLabel('Mobile number').fill(`0300${digits(7)}`);
  await issue.getByRole('button', { name: 'Issue login' }).click();
  await expect(issue.getByText('Principal login issued')).toBeVisible();
  await expect(issue).toContainText(shortCode);
  await issue.getByRole('button', { name: 'Done' }).click();
  await expect(issue).toBeHidden();
  await platformContext.close();

  // ---- Principal: sign in on the default password, in a browser context of its own.
  const schoolContext = await browser.newContext();
  const page = await schoolContext.newPage();
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await page.getByLabel('School code').fill(shortCode);
  await page.getByLabel('CNIC or B-Form number').fill(cnic);
  await page.getByLabel('Password').fill(cnic);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByText('You are still using the default password')).toBeVisible();

  // ---- Academic structure: a year, then a class in it.
  await page.getByRole('link', { name: 'Academic structure' }).click();
  await expect(page).toHaveURL(/\/academics\/years$/);
  await page.getByRole('button', { name: 'New academic year' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('2026-27');
  await dialog.getByLabel('Starts on').fill('2026-04-01');
  await dialog.getByLabel('Ends on').fill('2027-03-31');
  await dialog.getByRole('button', { name: 'Create year' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('row').filter({ hasText: '2026-27' })).toContainText('Planned');

  await page.getByRole('link', { name: 'Classes' }).click();
  await expect(page).toHaveURL(/\/academics\/classes/);
  await page.getByRole('button', { name: 'New class' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Class 1');
  await dialog.getByLabel('Attendance is taken').selectOption('daily');
  await dialog.getByRole('button', { name: 'Create class' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('table').getByRole('link', { name: 'Class 1' })).toBeVisible();

  // ---- Guardians: create one; its detail page opens.
  await page.getByRole('link', { name: 'Guardians' }).first().click();
  await expect(page).toHaveURL(/\/guardians$/);
  await page.getByRole('link', { name: 'New guardian' }).first().click();
  await expect(page).toHaveURL(/\/guardians\/new$/);
  await page.getByLabel('Full name').fill(guardianName);
  await page.getByRole('radio', { name: /WhatsApp/ }).check();
  await page.getByRole('button', { name: 'Add guardian' }).click();
  await expect(page).toHaveURL(/\/guardians\/(?!new$)[^/]+$/);
  await expect(page.getByRole('heading', { name: guardianName })).toBeVisible();

  await schoolContext.close();
});
