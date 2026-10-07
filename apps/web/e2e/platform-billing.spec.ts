import { expect as baseExpect, test, type Page, type Request } from '@playwright/test';
import type { components } from '../lib/api/platform';
import { BILLING_STATUS, INVOICES, PLANS, SCHOOL_BILLING } from './support/billing';
import { mockSchoolApi, PRINCIPAL_ME } from './support/wave-e';

// Platform billing screens against a mocked API (contracts/slice-26.md): plans, invoices, a
// school's billing card, and the school's own subscription card on its settings page. Every
// /api/v1/* request is answered in the browser by page.route; no API process runs.

const expect = baseExpect.configure({ timeout: 15_000 });

type Me = components['schemas']['PlatformMeDto'];
type School = components['schemas']['SchoolDto'];

const STAMP = '2026-09-01T05:00:00.000Z';
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
  name: 'Green Valley Higher Secondary School',
  shortCode: 'greenvalley',
  status: 'active',
  timezone: 'Asia/Karachi',
  smsMonthlyCap: 1500,
  whatsappProvider: 'platform_default',
  smsProvider: 'platform_default',
  smsCapOverridden: true,
  terminatedAt: null,
  retentionEndsOn: null,
  createdAt: STAMP,
  updatedAt: STAMP,
};
const SETTINGS = {
  defaultWhatsappProvider: 'waha',
  defaultSmsProvider: 'sendpk',
  enabledWhatsappProviders: ['waha', 'cloud_api'],
  invoiceDueDay: 10,
  graceDays: 15,
  updatedAt: STAMP,
};

const page1 = <T,>(data: T[]) => ({ data, page: 1, limit: 25, total: data.length });
const errorBody = (code: string, message: string, details: unknown = null) => ({
  error: { code, message, details, requestId: 'req-test' },
});

type Reply = { status: number; body: unknown };

/** Answers the platform API; `replies` answer `METHOD /path` first, once each. */
async function mockPlatform(page: Page, replies: Record<string, Reply[]> = {}) {
  const requests: Request[] = [];
  const unmocked: string[] = [];
  await page.route('**/api/v1/platform/**', async (route) => {
    const request = route.request();
    requests.push(request);
    const path = new URL(request.url()).pathname.replace('/api/v1/platform', '');
    const method = request.method();
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const reply = replies[`${method} ${path}`]?.shift();
    if (reply) return json(reply.status, reply.body);
    if (method === 'GET' && path === '/me') return json(200, ME);
    if (method === 'GET' && path === '/plans') return json(200, page1(PLANS));
    if (method === 'GET' && path === '/invoices') return json(200, page1(INVOICES));
    if (method === 'GET' && path === '/settings') return json(200, SETTINGS);
    if (method === 'GET' && path === '/schools/s1') return json(200, SCHOOL);
    if (method === 'GET' && path === '/schools/s1/billing') return json(200, SCHOOL_BILLING);
    unmocked.push(`${method} ${path}`);
    return json(500, errorBody('INTERNAL_ERROR', `Unmocked ${method} ${path}`));
  });
  return { requests, unmocked };
}

const bodyOf = (requests: Request[], method: string, path: string): unknown =>
  requests.find((r) => r.method() === method && new URL(r.url()).pathname === `/api/v1/platform${path}`)?.postDataJSON();

test('plans: lists the bands, creates a plan, and shows an overlapping band on the field', async ({ page }) => {
  const created = { ...PLANS[0], id: 'p3', name: 'Medium school', minStudents: 301, maxStudents: 600 };
  const { requests, unmocked } = await mockPlatform(page, {
    'POST /plans': [
      { status: 409, body: errorBody('PLAN_BAND_OVERLAPS', 'The band overlaps an active plan.', { planId: 'p2' }) },
      { status: 201, body: created },
    ],
  });
  await page.goto('/platform/plans');
  await expect(page.getByRole('heading', { name: 'Plans' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Small school', exact: true })).toBeVisible();
  await expect(page.getByText('0–300 students')).toBeVisible();
  await expect(page.getByText('301+ students')).toBeVisible();
  await expect(page.getByText('Rs 15,000')).toBeVisible();

  await page.getByRole('button', { name: 'New plan' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Medium school');
  await dialog.getByLabel('From (students)').fill('301');
  await dialog.getByLabel('To (students)').fill('600');
  await dialog.getByLabel('Monthly price (Rs)').fill('11000');
  await dialog.getByLabel('SMS a month').fill('2000');
  await dialog.getByRole('button', { name: 'Add plan' }).click();
  await expect(dialog.getByText('This band overlaps an active plan.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Add plan' }).click();
  await expect(page.getByText('Medium school added.')).toBeVisible();
  expect(bodyOf(requests, 'POST', '/plans')).toEqual({
    name: 'Medium school',
    minStudents: 301,
    maxStudents: 600,
    monthlyPrice: 11000,
    smsAllowance: 2000,
  });
  expect(unmocked).toEqual([]);
});

test('plans: an edit sends only the changed field; saving with no change sends nothing', async ({ page }) => {
  const { requests, unmocked } = await mockPlatform(page, {
    'PATCH /plans/p1': [{ status: 200, body: { ...PLANS[0], monthlyPrice: 9000 } }],
  });
  await page.goto('/platform/plans');
  const edit = async () => {
    await page.getByRole('button', { name: 'Actions for Small school' }).click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    return page.getByRole('dialog', { name: 'Edit Small school' });
  };
  const patches = () =>
    requests.filter((r) => r.method() === 'PATCH' && new URL(r.url()).pathname === '/api/v1/platform/plans/p1').map((r) => r.postDataJSON());

  let dialog = await edit();
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toBeHidden();
  expect(patches()).toEqual([]);

  dialog = await edit();
  await dialog.getByLabel('Monthly price (Rs)').fill('9000');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toBeHidden();
  expect(patches()).toEqual([{ monthlyPrice: 9000 }]);
  expect(unmocked).toEqual([]);
});

test('invoices: the eligibility filter, a full payment, a void with its reason, and issuing a month', async ({ page }) => {
  const { requests, unmocked } = await mockPlatform(page, {
    'POST /invoices/i1/record-payment': [{ status: 200, body: { ...INVOICES[0], status: 'paid', paidAt: STAMP } }],
    'POST /invoices/i1/void': [{ status: 200, body: { ...INVOICES[0], status: 'void', voidedAt: STAMP } }],
    'POST /invoices/issue-month': [
      { status: 200, body: { issued: 3, existing: 1, skipped: [{ schoolId: 's9', reason: 'no_band' }], failed: 0 } },
    ],
  });
  await page.goto('/platform/invoices');
  await expect(page.getByRole('heading', { name: 'Invoices' })).toBeVisible();
  await expect(page.getByText('INV-2026-00012')).toBeVisible();
  await expect(page.getByRole('table').getByText('Eligible for suspension')).toBeVisible();

  await page.getByLabel('Suspension').selectOption('eligible');
  await expect
    .poll(() => requests.some((r) => new URL(r.url()).searchParams.get('suspensionEligible') === 'true'))
    .toBe(true);
  await page.getByLabel('Suspension').selectOption('');

  await page.getByRole('button', { name: 'Actions for INV-2026-00012' }).click();
  await page.getByRole('menuitem', { name: 'Record payment' }).click();
  const pay = page.getByRole('dialog');
  await pay.getByLabel('Reference').fill('HBL-778812');
  await pay.getByRole('button', { name: 'Record Rs 8,000' }).click();
  await expect(page.getByText('INV-2026-00012 marked paid.')).toBeVisible();
  expect(bodyOf(requests, 'POST', '/invoices/i1/record-payment')).toMatchObject({ amount: 8000, reference: 'HBL-778812' });

  await page.getByRole('button', { name: 'Actions for INV-2026-00012' }).click();
  await page.getByRole('menuitem', { name: 'Void' }).click();
  const voidDialog = page.getByRole('dialog');
  await voidDialog.getByLabel('Reason').fill('Billed in error');
  await voidDialog.getByRole('button', { name: 'Void invoice' }).click();
  await expect(page.getByText(/INV-2026-00012 voided/)).toBeVisible();
  expect(bodyOf(requests, 'POST', '/invoices/i1/void')).toEqual({ reason: 'Billed in error' });

  await page.getByRole('button', { name: 'Issue month' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Issue invoices' }).click();
  await expect(page.getByText('3 new invoices; 1 already invoiced.')).toBeVisible();
  await expect(page.getByText('no plan band holds its student count')).toBeVisible();
  expect(unmocked).toEqual([]);
});

test('school billing card: plan from count, a hand-set SMS limit cleared, and pinning to a plan', async ({ page }) => {
  const pinned = {
    ...SCHOOL_BILLING.subscription,
    id: 'sub2',
    planId: 'p2',
    planName: 'Large school',
    pinned: true,
    assignedByPlatform: true,
    reason: 'Negotiated rate',
  };
  const { requests, unmocked } = await mockPlatform(page, {
    'POST /schools/s1/use-plan-allowance': [
      { status: 200, body: { ...SCHOOL_BILLING, smsCap: { value: 1000, overridden: false } } },
    ],
    'POST /schools/s1/assign-plan': [{ status: 200, body: pinned }],
  });
  await page.goto('/platform/schools/s1');
  await expect(page.getByText('Billing', { exact: true })).toBeVisible();
  await expect(page.getByText('From count')).toBeVisible();
  await expect(page.getByText('245', { exact: true })).toBeVisible();
  await expect(page.getByText('Set by hand')).toBeVisible();

  await page.getByRole('button', { name: 'Use the plan’s allowance' }).click();
  await expect(page.getByText('The SMS limit now follows the plan: 1,000 a month.')).toBeVisible();

  await page.getByRole('button', { name: 'Pin to a plan' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Plan').selectOption('p2');
  await dialog.getByLabel('Reason').fill('Negotiated rate');
  await dialog.getByRole('button', { name: 'Pin to plan' }).click();
  await expect(page.getByText(/is pinned to Large school/)).toBeVisible();
  expect(bodyOf(requests, 'POST', '/schools/s1/assign-plan')).toMatchObject({ planId: 'p2', reason: 'Negotiated rate' });
  expect(unmocked).toEqual([]);
});

test("the school's settings page shows its subscription and an overdue invoice", async ({ page }) => {
  await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: ({ path }) => {
      if (path === '/school/billing-status') {
        return { status: 200, body: { ...BILLING_STATUS, overdue: true } };
      }
      return undefined;
    },
  });
  await page.goto('/settings');
  await expect(page.getByText('ASMS subscription')).toBeVisible();
  await expect(page.getByText('Small school')).toBeVisible();
  await expect(page.getByText('An invoice is overdue.')).toBeVisible();
  await expect(page.getByText(/INV-2026-00012, October 2026, due/)).toBeVisible();
});
