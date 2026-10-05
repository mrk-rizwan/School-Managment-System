import { Capability } from '@asms/shared';
import { expect as baseExpect, test, type Page } from '@playwright/test';
import { randomBytes, randomInt } from 'node:crypto';
import { recordPrincipalPasswordChanged, seedPlatformAdmin } from './support/seed';
import { totp } from './support/totp';

// The slice-7 scenario against the REAL API (started by playwright.config.ts on the TEST
// database), plan §5 slice 7: the principal grants payment.verify to an office user, the user's
// GET /me shows it on their next request, the principal ends it, and it is gone (R50, R58, R69).
//
// Isolation as in students-real.spec.ts: a per-run platform admin, school code and random CNICs
// in TEST_DATABASE_URL. The development database is never touched.

const expect = baseExpect.configure({ timeout: 15_000 });

const digits = (count: number) =>
  Array.from({ length: count }, () => String(randomInt(0, 10))).join('');
/** 13 digits, not starting with 0 (rule 12: CNIC logins). */
const identity = () => `${randomInt(1, 10)}${digits(12)}`;

const runId = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`.slice(-9);
const email = `e2e-${runId}@localhost`;
const initialPassword = `E2e-${randomBytes(12).toString('hex')}`;
const newPassword = `E2e-${randomBytes(12).toString('hex')}`;
const shortCode = `e2e${runId}`;
const schoolName = `E2E Permissions ${runId}`;
const principalCnic = identity();
const officeCnic = identity();
const officeName = `Omar Office ${runId}`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => seedPlatformAdmin(email, initialPassword));

/** The platform admin's first sign-in: password, authenticator enrolment, password change. */
async function platformFirstSignIn(page: Page) {
  await page.goto('/platform/login');
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(initialPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Fails here, before anything is written, if the API on :3461 is not on the test database.
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

/** School sign-in on the default password (rule 12: the identity digits). */
async function schoolSignIn(page: Page, cnic: string) {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await page.getByLabel('School code').fill(shortCode);
  await page.getByLabel('CNIC or B-Form number').fill(cnic);
  await page.getByLabel('Password').fill(cnic);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/account$/);
}

/** The signed-in user's effective capabilities, as their next request sees them. */
async function capabilitiesOf(page: Page): Promise<string[]> {
  const response = await page.request.get('/api/v1/me');
  expect(response.status()).toBe(200);
  return ((await response.json()) as { capabilities: string[] }).capabilities;
}

test('principal grants payment.verify to an office user; /me shows it; ending it removes it', async ({
  browser,
}) => {
  test.setTimeout(240_000);

  // ---- Platform admin: the school and its principal.
  const platformContext = await browser.newContext();
  const admin = await platformContext.newPage();
  await platformFirstSignIn(admin);
  await admin.getByRole('link', { name: 'New school' }).first().click();
  await admin.getByLabel('School name').fill(schoolName);
  await admin.getByLabel('Short code').fill(shortCode);
  await admin.getByRole('button', { name: 'Create school' }).click();
  await expect(admin.getByRole('heading', { name: schoolName })).toBeVisible();
  await admin.getByRole('button', { name: 'Issue principal login' }).click();
  const issue = admin.getByRole('dialog');
  await issue.getByLabel('Full name').fill('Amina Principal');
  await issue.getByLabel('CNIC').fill(principalCnic);
  await issue.getByLabel('Mobile number').fill(`0300${digits(7)}`);
  await issue.getByRole('button', { name: 'Issue login' }).click();
  await expect(issue.getByText('Principal login issued')).toBeVisible();
  await platformContext.close();

  // ---- Principal: an office staff member with a login.
  const principalContext = await browser.newContext();
  const page = await principalContext.newPage();
  // Rule 24: the principal manages logins only once the default password is changed.
  recordPrincipalPasswordChanged(shortCode);
  await schoolSignIn(page, principalCnic);
  await page.goto('/staff/new');
  await page.getByLabel('Full name').fill(officeName);
  await page.getByLabel('CNIC (optional)').fill(officeCnic);
  await page.getByLabel('Mobile phone').fill(`0301${digits(7)}`);
  await page.getByRole('button', { name: 'Add staff member' }).click();
  await expect(page).toHaveURL(/\/staff\/(?!new$)[^/]+$/);
  await expect(page.getByRole('heading', { name: officeName })).toBeVisible();
  await page.getByRole('tab', { name: 'Login and roles' }).click();
  await page.getByRole('button', { name: 'Issue login' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Role').selectOption('office_staff');
  await dialog.getByRole('button', { name: 'Issue login' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/Has a login, as Office staff/)).toBeVisible();

  // ---- The office user signs in: office defaults do not include payment.verify (plan §7).
  const officeContext = await browser.newContext();
  const office = await officeContext.newPage();
  await schoolSignIn(office, officeCnic);
  expect(await capabilitiesOf(office)).not.toContain(Capability.PAYMENT_VERIFY);

  // ---- Principal grants it on the Permissions tab.
  await page.getByRole('tab', { name: 'Permissions' }).click();
  await expect(page.getByText('No grants or revokes')).toBeVisible();
  await page.getByRole('button', { name: 'Grant or revoke' }).click();
  dialog = page.getByRole('dialog', { name: `Grant or revoke for ${officeName}` });
  await dialog.getByLabel('Capability').selectOption(Capability.PAYMENT_VERIFY);
  await dialog.getByLabel('Reason').fill('Covers the accountant on leave');
  await dialog.getByRole('button', { name: 'Grant', exact: true }).click();
  await expect(dialog).toBeHidden();
  const grant = page.getByRole('listitem', { name: 'Grant: Verify payments' });
  await expect(grant.getByText('“Covers the accountant on leave”')).toBeVisible();
  await expect(
    page.getByRole('region', { name: /In force/ }).getByRole('listitem', { name: 'Verify payments' }),
  ).toContainText('From Granted');

  // ---- The office user's next request carries it.
  expect(await capabilitiesOf(office)).toContain(Capability.PAYMENT_VERIFY);

  // ---- Principal ends it; the office user's next request no longer carries it.
  await grant.getByRole('button', { name: 'End' }).click();
  dialog = page.getByRole('dialog', { name: 'End the grant of “Verify payments”?' });
  await dialog.getByLabel('Reason').fill('The accountant is back');
  await dialog.getByRole('button', { name: 'End' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('No grants or revokes')).toBeVisible();
  expect(await capabilitiesOf(office)).not.toContain(Capability.PAYMENT_VERIFY);

  // The ended row stays in the history (rule 4).
  await page.getByLabel('Show ended changes').check();
  await expect(page.getByRole('listitem', { name: 'Grant: Verify payments' })).toContainText(
    '“The accountant is back”',
  );

  await officeContext.close();
  await principalContext.close();
});
