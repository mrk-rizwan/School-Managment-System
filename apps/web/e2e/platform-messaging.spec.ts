import { expect as baseExpect, test, type Page, type Request } from '@playwright/test';
import type { components } from '../lib/api/platform';
import type {
  PlatformDeliveryHealthDto,
  PlatformSettingsDto,
  SchoolDto,
} from '../lib/api/platform-messaging-contract';

// Platform delivery health, the school's messaging knobs and platform settings
// (contracts/slice-9.md §6, §14) against a mocked API answered in the browser.

const expect = baseExpect.configure({ timeout: 15_000 });
const STAMP = '2026-09-01T05:00:00.000Z';

const FULL_ME: components['schemas']['PlatformMeDto'] = {
  id: '1',
  email: 'admin@example.test',
  sessionStage: 'full',
  totpEnrolled: true,
  mustChangePassword: false,
  sessionExpiresAt: '2026-10-02T20:00:00.000Z',
};

const SCHOOL: SchoolDto = {
  id: 's1',
  name: 'Green Valley School',
  shortCode: 'greenvalley',
  status: 'active',
  timezone: 'Asia/Karachi',
  createdAt: STAMP,
  updatedAt: STAMP,
  smsMonthlyCap: 500,
  whatsappProvider: 'platform_default',
  smsProvider: 'platform_default',
  smsCapOverridden: false,
  terminatedAt: null,
  retentionEndsOn: null,
};

const counts = (channel: 'push' | 'whatsapp' | 'sms' | 'email', accepted = 0, failed = 0, suppressed = 0) => ({
  channel,
  accepted,
  delivered: Math.max(accepted - failed, 0),
  failed,
  suppressed,
});
const HEALTH: PlatformDeliveryHealthDto = {
  schoolId: 's1',
  name: 'Green Valley School',
  shortCode: 'greenvalley',
  schoolStatus: 'suspended',
  whatsapp: { status: 'down', lastHealthyAt: '2026-10-03T04:00:00.000Z', lastErrorCode: 'logged_out' },
  today: [counts('push'), counts('whatsapp', 1200, 14), counts('sms', 80, 2, 9), counts('email')],
  yesterday: [counts('push'), counts('whatsapp'), counts('sms'), counts('email')],
  sms: { used: 500, cap: 500 },
  computedAt: '2026-10-04T05:00:00.000Z',
};

const errorBody = (code: string, message: string, details: unknown = null) => ({
  error: { code, message, details, requestId: 'req-test' },
});

type Reply = { status: number; body: unknown };
type MockState = {
  school: SchoolDto;
  settings: PlatformSettingsDto;
  health: PlatformDeliveryHealthDto[];
  replies?: Record<string, Reply[]>;
};

async function mockApi(page: Page, state: MockState) {
  const requests: Request[] = [];
  await page.route('**/api/v1/platform/**', async (route) => {
    const request = route.request();
    requests.push(request);
    const path = new URL(request.url()).pathname.replace('/api/v1/platform', '');
    const method = request.method();
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const reply = state.replies?.[`${method} ${path}`]?.shift();
    if (reply) return json(reply.status, reply.body);
    if (method === 'GET' && path === '/me') return json(200, FULL_ME);
    if (path === '/settings') {
      if (method === 'PATCH') Object.assign(state.settings, request.postDataJSON(), { updatedAt: new Date().toISOString() });
      return json(200, state.settings);
    }
    if (method === 'GET' && path === '/messaging/health') {
      return json(200, { data: state.health, page: 1, limit: 25, total: state.health.length });
    }
    if (method === 'POST' && path === '/schools/s1/change-status') {
      const { status } = request.postDataJSON() as { status: SchoolDto['status'] };
      Object.assign(state.school, { status, updatedAt: new Date().toISOString() });
      return json(200, state.school);
    }
    if (path === '/schools/s1') {
      if (method === 'PATCH') Object.assign(state.school, request.postDataJSON(), { updatedAt: new Date().toISOString() });
      return json(200, state.school);
    }
    return json(500, errorBody('INTERNAL_ERROR', `Unmocked ${method} ${path}`));
  });
  return requests;
}

const state = (extra: Partial<MockState> = {}): MockState => ({
  school: { ...SCHOOL },
  settings: { defaultWhatsappProvider: 'waha', defaultSmsProvider: 'sendpk', enabledWhatsappProviders: ['waha', 'cloud_api'], invoiceDueDay: 10, graceDays: 15, updatedAt: STAMP },
  health: [HEALTH],
  ...extra,
});

async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
}

const calls = (requests: Request[], method: string, path: string) =>
  requests.filter((r) => r.method() === method && new URL(r.url()).pathname === `/api/v1/platform${path}`);

test('delivery health: per-school rollup, filters and sort reach the query', async ({ page }) => {
  const requests = await mockApi(page, state());
  await open(page, '/platform/messaging');
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link', { name: 'Delivery health' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link', { name: 'Platform settings' })).toBeVisible();

  const row = page.getByRole('row').filter({ hasText: 'Green Valley School' });
  await expect(row).toContainText('Down');
  await expect(row).toContainText('logged_out');
  await expect(row).toContainText('WhatsApp 1200 sent');
  await expect(row).toContainText('14 failed');
  await expect(row).toContainText('9 held');
  await expect(row).toContainText('500 / 500');
  await expect(row).toContainText('Suspended');
  // Yesterday had no traffic.
  await expect(row.getByText('None')).toBeVisible();

  await page.getByLabel('WhatsApp').selectOption('down');
  await page.getByLabel('Sort').selectOption('-failedToday');
  await page.getByLabel('School status').selectOption('suspended');
  await expect
    .poll(() => {
      const last = calls(requests, 'GET', '/messaging/health').at(-1);
      return last ? Object.fromEntries(new URL(last.url()).searchParams) : {};
    })
    .toMatchObject({ whatsappStatus: 'down', sort: '-failedToday', schoolStatus: 'suspended', page: '1' });
});

test('delivery health: empty and failed states', async ({ page }) => {
  await mockApi(
    page,
    state({
      health: [],
      replies: {
        'GET /messaging/health': Array.from({ length: 3 }, () => ({
          status: 500,
          body: errorBody('INTERNAL_ERROR', 'The server failed.'),
        })),
      },
    }),
  );
  await open(page, '/platform/messaging');
  await expect(page.getByText('Something went wrong')).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('No schools yet')).toBeVisible();
});

test('school detail: messaging knobs send only what changed; a refused cap lands on its field', async ({ page }) => {
  const requests = await mockApi(
    page,
    state({
      replies: {
        'PATCH /schools/s1': [
          {
            status: 422,
            body: errorBody('VALIDATION_FAILED', 'Invalid.', {
              fields: [{ path: 'smsMonthlyCap', code: 'INVALID_VALUE', message: 'The cap is too high for this plan.' }],
            }),
          },
        ],
      },
    }),
  );
  await open(page, '/platform/schools/s1');
  const card = page.locator('[data-slot="card"]').filter({ hasText: 'Monthly SMS limit' });
  await expect(card.getByLabel('WhatsApp provider').locator('option[value="platform_default"]')).toHaveText(
    'Platform default (now WAHA (QR pairing))',
  );
  await card.getByLabel('Monthly SMS limit').fill('200000');
  await card.getByRole('button', { name: 'Save messaging' }).click();
  await expect(card.getByText('Enter a whole number from 0 to 100,000.')).toBeVisible();

  await card.getByLabel('Monthly SMS limit').fill('2000');
  await card.getByLabel('WhatsApp provider').selectOption('cloud_api');
  await card.getByRole('button', { name: 'Save messaging' }).click();
  await expect(card.getByText('The cap is too high for this plan.')).toBeVisible();
  await card.getByRole('button', { name: 'Save messaging' }).click();
  await expect(page.getByText('Messaging settings saved.')).toBeVisible();
  expect(calls(requests, 'PATCH', '/schools/s1').map((r) => r.postDataJSON())).toEqual([
    { smsMonthlyCap: 2000, whatsappProvider: 'cloud_api' },
    { smsMonthlyCap: 2000, whatsappProvider: 'cloud_api' },
  ]);
});

async function suspend(page: Page, zeroSms: boolean) {
  await open(page, '/platform/schools/s1');
  await page.getByRole('button', { name: 'Change status' }).click();
  await page.getByRole('menuitem', { name: 'Suspend' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('The school keeps working; a banner is shown');
  const box = dialog.getByLabel('Also set this school’s SMS allowance to 0');
  await expect(box).toBeChecked();
  await expect(dialog).toContainText('Now 500 a month.');
  if (!zeroSms) await box.uncheck();
  await dialog.getByLabel('Reason').fill('Subscription unpaid.');
  await dialog.getByRole('button', { name: 'Suspend' }).click();
  await expect(dialog).toBeHidden();
}

test('suspend: the SMS allowance is set to 0 after the status change, by default', async ({ page }) => {
  const requests = await mockApi(page, state());
  await suspend(page, true);
  await expect(page.getByText('Green Valley School is now suspended. Its SMS allowance is 0.')).toBeVisible();
  expect(calls(requests, 'POST', '/schools/s1/change-status').map((r) => r.postDataJSON())).toEqual([
    { status: 'suspended', reason: 'Subscription unpaid.' },
  ]);
  expect(calls(requests, 'PATCH', '/schools/s1').map((r) => r.postDataJSON())).toEqual([{ smsMonthlyCap: 0 }]);
  // The status change went first.
  const order = requests.filter((r) => r.method() !== 'GET').map((r) => r.method());
  expect(order).toEqual(['POST', 'PATCH']);
  await expect(page.getByLabel('Monthly SMS limit')).toHaveValue('0');
});

test('suspend: unticked, the SMS allowance is left alone', async ({ page }) => {
  const requests = await mockApi(page, state());
  await suspend(page, false);
  await expect(page.getByText('Green Valley School is now suspended.', { exact: true })).toBeVisible();
  expect(calls(requests, 'POST', '/schools/s1/change-status')).toHaveLength(1);
  expect(calls(requests, 'PATCH', '/schools/s1')).toHaveLength(0);
  await expect(page.getByLabel('Monthly SMS limit')).toHaveValue('500');
});

test('suspend: a refused allowance change leaves the suspension and says so', async ({ page }) => {
  const requests = await mockApi(
    page,
    state({
      replies: {
        'PATCH /schools/s1': [{ status: 503, body: errorBody('SERVICE_UNAVAILABLE', 'Try again shortly.') }],
      },
    }),
  );
  await suspend(page, true);
  await expect(
    page.getByText('Green Valley School is now suspended. The SMS allowance was not changed: Try again shortly.'),
  ).toBeVisible();
  expect(calls(requests, 'PATCH', '/schools/s1')).toHaveLength(1);
  await expect(page.locator('dl').first()).toContainText('Suspended');
});

test('platform settings: the defaults change for every school on platform default', async ({ page }) => {
  const requests = await mockApi(page, state());
  await open(page, '/platform/settings');
  await expect(page.getByText('Applies to every school on platform default, at once.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await page.getByLabel('Default WhatsApp provider').selectOption('cloud_api');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Platform settings saved.')).toBeVisible();
  expect(calls(requests, 'PATCH', '/settings')[0].postDataJSON()).toEqual({ defaultWhatsappProvider: 'cloud_api' });
});

test('platform settings and school knobs: a WhatsApp provider switched off on this server cannot be chosen', async ({ page }) => {
  await mockApi(
    page,
    state({
      settings: {
        defaultWhatsappProvider: 'waha',
        defaultSmsProvider: 'sendpk',
        enabledWhatsappProviders: ['waha'],
        invoiceDueDay: 10,
        graceDays: 15,
        updatedAt: STAMP,
      },
    }),
  );
  await open(page, '/platform/settings');
  const cloud = page.getByLabel('Default WhatsApp provider').locator('option[value="cloud_api"]');
  await expect(cloud).toBeDisabled();
  await expect(cloud).toContainText('switched off on this server');
  await expect(page.getByLabel('Default WhatsApp provider').locator('option[value="waha"]')).toBeEnabled();

  await open(page, `/platform/schools/${SCHOOL.id}`);
  await expect(page.getByLabel('WhatsApp provider').locator('option[value="cloud_api"]')).toBeDisabled();
  await expect(page.getByLabel('WhatsApp provider').locator('option[value="platform_default"]')).toBeEnabled();
});
