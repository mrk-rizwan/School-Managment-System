import { expect as baseExpect, test, type Page, type Request } from '@playwright/test';
import type { components } from '../lib/api/platform';

// Platform console screens against a mocked API (contracts/slice-1.md §8). Every
// /api/v1/platform/* request is answered in the browser by page.route; no API process runs.

// The suite runs on `next dev`, which compiles each route on first visit: a navigation on a cold
// server can take several seconds, so assertions wait longer than the 5 s default.
const expect = baseExpect.configure({ timeout: 15_000 });

// Mock payloads use the generated response types, so they cannot drift from the real API.
type Me = components['schemas']['PlatformMeDto'];
type School = components['schemas']['SchoolDto'];

const FULL_ME: Me = {
  id: '1',
  email: 'admin@example.test',
  sessionStage: 'full',
  totpEnrolled: true,
  mustChangePassword: false,
  sessionExpiresAt: '2026-10-02T20:00:00.000Z',
};
const ENROLMENT_ME: Me = { ...FULL_ME, sessionStage: 'totp_enrolment', totpEnrolled: false };

const school = (id: string, name: string, status: School['status']): School => ({
  id,
  name,
  shortCode: name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 8),
  status,
  timezone: 'Asia/Karachi',
  smsMonthlyCap: 500,
  whatsappProvider: 'platform_default',
  smsProvider: 'platform_default',
  createdAt: '2026-09-01T05:00:00.000Z',
  updatedAt: '2026-09-01T05:00:00.000Z',
});

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

function errorBody(code: string, message: string) {
  return { error: { code, message, details: null, requestId: 'req-test' } };
}

type MockState = {
  /** null: no session, GET /me answers 401. */
  me: Me | null;
  loginResult?: Me;
  schools: School[];
  /** When set, GET /schools answers 401 (a session that died mid-use). */
  schoolsUnauthorized?: boolean;
};

async function mockPlatformApi(page: Page, state: MockState) {
  const requests: Request[] = [];
  await page.route('**/api/v1/platform/**', async (route) => {
    const request = route.request();
    requests.push(request);
    const path = new URL(request.url()).pathname.replace('/api/v1/platform', '');
    const method = request.method();
    const json = (status: number, body?: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: body === undefined ? '' : JSON.stringify(body),
      });
    const unauthorized = () => json(401, errorBody('AUTH_REQUIRED', 'Sign in to continue.'));

    if (method === 'POST' && path === '/auth/login') {
      state.me = state.loginResult ?? FULL_ME;
      return json(200, state.me);
    }
    if (!state.me) return unauthorized();
    if (method === 'GET' && path === '/me') return json(200, state.me);
    if (method === 'POST' && path === '/auth/logout') {
      state.me = null;
      return route.fulfill({ status: 204 });
    }
    if (method === 'POST' && path === '/auth/totp/enrol') {
      return json(200, {
        otpauthUri: `otpauth://totp/ASMS%20Platform:${state.me.email}?secret=${SECRET}&issuer=ASMS%20Platform&algorithm=SHA1&digits=6&period=30`,
        secret: SECRET,
      });
    }
    if (method === 'GET' && path === '/schools') {
      if (state.schoolsUnauthorized) return unauthorized();
      return json(200, { data: state.schools, page: 1, limit: 25, total: state.schools.length });
    }
    const detail = path.match(/^\/schools\/([^/]+)(\/change-status)?$/);
    const found = detail && state.schools.find((s) => s.id === detail[1]);
    if (detail && !found) return json(404, errorBody('NOT_FOUND', 'Not found.'));
    if (found && method === 'GET' && !detail[2]) return json(200, found);
    if (found && method === 'POST' && detail[2]) {
      const { status } = request.postDataJSON() as { status: School['status'] };
      found.status = status;
      found.updatedAt = new Date().toISOString();
      return json(200, found);
    }
    return json(500, errorBody('INTERNAL_ERROR', `Unmocked ${method} ${path}`));
  });
  return requests;
}

/**
 * Opens the login page and waits until it has hydrated. Under `next dev` a cold route can take
 * seconds to compile; a click before hydration would submit the form natively (method="post")
 * and reload the page instead of calling the API.
 */
async function openLogin(page: Page) {
  await page.goto('/platform/login');
  await page.waitForLoadState('networkidle');
}

const isChangeStatus = (r: Request) => r.url().endsWith('/change-status');

test('login with a code lands on the school list, which shows the rows', async ({ page }) => {
  const requests = await mockPlatformApi(page, {
    me: null,
    schools: [school('s1', 'Green Valley School', 'active'), school('s2', 'Iqbal Academy', 'trial')],
  });

  await openLogin(page);
  await page.getByLabel('Email').fill('admin@example.test');
  await page.getByLabel('Password', { exact: true }).fill('correct horse battery');
  await page.getByLabel(/Authenticator code/).fill('123456');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/platform\/schools$/);
  const table = page.getByRole('table');
  await expect(table.getByRole('link', { name: 'Green Valley School' })).toBeVisible();
  await expect(table.getByRole('link', { name: 'Iqbal Academy' })).toBeVisible();
  // 1 header row + 2 school rows.
  await expect(table.getByRole('row')).toHaveCount(3);

  const login = requests.find((r) => r.url().endsWith('/auth/login'));
  expect(login?.postDataJSON()).toEqual({
    email: 'admin@example.test',
    password: 'correct horse battery', // pragma: allowlist secret
    totpCode: '123456',
  });
});

test('first sign-in goes to enrolment, which draws the QR in the browser', async ({ page }) => {
  const requests = await mockPlatformApi(page, {
    me: null,
    loginResult: ENROLMENT_ME,
    schools: [],
  });

  await openLogin(page);
  await page.getByLabel('Email').fill('admin@example.test');
  await page.getByLabel('Password', { exact: true }).fill('the seeded password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/platform\/enrol$/);
  // Nothing is minted until the button is pressed.
  expect(requests.some((r) => r.url().endsWith('/totp/enrol'))).toBe(false);
  await page.getByRole('button', { name: 'Set up authenticator' }).click();

  const qr = page.getByRole('img', { name: 'QR code for your authenticator app' });
  await expect(qr).toBeVisible();
  expect(await qr.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  await expect(page.getByTestId('totp-secret')).toHaveText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
  await expect(page.getByLabel('Authenticator code')).toBeVisible();
});

test('a suspended school offers only Activate and Terminate', async ({ page }) => {
  await mockPlatformApi(page, {
    me: FULL_ME,
    schools: [school('s1', 'Green Valley School', 'suspended')],
  });

  await page.goto('/platform/schools/s1');
  await expect(page.getByRole('heading', { name: 'Green Valley School' })).toBeVisible();
  await page.getByRole('button', { name: 'Change status' }).click();
  const items = page.getByRole('menuitem');
  await expect(items).toHaveText(['Activate', 'Terminate']);
});

test('a terminated school offers no status change and a frozen form', async ({ page }) => {
  await mockPlatformApi(page, {
    me: FULL_ME,
    schools: [school('s1', 'Green Valley School', 'terminated')],
  });

  await page.goto('/platform/schools/s1');
  await expect(page.getByRole('heading', { name: 'Green Valley School' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change status' })).toHaveCount(0);
  await expect(page.getByLabel('School name')).toBeDisabled();
});

test('terminate is sent only after the second, final confirmation', async ({ page }) => {
  const requests = await mockPlatformApi(page, {
    me: FULL_ME,
    schools: [school('s1', 'Green Valley School', 'active')],
  });

  await page.goto('/platform/schools/s1');
  await page.getByRole('button', { name: 'Change status' }).click();
  await page.getByRole('menuitem', { name: 'Terminate' }).click();
  await page.getByLabel('Reason').fill('Contract ended by the owner.');
  await page.getByRole('button', { name: 'Continue' }).click();

  const final = page.getByRole('dialog', { name: /Terminate Green Valley School permanently/ });
  await expect(final).toBeVisible();
  await expect(final).toContainText('final');
  expect(requests.some(isChangeStatus)).toBe(false);

  await final.getByRole('button', { name: 'Terminate permanently' }).click();
  await expect(final).toBeHidden();
  const sent = requests.filter(isChangeStatus);
  expect(sent).toHaveLength(1);
  expect(sent[0].postDataJSON()).toEqual({
    status: 'terminated',
    reason: 'Contract ended by the owner.',
  });
  // The school is now terminated: no further status action.
  await expect(page.getByRole('button', { name: 'Change status' })).toHaveCount(0);
});

test('no session: the console redirects to the platform login', async ({ page }) => {
  await mockPlatformApi(page, { me: null, schools: [] });
  await page.goto('/platform/schools');
  await expect(page).toHaveURL(/\/platform\/login$/);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('a 401 from a later call redirects to the platform login', async ({ page }) => {
  await mockPlatformApi(page, { me: FULL_ME, schools: [], schoolsUnauthorized: true });
  await page.goto('/platform/schools');
  await expect(page).toHaveURL(/\/platform\/login$/);
});

test('sign out posts logout and returns to the platform login', async ({ page }) => {
  const requests = await mockPlatformApi(page, {
    me: FULL_ME,
    schools: [school('s1', 'Green Valley School', 'active')],
  });
  await page.goto('/platform/schools');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/platform\/login$/);
  expect(requests.some((r) => r.url().endsWith('/auth/logout') && r.method() === 'POST')).toBe(
    true,
  );
});
