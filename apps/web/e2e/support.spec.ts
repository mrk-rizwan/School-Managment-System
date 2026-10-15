import { ErrorCode } from '@asms/shared';
import { expect as baseExpect, test, type Page, type Request } from '@playwright/test';
import type { components } from '../lib/api/platform';
import type { SchoolSettingsDto } from '../lib/api/school-messaging-contract';
import type { SchoolSupportSessionDto } from '../lib/api/school-support-contract';
import { FINANCE_SETTINGS } from './support/settings';
import {
  OFFICE_ME,
  PRINCIPAL_ME,
  TABLET,
  calls,
  errorBody,
  expectNoSidewaysScroll,
  mockSchoolApi,
  open,
  page1,
  type Reply,
} from './support/wave-e';

// Phase 5 slice 45 (rule 40, contracts/slice-45.md): platform support access against a mocked API.
// The platform opens a session from a school's page with a reason, a ticket and a fresh code (a
// used code is shown on its field), reads through the closed set of views, and closes it; a read
// refused because the school revoked it shows the ended state. The school sees the banner on every
// staff page, lists its sessions and revokes one. Loading, empty, error and data states, and a
// tablet width without sideways scroll.

const expect = baseExpect.configure({ timeout: 15_000 });

type Schemas = components['schemas'];
const STAMP = '2026-10-06T05:00:00.000Z';
const ME: Schemas['PlatformMeDto'] = {
  id: '1',
  email: 'admin@example.test',
  sessionStage: 'full',
  totpEnrolled: true,
  mustChangePassword: false,
  sessionExpiresAt: '2026-10-06T20:00:00.000Z',
};
const SCHOOL: Schemas['SchoolDto'] = {
  id: 's1',
  name: 'Green Valley School',
  shortCode: 'greenvalley',
  status: 'active',
  timezone: 'Asia/Karachi',
  smsMonthlyCap: 1500,
  whatsappProvider: 'platform_default',
  smsProvider: 'platform_default',
  smsCapOverridden: false,
  terminatedAt: null,
  retentionEndsOn: null,
  createdAt: STAMP,
  updatedAt: STAMP,
};
const SESSION: Schemas['SupportSessionDto'] = {
  id: 'ss1',
  schoolId: 's1',
  schoolName: 'Green Valley School',
  platformUserId: '1',
  platformUserEmail: 'admin@example.test',
  mine: true,
  reason: 'Fee screen shows a wrong balance',
  ticketRef: 'TCK-1042',
  openedAt: STAMP,
  expiresAt: '2026-10-06T09:00:00.000Z',
  status: 'open',
  closedAt: null,
  endKind: null,
  closeReason: null,
  revokeReason: null,
};
const OTHERS: Schemas['SupportSessionDto'] = {
  ...SESSION,
  id: 'ss2',
  schoolId: 's2',
  schoolName: 'Hill Top School',
  platformUserId: '2',
  platformUserEmail: 'colleague@example.test',
  mine: false,
};
const STUDENT: Schemas['SupportStudentDto'] = {
  id: 'st1',
  admissionNo: '2026-0042',
  fullName: 'Hamza Tariq',
  status: 'active',
  admittedOn: '2026-04-01',
  current: { academicYearName: '2026-27', className: 'Class 5', sectionName: 'A', rollNo: 7 },
  guardians: [
    { id: 'g1', fullName: 'Tariq Mehmood', phone: '+923001234567', relationship: 'father', isPrimaryContact: true, isFeePayer: true },
  ],
};
const CHARGES: Schemas['SupportChargeDto'][] = [
  {
    id: 'c1',
    description: 'Tuition October',
    feeHeadName: 'Tuition',
    period: '2026-10',
    dueOn: '2026-10-10',
    amount: 3000,
    paid: 1000,
    credited: 0,
    outstanding: 2000,
    status: 'open',
  },
];
const PAYMENTS: Schemas['SupportPaymentDto'][] = [
  {
    id: 'p1',
    receivedOn: '2026-10-02',
    method: 'cash',
    amount: 4000,
    forStudent: 4000,
    status: 'verified',
    verifiedAt: STAMP,
    receiptNo: 17,
  },
];
const SETTINGS: Schemas['SupportSchoolSettingsDto'] = {
  schoolId: 's1',
  name: 'Green Valley School',
  shortCode: 'greenvalley',
  status: 'active',
  timezone: 'Asia/Karachi',
  feeDueDay: 10,
  feeCutoffDay: 15,
  lateFeeEnabled: false,
  lateFeeAmount: null,
  lateFeeGraceDays: 7,
  payDay: 1,
  expenseApprovalThreshold: 5000,
  periodsPerDay: 8,
  weeklyOffDays: [0],
  studentLoginEnabled: false,
  lateCountsAs: 'present',
  financialStatementBasis: 'received',
};

/** Answers the platform API: canned replies (`'METHOD /path'`, used in order) first. */
async function mockPlatform(page: Page, replies: Record<string, Reply[]> = {}) {
  const requests: Request[] = [];
  const unmocked: string[] = [];
  await page.route('**/api/v1/platform/**', async (route) => {
    const request = route.request();
    requests.push(request);
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1/platform', '');
    const method = request.method();
    const json = (reply: Reply) =>
      route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.body) });
    const reply = replies[`${method} ${path}`]?.shift();
    if (reply) return json(reply);
    if (method === 'GET' && path === '/me') return json({ status: 200, body: ME });
    if (method === 'GET' && path === '/schools/s1') return json({ status: 200, body: SCHOOL });
    // The school page's other cards (billing, the platform's messaging defaults) are not under test.
    if (method === 'GET' && (path === '/schools/s1/billing' || path === '/settings')) {
      return json({ status: 404, body: errorBody('NOT_FOUND', 'Not found.') });
    }
    if (method === 'GET' && path === '/support-sessions') return json({ status: 200, body: page1([SESSION, OTHERS]) });
    if (method === 'GET' && path === '/support-sessions/ss1') return json({ status: 200, body: SESSION });
    if (method === 'GET' && path === '/support-sessions/ss1/students') return json({ status: 200, body: page1([STUDENT]) });
    if (method === 'GET' && path === '/support-sessions/ss1/students/st1') return json({ status: 200, body: STUDENT });
    if (method === 'GET' && path === '/support-sessions/ss1/students/st1/charges') return json({ status: 200, body: page1(CHARGES) });
    if (method === 'GET' && path === '/support-sessions/ss1/students/st1/payments') return json({ status: 200, body: page1(PAYMENTS) });
    if (method === 'GET' && path === '/support-sessions/ss1/settings') return json({ status: 200, body: SETTINGS });
    unmocked.push(`${method} ${path}`);
    return json({ status: 500, body: errorBody('INTERNAL_ERROR', `Unmocked ${method} ${path}`) });
  });
  return { requests, unmocked };
}

const bodyOf = (requests: Request[], method: string, path: string): unknown =>
  requests.filter((r) => r.method() === method && new URL(r.url()).pathname === `/api/v1/platform${path}`).at(-1)?.postDataJSON();

test('the platform opens access with a fresh code, reads a student and their fees, the settings, and closes it', async ({ page }) => {
  const { requests, unmocked } = await mockPlatform(page, {
    'POST /schools/s1/support-sessions': [
      { status: 409, body: errorBody(ErrorCode.TOTP_INVALID, 'That code is not valid. Try the current one.') },
      { status: 201, body: SESSION },
    ],
    'POST /support-sessions/ss1/close': [{ status: 200, body: { ...SESSION, status: 'ended', endKind: 'closed' } }],
  });
  await page.goto('/platform/schools/s1');
  await page.getByRole('button', { name: 'Open support access' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason (shown to the principals)').fill('Fee screen shows a wrong balance');
  await dialog.getByLabel('Ticket reference').fill('TCK-1042');
  await dialog.getByLabel('Authenticator code').fill('123456');
  await dialog.getByRole('button', { name: 'Open access' }).click();
  await expect(dialog.getByText('That code is not valid, or was already used. Wait for the next one.')).toBeVisible();
  await dialog.getByLabel('Authenticator code').fill('654321');
  await dialog.getByRole('button', { name: 'Open access' }).click();
  // The first visit compiles the route in the dev server.
  await expect(page).toHaveURL(/\/platform\/support\/ss1$/, { timeout: 60_000 });
  expect(bodyOf(requests, 'POST', '/schools/s1/support-sessions')).toEqual({
    reason: 'Fee screen shows a wrong balance',
    ticketRef: 'TCK-1042',
    totp: '654321',
  });

  await expect(page.getByRole('heading', { name: 'Green Valley School' })).toBeVisible();
  // Nothing is read until asked for: every read is audited.
  expect(requests.filter((r) => /\/support-sessions\/ss1\/(students|settings|audit-log)/.test(r.url()))).toHaveLength(0);
  await page.getByLabel('Admission number').fill('2026-0042');
  await page.getByRole('button', { name: 'Find' }).click();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  const student = page.getByTestId('support-student');
  await expect(student.getByText('Hamza Tariq')).toBeVisible();
  await expect(student.getByText(/Tariq Mehmood \(father\) · \+923001234567/)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Charges' }).getByText('Rs 2,000')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Payments' }).getByRole('cell', { name: '17', exact: true })).toBeVisible();
  const search = requests.find((r) => new URL(r.url()).pathname.endsWith('/support-sessions/ss1/students'));
  expect(new URL(search!.url()).searchParams.get('admissionNo')).toBe('2026-0042');

  await page.getByRole('tab', { name: 'School settings' }).click();
  await expect(page.getByTestId('support-settings').getByText('Asia/Karachi')).toBeVisible();

  await page.getByRole('button', { name: 'Close access' }).click();
  await expect(page.getByText('Access to Green Valley School closed.')).toBeVisible();
  expect(unmocked).toEqual([]);
});

test('a read refused because the school revoked the session shows the ended state', async ({ page }) => {
  await mockPlatform(page, {
    'GET /support-sessions/ss1/settings': [
      { status: 403, body: errorBody(ErrorCode.SUPPORT_SESSION_ENDED, 'The support session has ended.', { reason: 'revoked' }) },
    ],
    'GET /support-sessions/ss1': [
      { status: 200, body: SESSION },
      { status: 200, body: { ...SESSION, status: 'ended', endKind: 'revoked', revokeReason: 'Not agreed' } },
    ],
  });
  await page.goto('/platform/support/ss1');
  await page.getByRole('tab', { name: 'School settings' }).click();
  await expect(page.getByText('This session has ended').first()).toBeVisible();
  await expect(page.getByText('Revoked by the school')).toBeVisible();
});

test('the support list: loading, error, empty and data; only the holder reads or closes', async ({ page }) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  let mode: 'error' | 'empty' | 'data' = 'error';
  await page.route('**/api/v1/platform/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/api/v1/platform', '');
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/me') return json(200, ME);
    if (path === '/support-sessions') {
      await held;
      if (mode === 'error') return json(500, errorBody('INTERNAL_ERROR', 'Something went wrong.'));
      if (mode === 'empty') return json(200, page1([]));
      return json(200, page1([SESSION, OTHERS]));
    }
    return json(500, errorBody('INTERNAL_ERROR', 'Unmocked'));
  });
  await page.goto('/platform/support');
  await expect(page.getByRole('heading', { name: 'Support access' })).toBeVisible();
  await expect(page.locator('[data-slot="skeleton"]').first()).toBeVisible();
  release();
  // A 5xx is retried before the error state shows.
  await expect(page.getByRole('button', { name: /try again/i })).toBeVisible({ timeout: 30_000 });
  mode = 'empty';
  await page.getByRole('button', { name: /try again/i }).click();
  await expect(page.getByText('No open support access')).toBeVisible();
  mode = 'data';
  await page.getByLabel('Status').selectOption('');
  await expect(page.getByRole('link', { name: 'Green Valley School' })).toHaveAttribute('href', '/platform/support/ss1');
  // Another admin's session is listed, but neither linked nor closable.
  await expect(page.getByRole('link', { name: 'Hill Top School' })).toHaveCount(0);
  await expect(page.getByText('colleague@example.test')).toBeVisible();
});

// ---- the school --------------------------------------------------------------------------------

const OPEN_FOR_SCHOOL: SchoolSupportSessionDto = {
  id: 'ss1',
  supportName: 'admin@example.test',
  reason: 'Fee screen shows a wrong balance',
  ticketRef: 'TCK-1042',
  openedAt: STAMP,
  expiresAt: '2026-10-06T09:00:00.000Z',
  status: 'open',
  closedAt: null,
  endKind: null,
  revokeReason: null,
};
const ME_SUPPORT = { id: 'ss1', reason: 'Fee screen shows a wrong balance', expiresAt: '2026-10-06T09:00:00.000Z' };

const SCHOOL_SETTINGS: SchoolSettingsDto = {
  ...FINANCE_SETTINGS,
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
  smsAllowedTypes: ['absence_alert'],
  remarkDefaultVisibility: 'guardian',
  remarkNotifyGuardians: false,
  updatedAt: STAMP,
};

const settingsHandler =
  (sessions: () => Reply) =>
  ({ method, path }: { method: string; path: string }): Reply | undefined => {
    if (method === 'GET' && path === '/school/settings') return { status: 200, body: SCHOOL_SETTINGS };
    if (method === 'GET' && path === '/payment-accounts') return { status: 200, body: page1([]) };
    if (method === 'GET' && path === '/school/billing-status') return { status: 404, body: errorBody('NOT_FOUND', 'Not found.') };
    if (method === 'GET' && path === '/school/support-sessions') return sessions();
    return undefined;
  };

test('every staff page carries the support banner; the principal sees what support read and ends the access', async ({ page }) => {
  let revoked = false;
  const { requests } = await mockSchoolApi(page, {
    me: { ...PRINCIPAL_ME, supportSession: ME_SUPPORT },
    handler: settingsHandler(() => ({
      status: 200,
      body: page1([revoked ? { ...OPEN_FOR_SCHOOL, status: 'ended', endKind: 'revoked', revokeReason: 'Not agreed with us' } : OPEN_FOR_SCHOOL]),
    })),
    replies: {
      'POST /school/support-sessions/ss1/revoke': {
        status: 200,
        body: { ...OPEN_FOR_SCHOOL, status: 'ended', endKind: 'revoked', revokeReason: 'Not agreed with us' },
      },
    },
  });
  await open(page, '/settings');
  const banner = page.getByTestId('support-session-banner');
  await expect(banner).toContainText('ASMS support can read this school');
  await expect(banner).toContainText('Fee screen shows a wrong balance');
  await expect(banner.getByRole('link', { name: 'See what support read' })).toHaveAttribute(
    'href',
    '/audit?subjectType=support_session&subjectId=ss1',
  );
  const card = page.getByTestId('support-sessions-card');
  await expect(card.getByText('admin@example.test')).toBeVisible();
  await expect(card.getByRole('link', { name: 'What support read' })).toBeVisible();
  await card.getByRole('button', { name: 'End access now' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/reason/i).fill('Not agreed with us');
  revoked = true;
  await dialog.getByRole('button', { name: 'End access' }).click();
  await expect(page.getByText('Support access ended.')).toBeVisible();
  expect(calls(requests, 'POST', '/school/support-sessions/ss1/revoke')[0]?.postDataJSON()).toEqual({ reason: 'Not agreed with us' });
  await expect(card.getByText('Ended by the school')).toBeVisible();
});

test('office staff see the banner without the audit or revoke links; no session, no banner; tablet width', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await mockSchoolApi(page, { me: { ...OFFICE_ME, supportSession: ME_SUPPORT } });
  await open(page, '/my-attendance');
  const banner = page.getByTestId('support-session-banner');
  await expect(banner).toBeVisible();
  await expect(banner.getByRole('link')).toHaveCount(0);
  await expectNoSidewaysScroll(page);

  await page.unroute('**/api/v1/**');
  await mockSchoolApi(page, { me: { ...OFFICE_ME, supportSession: null } });
  await open(page, '/my-attendance');
  await expect(page.getByRole('heading').first()).toBeVisible();
  await expect(page.getByTestId('support-session-banner')).toHaveCount(0);
});

test('the settings card: empty and error states', async ({ page }) => {
  let fail = true;
  await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: settingsHandler(() =>
      fail ? { status: 500, body: errorBody('INTERNAL_ERROR', 'Something went wrong.') } : { status: 200, body: page1([]) },
    ),
  });
  await open(page, '/settings');
  const card = page.getByTestId('support-sessions-card');
  await expect(card.getByRole('button', { name: /try again/i })).toBeVisible();
  fail = false;
  await card.getByRole('button', { name: /try again/i }).click();
  await expect(card.getByText('No support access yet')).toBeVisible();
});
