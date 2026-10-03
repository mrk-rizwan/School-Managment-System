import { Capability, SYSTEM_ROLE_DEFAULTS } from '@asms/shared';
import { expect as baseExpect, test, type Page, type Request } from '@playwright/test';
import type { ApiErrorEnvelope } from '../lib/api/errors';
import type { MeDto, UserDto } from '../lib/api/school-contract';
import type { SchoolSettingsDto } from '../lib/api/school-messaging-contract';

// School sign-in, account, users and settings screens against a mocked API
// (contracts/slice-2.md §10). Every school /api/v1/* request is answered in the browser by
// page.route; no API process is involved. Payload and error types are the
// generated OpenAPI types (via lib/api/school-contract.ts), so the mocks follow the real API.

// `next dev` compiles each route on first visit: assertions wait longer than the 5 s default.
const expect = baseExpect.configure({ timeout: 15_000 });

const TOKEN = 'Abcdefghij_klmnopqrst-uvwxyz0123456789ABCDE'; // 43 characters, base64url
const PASSWORD = 'correct horse battery'; // pragma: allowlist secret
const NEW_PASSWORD = 'a much better password'; // pragma: allowlist secret

const OFFICE_ME: MeDto = {
  id: 'u-office',
  fullName: 'Sana Office',
  email: null,
  hasVerifiedEmail: false,
  passwordIsDefault: true,
  school: { id: 's1', name: 'Green Valley School', shortCode: 'greenvalley', status: 'active' },
  roles: ['office_staff'],
  capabilities: [...SYSTEM_ROLE_DEFAULTS.office_staff].sort(),
  sessionExpiresAt: '2026-11-02T05:00:00.000Z',
  capacities: ['staff'],
  assignments: [],
};
const PRINCIPAL_ME: MeDto = {
  ...OFFICE_ME,
  id: 'u-principal',
  fullName: 'Amina Principal',
  email: 'amina@example.test',
  hasVerifiedEmail: true,
  passwordIsDefault: false,
  roles: ['principal'],
  capabilities: Object.values(Capability).sort(),
};

const user = (id: string, fullName: string, extra: Partial<UserDto> = {}): UserDto => ({
  id,
  staffId: `st-${id}`,
  guardianId: null,
  studentId: null,
  fullName,
  systemRoles: ['teacher'],
  customRoleNames: [],
  status: 'active',
  emailMasked: 'k***@example.test',
  hasEmail: true,
  hasVerifiedEmail: true,
  passwordIsDefault: false,
  lastLoginAt: '2026-10-01T04:30:00.000Z',
  createdAt: '2026-09-01T05:00:00.000Z',
  ...extra,
});

type ErrorBody = ApiErrorEnvelope['error'];

function errorBody(
  code: ErrorBody['code'],
  message: string,
  details: ErrorBody['details'] = null,
): ApiErrorEnvelope {
  return { error: { code, message, details, requestId: 'req-test' } };
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

type MockState = {
  /** null: no session, every authenticated call answers 401. */
  me: MeDto | null;
  loginResult?: MeDto;
  /** Answers for successive POST /auth/login calls, before loginResult applies. */
  loginReplies?: Reply[];
  users?: UserDto[];
  usersReply?: Reply;
  /** Answers every reset / disable / enable instead of applying it. */
  actionReply?: Reply;
  settings?: SchoolSettingsDto;
  resetReply?: Reply;
  verifyReply?: Reply;
};

async function mockSchoolApi(page: Page, state: MockState) {
  const requests: Request[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    if (path.startsWith('/platform/')) return route.fallback();
    requests.push(request);
    const method = request.method();
    const reply = ({ status, body, headers }: Reply) =>
      route.fulfill({
        status,
        headers,
        contentType: 'application/json',
        body: body === undefined ? '' : JSON.stringify(body),
      });
    const json = (status: number, body?: unknown) => reply({ status, body });

    if (method === 'POST' && path === '/auth/login') {
      const next = state.loginReplies?.shift();
      if (next) return reply(next);
      state.me = state.loginResult ?? OFFICE_ME;
      return json(200, state.me);
    }
    if (method === 'POST' && path === '/auth/forgot-password') return json(202, {});
    if (method === 'POST' && path === '/auth/reset-password') {
      return reply(state.resetReply ?? { status: 204 });
    }
    if (method === 'POST' && path === '/auth/verify-email') {
      return reply(state.verifyReply ?? { status: 204 });
    }
    if (!state.me) return json(401, errorBody('AUTH_REQUIRED', 'Sign in to continue.'));
    const me = state.me;

    if (method === 'GET' && path === '/me') return json(200, me);
    if (method === 'POST' && path === '/auth/logout') {
      state.me = null;
      return route.fulfill({ status: 204 });
    }
    if (method === 'POST' && path === '/me/change-email') {
      const { email } = request.postDataJSON() as { email: string };
      state.me = { ...me, email, hasVerifiedEmail: false };
      return json(200, state.me);
    }
    if (method === 'POST' && path === '/me/change-password') {
      // The API answers with LoginResultDto: the session rotates, so the cookie is re-set and the
      // body carries `bearerToken` (null on the cookie channel).
      state.me = { ...me, passwordIsDefault: false };
      return json(200, { ...state.me, bearerToken: null });
    }
    if (method === 'GET' && path === '/users') {
      if (state.usersReply) return reply(state.usersReply);
      const users = state.users ?? [];
      return json(200, { data: users, page: 1, limit: 25, total: users.length });
    }
    const action = path.match(/^\/users\/([^/]+)\/(reset-password|disable|enable)$/);
    const target = action && state.users?.find((u) => u.id === action[1]);
    if (action && target && method === 'POST') {
      if (state.actionReply) return reply(state.actionReply);
      if (action[2] === 'disable') target.status = 'disabled';
      if (action[2] === 'enable') target.status = 'active';
      if (action[2] === 'reset-password') {
        target.passwordIsDefault = true;
        if ((request.postDataJSON() as { clearEmail: boolean }).clearEmail) {
          Object.assign(target, { hasEmail: false, emailMasked: null, hasVerifiedEmail: false });
        }
      }
      return json(200, target);
    }
    if (path === '/school/settings' && state.settings) {
      if (method === 'GET') return json(200, state.settings);
      if (method === 'PATCH') {
        state.settings = {
          ...state.settings,
          ...(request.postDataJSON() as Partial<SchoolSettingsDto>),
          updatedAt: new Date().toISOString(),
        };
        return json(200, state.settings);
      }
    }
    return json(500, errorBody('INTERNAL_ERROR', `Unmocked ${method} ${path}`));
  });
  return requests;
}

/** Opens a page and waits until it has hydrated (a click before that would submit natively). */
async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
}

const posted = (requests: Request[], suffix: string) =>
  requests.filter((r) => r.method() !== 'GET' && new URL(r.url()).pathname.endsWith(suffix));

test.describe('sign in', () => {
  test('remembered code, dashed CNIC, lands on the account page with the banner', async ({ page }) => {
    await page.addInitScript(() => {
      // Only on the first load: later navigations must see what the app itself stored.
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem('asms.schoolCode', 'greenvalley');
        sessionStorage.setItem('seeded', '1');
      }
    });
    const requests = await mockSchoolApi(page, { me: null });

    await open(page, '/login');
    await expect(page.getByLabel('School code')).toHaveValue('greenvalley');
    await page.getByLabel('CNIC or B-Form number').fill('35202-1234567-1');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByTestId('default-password-banner')).toBeVisible();
    await expect(page.getByTestId('default-password-banner')).toContainText(
      'Add and verify an email address',
    );

    // Sidebar from GET /me's capabilities: office staff manage accounts, not school settings.
    const nav = page.getByRole('navigation');
    await expect(nav.getByRole('link', { name: 'User accounts' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Your account' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'School settings' })).toHaveCount(0);

    expect(posted(requests, '/auth/login')[0].postDataJSON()).toEqual({
      schoolCode: 'greenvalley',
      username: '3520212345671',
      password: PASSWORD,
    });
    // The school code is the only thing stored; identity digits never reach storage or the URL.
    const stored = await page.evaluate(() => ({ ...localStorage }));
    expect(stored).toEqual({ 'asms.schoolCode': 'greenvalley' });
    expect(page.url()).not.toMatch(/\d{13}/);
  });

  test('a refused sign-in shows one generic message, the 429 wait, and the 503 notice', async ({
    page,
  }) => {
    await mockSchoolApi(page, {
      me: null,
      loginReplies: [
        {
          status: 401,
          body: errorBody('AUTH_FAILED', 'School code, username or password is incorrect.'),
        },
        {
          status: 429,
          headers: { 'Retry-After': '120' },
          body: errorBody('RATE_LIMITED', 'Too many requests.'),
        },
        { status: 503, body: errorBody('SERVICE_UNAVAILABLE', 'Unavailable.') },
      ],
    });

    await open(page, '/login');
    await page.getByLabel('School code').fill('GreenValley');
    await page.getByLabel('CNIC or B-Form number').fill('3520212345671');
    const signIn = async () => {
      await page.getByLabel('Password').fill(PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();
    };
    const alert = page.getByRole('alert').filter({ hasText: /./ }).first();

    await signIn();
    await expect(alert).toHaveText('School code, username or password is incorrect.');
    await expect(page.getByLabel('Password')).toHaveValue('');
    await signIn();
    await expect(alert).toHaveText('Too many attempts. Try again in 2 minutes.');
    await signIn();
    await expect(alert).toHaveText('Sign-in is unavailable at the moment. Try again shortly.');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('a malformed CNIC is refused before anything is sent', async ({ page }) => {
    const requests = await mockSchoolApi(page, { me: null });
    await open(page, '/login');
    await page.getByLabel('School code').fill('greenvalley');
    await page.getByLabel('CNIC or B-Form number').fill('35202-123');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Enter the 13 digits of your CNIC or B-Form number.')).toBeVisible();
    expect(posted(requests, '/auth/login')).toHaveLength(0);
  });

  test('no session: a console page sends you to sign in', async ({ page }) => {
    await mockSchoolApi(page, { me: null });
    await page.goto('/users');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('sign out posts logout and returns to sign in', async ({ page }) => {
    const requests = await mockSchoolApi(page, { me: PRINCIPAL_ME });
    await open(page, '/account');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(posted(requests, '/auth/logout')).toHaveLength(1);
  });
});

test.describe('forgot, reset and verify', () => {
  test('forgot password always shows the same confirmation', async ({ page }) => {
    const requests = await mockSchoolApi(page, { me: null });
    await open(page, '/forgot');
    await page.getByLabel('School code').fill('greenvalley');
    await page.getByLabel('CNIC or B-Form number').fill('35202-1234567-1');
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByText('Check your email')).toBeVisible();
    await expect(page.getByText(/Ask your school office/)).toBeVisible();
    expect(posted(requests, '/auth/forgot-password')[0].postDataJSON()).toEqual({
      schoolCode: 'greenvalley',
      username: '3520212345671',
    });
  });

  test('reset reads the fragment, clears it, posts the token in the body, then sign in', async ({
    page,
  }) => {
    const requests = await mockSchoolApi(page, { me: null });
    await open(page, `/reset/greenvalley#token=${TOKEN}`);
    await expect(page.getByRole('button', { name: 'Set new password' })).toBeVisible();
    expect(page.url()).not.toContain('token');
    expect(page.url()).not.toContain('#');

    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel('Confirm new password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(posted(requests, '/auth/reset-password')[0].postDataJSON()).toEqual({
      schoolCode: 'greenvalley',
      token: TOKEN,
      newPassword: NEW_PASSWORD,
    });
  });

  test('an expired or used reset link offers a new one', async ({ page }) => {
    await mockSchoolApi(page, {
      me: null,
      resetReply: { status: 409, body: errorBody('TOKEN_INVALID', 'The link is not valid.') },
    });
    await open(page, `/reset/greenvalley#token=${TOKEN}`);
    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel('Confirm new password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(page.getByText('This link cannot be used')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Request a new link' })).toHaveAttribute(
      'href',
      '/forgot',
    );
  });

  test('a reset link without a token is refused without a request', async ({ page }) => {
    const requests = await mockSchoolApi(page, { me: null });
    await open(page, '/reset/greenvalley');
    await expect(page.getByText('This link cannot be used')).toBeVisible();
    expect(requests).toHaveLength(0);
  });

  test('verify-email does nothing on load and verifies on the button press', async ({ page }) => {
    const requests = await mockSchoolApi(page, { me: null });
    await open(page, `/verify-email/greenvalley#token=${TOKEN}`);
    const verify = page.getByRole('button', { name: 'Verify email address' });
    await expect(verify).toBeVisible();
    expect(page.url()).not.toContain('token');
    expect(posted(requests, '/auth/verify-email')).toHaveLength(0);

    await verify.click();
    await expect(page.getByText('Email verified')).toBeVisible();
    const sent = posted(requests, '/auth/verify-email');
    expect(sent).toHaveLength(1);
    expect(sent[0].postDataJSON()).toEqual({ schoolCode: 'greenvalley', token: TOKEN });
  });
});

test.describe('account', () => {
  test('without a verified email the password form is locked; setting an email sends a link', async ({
    page,
  }) => {
    const requests = await mockSchoolApi(page, { me: { ...OFFICE_ME } });
    await open(page, '/account');
    await expect(page.getByRole('button', { name: 'Change password' })).toBeDisabled();
    await expect(page.getByText('Add and verify an email address first')).toBeVisible();

    await page.getByLabel('Email address').fill('Sana@Example.test ');
    const emailForm = page.locator('form').first();
    await emailForm.getByLabel('Current password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Save and send verification link' }).click();
    await expect(page.getByText('sana@example.test')).toBeVisible();
    await expect(page.getByText('Not verified')).toBeVisible();
    expect(posted(requests, '/me/change-email')[0].postDataJSON()).toEqual({
      email: 'sana@example.test',
      currentPassword: PASSWORD,
    });
    // Still unverified: the password stays locked.
    await expect(page.getByRole('button', { name: 'Change password' })).toBeDisabled();
  });

  test('with a verified email, changing the password removes the banner', async ({ page }) => {
    const requests = await mockSchoolApi(page, {
      me: { ...OFFICE_ME, email: 'sana@example.test', hasVerifiedEmail: true },
    });
    await open(page, '/account');
    await expect(page.getByTestId('default-password-banner')).toBeVisible();

    const passwordForm = page.locator('form').nth(1);
    await passwordForm.getByLabel('Current password').fill('3520212345671');
    await passwordForm.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await passwordForm.getByLabel('Confirm new password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Change password' }).click();

    await expect(page.getByTestId('default-password-banner')).toHaveCount(0);
    expect(posted(requests, '/me/change-password')[0].postDataJSON()).toEqual({
      currentPassword: '3520212345671', // pragma: allowlist secret
      newPassword: NEW_PASSWORD,
    });
  });
});

test.describe('user accounts', () => {
  test('filters go to the API and the list shows masked emails, never identity numbers', async ({
    page,
  }) => {
    const requests = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      users: [
        user('u1', 'Kamran Teacher'),
        user('u2', 'Bilal Parent', {
          staffId: null,
          guardianId: 'g1',
          systemRoles: [],
          hasEmail: false,
          emailMasked: null,
          hasVerifiedEmail: false,
          passwordIsDefault: true,
          lastLoginAt: null,
        }),
      ],
    });
    await open(page, '/users');
    const table = page.getByRole('table');
    await expect(table.getByRole('row')).toHaveCount(3);
    await expect(table).toContainText('k***@example.test');
    await expect(table).toContainText('No email');
    await expect(table).toContainText('Never');
    await expect(table).not.toContainText(/\d{5}-?\d{7}-?\d/);

    await page.getByLabel('Password', { exact: true }).selectOption('true');
    await page.getByLabel('Email', { exact: true }).selectOption('false');
    await expect
      .poll(() => {
        const last = requests.filter((r) => new URL(r.url()).pathname === '/api/v1/users').at(-1);
        return last && Object.fromEntries(new URL(last.url()).searchParams);
      })
      .toEqual({
        page: '1',
        limit: '25',
        sort: 'fullName',
        passwordIsDefault: 'true',
        hasEmail: 'false',
      });
  });

  test('an identity number typed into the search is never sent as q, dashed or not', async ({
    page,
  }) => {
    const requests = await mockSchoolApi(page, { me: PRINCIPAL_ME, users: [user('u1', 'Kamran Teacher')] });
    const sentQ = () =>
      requests
        .filter((r) => new URL(r.url()).pathname === '/api/v1/users')
        .map((r) => new URL(r.url()).searchParams.get('q'));
    await open(page, '/users');
    const search = page.getByLabel('Search');
    await search.fill('Kamran');
    await expect.poll(() => sentQ().at(-1)).toBe('Kamran');

    for (const cnic of ['35201-1234567-1', '35201 1234567 1', '+92 35201-1234567-1']) {
      await search.fill(cnic);
      await expect(page.getByText('Search by name. Identity numbers are not searchable.')).toBeVisible();
    }
    // Nothing typed above reaches the query, not even once the debounce has settled.
    await page.waitForTimeout(600);
    expect(sentQ().filter((q) => q !== null && /\d/.test(q))).toEqual([]);
  });

  test('office reset requires the keep-or-clear choice and a reason', async ({ page }) => {
    const requests = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      users: [user('u1', 'Kamran Teacher')],
    });
    await open(page, '/users');
    await page.getByRole('button', { name: 'Actions for Kamran Teacher' }).click();
    await page.getByRole('menuitem', { name: 'Reset password' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('k***@example.test');
    const confirm = dialog.getByRole('button', { name: 'Reset password' });
    await dialog.getByLabel('Reason').fill('Forgot password, came to the office.');
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel('Clear the email').check();
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(dialog).toBeHidden();
    expect(posted(requests, '/users/u1/reset-password')[0].postDataJSON()).toEqual({
      reason: 'Forgot password, came to the office.',
      clearEmail: true,
    });
  });

  test('disable asks for a reason; no actions on your own row', async ({
    page,
  }) => {
    const requests = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      users: [user('u1', 'Kamran Teacher'), user('u-principal', 'Amina Principal')],
    });
    await open(page, '/users');
    await expect(page.getByRole('button', { name: 'Actions for Amina Principal' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Actions for Kamran Teacher' }).click();
    await page.getByRole('menuitem', { name: 'Disable account' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Reason').fill('Left the school.');
    await dialog.getByRole('button', { name: 'Disable account' }).click();
    await expect(dialog).toBeHidden();
    expect(posted(requests, '/users/u1/disable')[0].postDataJSON()).toEqual({
      reason: 'Left the school.',
    });
    await expect(page.getByRole('table')).toContainText('Disabled');
  });

  test('a refused action is explained in words the office can act on', async ({ page }) => {
    await mockSchoolApi(page, {
      me: OFFICE_ME,
      users: [user('u1', 'Amina Principal', { systemRoles: ['principal'] })],
      actionReply: {
        status: 403,
        body: errorBody('PERMISSION_DENIED', 'Permission denied.', { reason: 'target_is_principal' }),
      },
    });
    await open(page, '/users');
    await page.getByRole('button', { name: 'Actions for Amina Principal' }).click();
    await page.getByRole('menuitem', { name: 'Disable account' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Reason').fill('Testing a refusal.');
    await dialog.getByRole('button', { name: 'Disable account' }).click();
    await expect(page.getByText(/Only someone who manages roles/)).toBeVisible();
    // The dialog stays open so the reason is not lost.
    await expect(dialog).toBeVisible();
  });

  test('a 403 shows the no-access state', async ({ page }) => {
    await mockSchoolApi(page, {
      me: OFFICE_ME,
      usersReply: { status: 403, body: errorBody('PERMISSION_DENIED', 'Permission denied.') },
    });
    await open(page, '/users');
    await expect(page.getByText('You do not have access')).toBeVisible();
    await expect(page).toHaveURL(/\/users$/);
  });
});

/** contracts/slice-9.md §4: the slice-2 fields plus the plan §4.5 additions, at their defaults. */
const settingsFixture = (extra: Partial<SchoolSettingsDto> = {}): SchoolSettingsDto => ({
  feeDueDay: 10,
  studentLoginEnabled: false,
  periodsPerDay: 8,
  weeklyOffDays: [0],
  attendanceAmendWindowDays: 3,
  registerDeadlineTime: '10:00',
  absenceAlertTime: '09:30',
  lateAdviceEnabled: false,
  lateCountsAs: 'present',
  lateCutoffTime: null,
  leaveCountsAs: 'excused',
  smsMonthlyCap: 500,
  smsAllowedTypes: ['absence_alert', 'late_advice', 'attendance_corrected', 'announcement_urgent', 'holiday_notice'],
  remarkDefaultVisibility: 'guardian',
  remarkNotifyGuardians: false,
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...extra,
});

test.describe('school settings', () => {
  test('sends only what changed', async ({ page }) => {
    const requests = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      settings: settingsFixture(),
    });
    await open(page, '/settings');
    const dueDay = page.getByLabel('Fee due day');
    await expect(dueDay).toHaveValue('10');
    await dueDay.selectOption('5');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Settings saved.')).toBeVisible();
    expect(posted(requests, '/school/settings')[0].postDataJSON()).toEqual({ feeDueDay: 5 });

    await page.getByLabel('Students can sign in').check();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(() => posted(requests, '/school/settings').length).toBe(2);
    expect(posted(requests, '/school/settings')[1].postDataJSON()).toEqual({
      studentLoginEnabled: true,
    });
  });

  test('a suspended school shows the banner and keeps working (R80 lifted)', async ({ page }) => {
    const requests = await mockSchoolApi(page, {
      me: { ...PRINCIPAL_ME, school: { ...PRINCIPAL_ME.school, status: 'suspended' } },
      settings: settingsFixture(),
    });
    await open(page, '/settings');
    await expect(page.getByTestId('suspended-banner')).toContainText(
      'This school’s subscription is suspended. Contact the platform.',
    );
    await page.getByLabel('Fee due day').selectOption('12');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Settings saved.')).toBeVisible();
    expect(posted(requests, '/school/settings')[0].postDataJSON()).toEqual({ feeDueDay: 12 });
  });
});
