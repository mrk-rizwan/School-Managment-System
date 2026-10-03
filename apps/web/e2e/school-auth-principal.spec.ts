import { expect as baseExpect, test, type Page, type Request } from '@playwright/test';
import type { ApiErrorEnvelope } from '../lib/api/errors';
import type { components } from '../lib/api/platform';
import type { IssuePrincipalLoginDto } from '../lib/api/platform-contract';

// Platform "Issue principal login" on the school detail page (contracts/slice-2.md §7, §10),
// against a mocked platform API.

const expect = baseExpect.configure({ timeout: 15_000 });

type Me = components['schemas']['PlatformMeDto'];
type School = components['schemas']['SchoolDto'];

const ME: Me = {
  id: '1',
  email: 'admin@example.test',
  sessionStage: 'full',
  totpEnrolled: true,
  mustChangePassword: false,
  sessionExpiresAt: '2026-10-02T20:00:00.000Z',
};

const SCHOOL: School = {
  id: 's1',
  name: 'Green Valley School',
  shortCode: 'greenvalley',
  status: 'active',
  timezone: 'Asia/Karachi',
  createdAt: '2026-09-01T05:00:00.000Z',
  updatedAt: '2026-09-01T05:00:00.000Z',
};

const ISSUED: IssuePrincipalLoginDto = {
  userId: 'u1',
  staffId: 'st1',
  fullName: 'Amina Khan',
  linkedExistingUser: false,
};

function errorBody(code: ApiErrorEnvelope['error']['code'], message: string): ApiErrorEnvelope {
  return { error: { code, message, details: null, requestId: 'req-test' } };
}

/** `issueReplies` answer successive issue requests; after them, 201 ISSUED. */
async function mockPlatformApi(
  page: Page,
  school: School,
  issueReplies: { status: number; body: unknown }[] = [],
) {
  const requests: Request[] = [];
  await page.route('**/api/v1/platform/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1/platform', '');
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() === 'GET' && path === '/me') return json(200, ME);
    if (request.method() === 'GET' && path === `/schools/${school.id}`) return json(200, school);
    if (request.method() === 'POST' && path === `/schools/${school.id}/issue-principal-login`) {
      requests.push(request);
      const next = issueReplies.shift();
      return next ? json(next.status, next.body) : json(201, ISSUED);
    }
    return json(500, errorBody('INTERNAL_ERROR', `Unmocked ${request.method()} ${path}`));
  });
  return requests;
}

async function openIssueDialog(page: Page) {
  await page.goto(`/platform/schools/${SCHOOL.id}`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Issue principal login' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Full name').fill('Amina Khan');
  await dialog.getByLabel('CNIC').fill('35202-1234567-1');
  await dialog.getByLabel('Mobile number').fill('0300 1234567');
  return dialog;
}

test('issues a principal login with normalised CNIC and phone', async ({ page }) => {
  const requests = await mockPlatformApi(page, SCHOOL);
  const dialog = await openIssueDialog(page);
  await expect(dialog.getByLabel('Reason')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Issue login' }).click();

  await expect(dialog.getByText('Principal login issued')).toBeVisible();
  await expect(dialog).toContainText('greenvalley');
  expect(requests[0].postDataJSON()).toEqual({
    fullName: 'Amina Khan',
    cnic: '3520212345671',
    phone: '+923001234567',
  });
});

test('an existing principal makes the reason appear; the retry carries it', async ({ page }) => {
  const requests = await mockPlatformApi(page, SCHOOL, [
    {
      status: 409,
      body: errorBody('ACTIVE_PRINCIPAL_EXISTS', 'This school already has an active principal.'),
    },
  ]);
  const dialog = await openIssueDialog(page);
  await dialog.getByRole('button', { name: 'Issue login' }).click();

  const reason = dialog.getByLabel('Reason');
  await expect(reason).toBeVisible();
  await expect(dialog).toContainText('already has an active principal');
  await reason.fill('Previous principal retired.');
  await dialog.getByRole('button', { name: 'Issue login' }).click();

  await expect(dialog.getByText('Principal login issued')).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1].postDataJSON()).toEqual({
    fullName: 'Amina Khan',
    cnic: '3520212345671',
    phone: '+923001234567',
    reason: 'Previous principal retired.',
  });
});

test('ALREADY_PRINCIPAL (a resubmit after a timeout) is shown as done', async ({ page }) => {
  await mockPlatformApi(page, SCHOOL, [
    { status: 409, body: errorBody('ALREADY_PRINCIPAL', 'Already a principal.') },
  ]);
  const dialog = await openIssueDialog(page);
  await dialog.getByRole('button', { name: 'Issue login' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('This person is already a principal of this school.')).toBeVisible();
});

test('an existing sign-in needs confirming; the retry carries confirmLinkExisting', async ({
  page,
}) => {
  const requests = await mockPlatformApi(page, SCHOOL, [
    {
      status: 409,
      body: errorBody('LINK_EXISTING_LOGIN_UNCONFIRMED', 'This CNIC already has a login.'),
    },
    { status: 201, body: { ...ISSUED, linkedExistingUser: true } },
  ]);
  const dialog = await openIssueDialog(page);
  await dialog.getByRole('button', { name: 'Issue login' }).click();

  await expect(dialog.getByText('This person already has a sign-in')).toBeVisible();
  await expect(dialog).toContainText('sign them out everywhere');
  await expect(dialog).toContainText('reset their password to the default, their CNIC digits');
  await expect(dialog).toContainText('clear their email address');
  expect(requests).toHaveLength(1);
  expect(requests[0].postDataJSON()).not.toHaveProperty('confirmLinkExisting');

  await dialog.getByRole('button', { name: 'Reset and issue login' }).click();
  await expect(dialog.getByText('Principal login issued')).toBeVisible();
  await expect(dialog).toContainText('existing sign-in at this school now carries the principal role');
  expect(requests).toHaveLength(2);
  expect(requests[1].postDataJSON()).toEqual({
    fullName: 'Amina Khan',
    cnic: '3520212345671',
    phone: '+923001234567',
    confirmLinkExisting: true,
  });
});

test('going back from the confirmation sends nothing more', async ({ page }) => {
  const requests = await mockPlatformApi(page, SCHOOL, [
    {
      status: 409,
      body: errorBody('LINK_EXISTING_LOGIN_UNCONFIRMED', 'This CNIC already has a login.'),
    },
  ]);
  const dialog = await openIssueDialog(page);
  await dialog.getByRole('button', { name: 'Issue login' }).click();
  await dialog.getByRole('button', { name: 'Back' }).click();
  await expect(dialog.getByLabel('Full name')).toHaveValue('Amina Khan');
  expect(requests).toHaveLength(1);
});

test('a terminated school offers no principal login', async ({ page }) => {
  await mockPlatformApi(page, { ...SCHOOL, status: 'terminated' });
  await page.goto(`/platform/schools/${SCHOOL.id}`);
  await expect(page.getByRole('heading', { name: SCHOOL.name })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Issue principal login' })).toHaveCount(0);
});
