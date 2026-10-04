import { Capability, SYSTEM_ROLE_DEFAULTS } from '@asms/shared';
import { expect as baseExpect, test, type Page, type Request } from '@playwright/test';
import type { ApiErrorEnvelope } from '../lib/api/errors';
import type { MeDto } from '../lib/api/school-contract';
import type {
  MessagingUsageDto,
  SchoolSettingsDto,
  WhatsAppNumberDto,
  WhatsAppSettingsDto,
} from '../lib/api/school-messaging-contract';

// School settings (§4.5 fields) and the Messaging settings screen (contracts/slice-9.md §4, §5,
// §14) against a mocked API: every /api/v1/* request is answered in the browser by page.route.

const expect = baseExpect.configure({ timeout: 15_000 });
const STAMP = '2026-10-01T05:00:00.000Z';

const PRINCIPAL_ME: MeDto = {
  id: 'u-principal',
  fullName: 'Amina Principal',
  email: 'amina@example.test',
  hasVerifiedEmail: true,
  passwordIsDefault: false,
  school: { id: 's1', name: 'Green Valley School', shortCode: 'greenvalley', status: 'active' },
  roles: ['principal'],
  capabilities: Object.values(Capability).sort(),
  sessionExpiresAt: '2026-11-02T05:00:00.000Z',
  capacities: ['staff'],
  assignments: [],
  staffId: null,
  children: [],
};
const TEACHER_ME: MeDto = {
  ...PRINCIPAL_ME,
  id: 'u-teacher',
  roles: ['teacher'],
  capabilities: [...SYSTEM_ROLE_DEFAULTS.teacher].sort(),
};

const settings = (extra: Partial<SchoolSettingsDto> = {}): SchoolSettingsDto => ({
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
  updatedAt: STAMP,
  ...extra,
});

const number = (extra: Partial<WhatsAppNumberDto> = {}): WhatsAppNumberDto => ({
  id: 'wn1',
  provider: 'waha',
  phoneMasked: '+9230*****67',
  status: 'connected',
  lastHealthyAt: STAMP,
  lastErrorCode: null,
  inboundIgnoredCount: 0,
  pairedAt: STAMP,
  createdAt: STAMP,
  ...extra,
});

const USAGE: MessagingUsageDto = {
  months: [
    { yearMonth: '2026-10', byChannel: [{ channel: 'sms', count: 500 }, { channel: 'whatsapp', count: 2400 }, { channel: 'push', count: 31 }, { channel: 'email', count: 0 }] },
    { yearMonth: '2026-09', byChannel: [{ channel: 'sms', count: 480 }, { channel: 'whatsapp', count: 9100 }, { channel: 'push', count: 12 }, { channel: 'email', count: 2 }] },
  ],
  cap: 500,
  remaining: 0,
};

const QR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

type ErrorBody = ApiErrorEnvelope['error'];
const errorBody = (code: ErrorBody['code'], message: string, details: ErrorBody['details'] = null) => ({
  error: { code, message, details, requestId: 'req-test' },
});

type Reply = { status: number; body: unknown };
type MockState = {
  me: MeDto;
  settings?: SchoolSettingsDto;
  whatsapp?: WhatsAppSettingsDto;
  /** Answers the matching `METHOD /path` (once each, in order) instead of the default behaviour. */
  replies?: Record<string, Reply | Reply[]>;
};

async function mockApi(page: Page, state: MockState) {
  const requests: Request[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    requests.push(request);
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const method = request.method();
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const canned = state.replies?.[`${method} ${path}`];
    if (canned) {
      const reply = Array.isArray(canned) ? canned.shift() : canned;
      if (reply) return json(reply.status, reply.body);
    }
    if (method === 'GET' && path === '/me') return json(200, state.me);
    if (path === '/school/settings') {
      state.settings ??= settings();
      if (method === 'PATCH') {
        state.settings = { ...state.settings, ...(request.postDataJSON() as object), updatedAt: new Date().toISOString() };
      }
      return json(200, state.settings);
    }
    if (method === 'GET' && path === '/messaging/whatsapp') {
      return json(200, state.whatsapp ?? { effectiveProvider: 'waha', number: null });
    }
    if (method === 'GET' && path === '/messaging/usage') return json(200, USAGE);
    if (method === 'POST' && path === '/messaging/whatsapp/pair') {
      return json(200, { qr: QR, expiresAt: new Date(Date.now() + 45_000).toISOString() });
    }
    if (method === 'POST' && path === '/messaging/whatsapp/connect-cloud-api') {
      state.whatsapp = { effectiveProvider: 'cloud_api', number: number({ provider: 'cloud_api' }) };
      return json(200, state.whatsapp);
    }
    if (method === 'POST' && path === '/messaging/whatsapp/disable') {
      state.whatsapp = { effectiveProvider: state.whatsapp?.effectiveProvider ?? 'waha', number: null };
      return json(200, state.whatsapp);
    }
    if (method === 'POST' && path === '/messaging/test') return json(200, { messageId: 'm-42' });
    return json(500, errorBody('INTERNAL_ERROR', `Unmocked ${method} ${path}`));
  });
  return requests;
}

async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
}

const calls = (requests: Request[], method: string, path: string) =>
  requests.filter((r) => r.method() === method && new URL(r.url()).pathname === `/api/v1${path}`);

// ---- School settings (§4) ----

test('settings: the attendance and remark fields send only what changed; the cut-off is asked for only when it counts', async ({ page }) => {
  const requests = await mockApi(page, { me: PRINCIPAL_ME });
  await open(page, '/settings');

  await expect(page.getByLabel('Cut-off time')).toHaveCount(0);
  await page.getByLabel('Saturday').check();
  await page.getByLabel('Periods per day').selectOption('7');
  await page.getByLabel('A late arrival counts as').selectOption('absent_after_cutoff');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Enter the cut-off time, such as 08:15.')).toBeVisible();
  expect(calls(requests, 'PATCH', '/school/settings')).toHaveLength(0);

  await page.getByLabel('Cut-off time').fill('08:15');
  await page.getByLabel('Who sees a new remark').selectOption('student');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  expect(calls(requests, 'PATCH', '/school/settings')[0].postDataJSON()).toEqual({
    periodsPerDay: 7,
    weeklyOffDays: [0, 6],
    lateCountsAs: 'absent_after_cutoff',
    lateCutoffTime: '08:15',
    remarkDefaultVisibility: 'student',
  });
});

test('settings: every day off is refused; an API 422 lands on its field', async ({ page }) => {
  await mockApi(page, {
    me: PRINCIPAL_ME,
    replies: {
      'PATCH /school/settings': {
        status: 422,
        body: errorBody('VALIDATION_FAILED', 'The request is not valid.', {
          fields: [{ path: 'registerDeadlineTime', code: 'INVALID_VALUE', message: 'Use a time such as 10:00.' }],
        }),
      },
    },
  });
  await open(page, '/settings');
  for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']) await page.getByLabel(day).check();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('At least one day of the week must be a school day.')).toBeVisible();

  await page.getByLabel('Monday').uncheck();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Use a time such as 10:00.')).toBeVisible();
});

// ---- WhatsApp (§5.3–§5.6) ----

test('whatsapp: first WAHA pairing shows a QR and polls until connected, then the QR is gone', async ({ page }) => {
  const state: MockState = { me: PRINCIPAL_ME, whatsapp: { effectiveProvider: 'waha', number: null } };
  const requests = await mockApi(page, state);
  await open(page, '/settings/messaging');

  const pairing = page.getByTestId('qr-pairing');
  await expect(pairing.getByRole('button', { name: 'Show pairing code' })).toBeDisabled();
  await pairing.getByLabel('School’s WhatsApp number').fill('0300 1234567');
  await pairing.getByRole('button', { name: 'Show pairing code' }).click();
  await expect(pairing.getByRole('img', { name: 'WhatsApp pairing code' })).toBeVisible();
  await expect(pairing).toContainText('Code valid for');
  expect(calls(requests, 'POST', '/messaging/whatsapp/pair')[0].postDataJSON()).toEqual({ phone: '0300 1234567' });

  // The health job connects it; the screen sees it on its next poll (every 5 s).
  state.whatsapp = { effectiveProvider: 'waha', number: number() };
  await expect(page.getByTestId('whatsapp-number')).toContainText('Connected');
  await expect(page.getByRole('img', { name: 'WhatsApp pairing code' })).toHaveCount(0);
  await expect(page.getByTestId('qr-pairing')).toHaveCount(0);
});

test('whatsapp: a WAHA outage is refused clearly; a down number pairs again without a phone', async ({ page }) => {
  const requests = await mockApi(page, {
    me: PRINCIPAL_ME,
    whatsapp: { effectiveProvider: 'waha', number: number({ status: 'down', lastErrorCode: 'logged_out' }) },
    replies: {
      'POST /messaging/whatsapp/pair': [{ status: 503, body: errorBody('SERVICE_UNAVAILABLE', 'Unavailable.') }],
    },
  });
  await open(page, '/settings/messaging');
  await expect(page.getByTestId('whatsapp-number')).toContainText('The phone was logged out of WhatsApp.');
  const pairing = page.getByTestId('qr-pairing');
  await expect(pairing.getByLabel('School’s WhatsApp number')).toHaveCount(0);
  await pairing.getByRole('button', { name: 'Show pairing code' }).click();
  await expect(pairing.getByText('The WhatsApp service could not be reached. Try again in a minute.')).toBeVisible();
  await pairing.getByRole('button', { name: 'Show pairing code' }).click();
  await expect(pairing.getByRole('img', { name: 'WhatsApp pairing code' })).toBeVisible();
  expect(calls(requests, 'POST', '/messaging/whatsapp/pair')[1].postDataJSON()).toEqual({});
});

test('whatsapp: Cloud API connect explains a refused token and never keeps the token', async ({ page }) => {
  const requests = await mockApi(page, {
    me: PRINCIPAL_ME,
    whatsapp: { effectiveProvider: 'cloud_api', number: null },
    replies: {
      'POST /messaging/whatsapp/connect-cloud-api': [
        {
          status: 409,
          body: errorBody('WHATSAPP_VERIFICATION_FAILED', 'Verification failed.', { reason: 'token_rejected' }),
        },
      ],
    },
  });
  await open(page, '/settings/messaging');
  const form = page.getByTestId('cloud-api-form');
  await form.getByLabel('WhatsApp number').fill('03001234567');
  await form.getByLabel('Phone-number ID').fill('109876543210');
  const token = form.getByLabel('Permanent access token');
  await expect(token).toHaveAttribute('type', 'password');
  await token.fill('EAAG_valid.token-0123456789');
  await form.getByRole('button', { name: 'Connect' }).click();
  await expect(form.getByText(/Meta refused the access token/)).toBeVisible();
  await expect(token).toHaveValue('');

  await token.fill('EAAG_valid.token-0123456789');
  await form.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByTestId('whatsapp-number')).toContainText('WhatsApp Business Cloud API');
  await expect(page.getByTestId('cloud-api-form')).toHaveCount(0);
  expect(calls(requests, 'POST', '/messaging/whatsapp/connect-cloud-api')[1].postDataJSON()).toEqual({
    phone: '03001234567',
    phoneNumberId: '109876543210',
    accessToken: 'EAAG_valid.token-0123456789', // pragma: allowlist secret
  });
});

test('whatsapp: a provider mismatch is explained; disabling asks for a reason', async ({ page }) => {
  const requests = await mockApi(page, {
    me: PRINCIPAL_ME,
    whatsapp: { effectiveProvider: 'waha', number: number({ provider: 'cloud_api' }) },
  });
  await open(page, '/settings/messaging');
  await expect(page.getByTestId('provider-mismatch')).toContainText('The connection method has changed');
  await expect(page.getByTestId('qr-pairing')).toHaveCount(0);

  await page.getByRole('button', { name: 'Disable this number' }).click();
  const dialog = page.getByRole('dialog', { name: 'Disable the WhatsApp number' });
  await expect(dialog.getByRole('button', { name: 'Disable' })).toBeDisabled();
  await dialog.getByLabel('Reason').fill('SIM lost');
  await dialog.getByRole('button', { name: 'Disable' }).click();
  await expect(dialog).toBeHidden();
  expect(calls(requests, 'POST', '/messaging/whatsapp/disable')[0].postDataJSON()).toEqual({ reason: 'SIM lost' });
  await expect(page.getByTestId('qr-pairing')).toBeVisible();
});

// ---- Allow list, usage, test (§4, §5.1, §5.2) ----

test('allow list: six eligible types, the never types disabled, internal types absent; saved in table order', async ({ page }) => {
  const requests = await mockApi(page, { me: PRINCIPAL_ME, whatsapp: { effectiveProvider: 'waha', number: number() } });
  await open(page, '/settings/messaging');
  const card = page.locator('[data-slot="card"]').filter({ hasText: 'What may go by SMS' });
  await expect(card.getByRole('checkbox')).toHaveCount(8);
  await expect(card.getByLabel(/Diary entries/)).toBeDisabled();
  await expect(card.getByLabel(/Teacher remarks/)).toBeDisabled();
  await expect(card.getByText('Unrecorded register reminders')).toHaveCount(0);
  await expect(card.getByText('Test messages')).toHaveCount(0);

  await card.getByLabel(/Late arrival advice/).uncheck();
  await card.getByLabel(/Ordinary announcements/).check();
  await card.getByRole('button', { name: 'Save allow list' }).click();
  await expect(page.getByText('SMS allow list saved.')).toBeVisible();
  expect(calls(requests, 'PATCH', '/school/settings')[0].postDataJSON()).toEqual({
    smsAllowedTypes: ['absence_alert', 'attendance_corrected', 'announcement_urgent', 'announcement_normal', 'holiday_notice'],
  });
});

test('usage and test messages: the cap is read-only; refusals are explained; a sent test shows its reference', async ({ page }) => {
  const requests = await mockApi(page, {
    me: PRINCIPAL_ME,
    whatsapp: { effectiveProvider: 'waha', number: null },
    replies: {
      'POST /messaging/test': [
        { status: 409, body: errorBody('SMS_CAP_EXCEEDED', 'Cap.', { cap: 500, used: 500 }) },
        { status: 409, body: errorBody('WHATSAPP_NUMBER_MISSING', 'Missing.') },
      ],
    },
  });
  await open(page, '/settings/messaging');
  await expect(page.getByTestId('sms-cap')).toContainText('500 · set by the platform');
  await expect(page.getByText('The SMS limit for this month is reached.', { exact: false })).toBeVisible();
  await expect(page.getByRole('cell', { name: '9100' })).toBeVisible();

  await page.getByRole('button', { name: 'Send SMS test' }).click();
  await expect(page.getByText('The monthly SMS limit is reached (500 of 500). A test would go over it.')).toBeVisible();
  await page.getByRole('button', { name: 'Send WhatsApp test' }).click();
  await expect(page.getByText('The school has no WhatsApp number connected. Connect one above first.')).toBeVisible();
  await page.getByRole('button', { name: 'Send app test' }).click();
  await expect(page.getByText('Message reference m-42', { exact: false })).toBeVisible();
  expect(calls(requests, 'POST', '/messaging/test').map((r) => r.postDataJSON())).toEqual([
    { channel: 'sms' },
    { channel: 'whatsapp' },
    { channel: 'push' },
  ]);
});

test('no permission: a teacher has no Messaging entry and the screen says so', async ({ page }) => {
  const requests = await mockApi(page, { me: TEACHER_ME });
  await open(page, '/settings/messaging');
  await expect(page.getByText('You do not have access')).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Messaging' })).toHaveCount(0);
  expect(calls(requests, 'GET', '/messaging/whatsapp')).toHaveLength(0);
});

test('error: a failed load shows the error state with a retry', async ({ page }) => {
  await mockApi(page, {
    me: PRINCIPAL_ME,
    // A 5xx is retried twice before the error shows.
    replies: {
      'GET /messaging/whatsapp': Array.from({ length: 3 }, () => ({
        status: 500,
        body: errorBody('INTERNAL_ERROR', 'The server failed.'),
      })),
    },
  });
  await open(page, '/settings/messaging');
  const card = page.locator('[data-slot="card"]').filter({ hasText: 'Messages to guardians go by WhatsApp first' });
  await expect(card.getByText('Something went wrong')).toBeVisible();
  await card.getByRole('button', { name: 'Try again' }).click();
  await expect(card.getByTestId('qr-pairing')).toBeVisible();
});

test('suspended school: the banner shows on every screen and nothing is turned off', async ({ page }) => {
  await mockApi(page, {
    me: { ...PRINCIPAL_ME, school: { ...PRINCIPAL_ME.school, status: 'suspended' } },
    whatsapp: { effectiveProvider: 'waha', number: number() },
  });
  await open(page, '/settings/messaging');
  await expect(page.getByTestId('suspended-banner')).toContainText('Contact the platform.');
  await expect(page.getByRole('button', { name: 'Send app test' })).toBeEnabled();
});
