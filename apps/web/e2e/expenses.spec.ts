import { expect as baseExpect, test } from '@playwright/test';
import type { ExpenseDto } from '../lib/api/school-expenses-contract';
import {
  OFFICE_ME,
  PRINCIPAL_ME,
  STAMP,
  TABLET,
  TEACHER_ME,
  TODAY,
  calls,
  errorBody,
  expectNoSidewaysScroll,
  mockSchoolApi,
  open,
  page1,
  type Handler,
} from './support/wave-e';

// Expenses (phase-3-financial.md slice 23) against a mocked API: recording with an idempotency
// key, the threshold outcome, the row menu by role and ownership (R244), reject and void with a
// reason, and the sidebar entry for finance readers only.

const expect = baseExpect.configure({ timeout: 15_000 });
const KEY = /^[A-Za-z0-9_-]{16,64}$/;

const expense = (id: string, extra: Partial<ExpenseDto> = {}): ExpenseDto => ({
  id,
  expenseNo: Number(id.replace(/\D/g, '')) || 1,
  category: 'stationery',
  amount: 450,
  spentOn: TODAY,
  description: 'Chalk and dusters',
  payee: null,
  method: 'cash',
  reference: null,
  hasReceipt: false,
  receiptMime: null,
  status: 'recorded',
  selfApproved: false,
  recordedByUserId: OFFICE_ME.id,
  recordedByName: OFFICE_ME.fullName,
  recordedAt: STAMP,
  decidedByUserId: null,
  decidedAt: null,
  decisionReason: null,
  voidedAt: null,
  voidReason: null,
  updatedAt: STAMP,
  ...extra,
});

const OFFICE_OPEN = expense('e1');
const OFFICE_PENDING = expense('e2', { amount: 9000, status: 'pending_approval', description: 'Generator repair', category: 'repairs' });
const PRINCIPAL_SELF = expense('e3', {
  amount: 7000,
  status: 'approved',
  selfApproved: true,
  recordedByUserId: PRINCIPAL_ME.id,
  recordedByName: PRINCIPAL_ME.fullName,
  decidedByUserId: PRINCIPAL_ME.id,
  decidedAt: STAMP,
  description: 'Printer toner',
});

const listHandler =
  (rows: ExpenseDto[] = [OFFICE_OPEN, OFFICE_PENDING, PRINCIPAL_SELF]): Handler =>
  ({ method, path }) =>
    method === 'GET' && path === '/expenses' ? { status: 200, body: page1(rows) } : undefined;

const menuOf = async (page: import('@playwright/test').Page, no: number) => {
  await page.getByRole('button', { name: `Actions for expense ${no}` }).click();
  return page.getByRole('menu', { name: `Actions for expense ${no}` });
};

test('a clerk records an expense with an idempotency key; above the threshold it waits', async ({ page }) => {
  const pending = expense('e9', { amount: 6000, status: 'pending_approval' });
  const { requests } = await mockSchoolApi(page, {
    me: OFFICE_ME,
    handler: listHandler([OFFICE_OPEN]),
    replies: { 'POST /expenses': { status: 201, body: pending } },
  });
  await open(page, '/expenses');
  await expect(page.getByRole('row', { name: /Chalk and dusters/ })).toContainText('Rs 450');

  await page.getByRole('button', { name: 'Record expense' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Category').selectOption('repairs');
  await dialog.getByLabel('Amount (Rs)').fill('12.5');
  await dialog.getByLabel('What for').fill('Fan repair');
  await dialog.getByRole('button', { name: 'Record expense' }).click();
  await expect(dialog.getByText('Enter whole rupees, 1 or more.')).toBeVisible();
  await dialog.getByLabel('Amount (Rs)').fill('6000');
  await dialog.getByLabel('Paid to (optional)').fill('Ali Electric');
  await dialog.getByRole('button', { name: 'Record expense' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/waits for approval/)).toBeVisible();

  const [post] = calls(requests, 'POST', '/expenses');
  expect(post.headers()['idempotency-key']).toMatch(KEY);
  expect(post.postDataJSON()).toEqual({
    category: 'repairs',
    amount: 6000,
    spentOn: TODAY,
    description: 'Fan repair',
    method: 'cash',
    payee: 'Ali Electric',
  });
});

test('the row menu follows role and ownership: no approving or voiding one’s own (R244)', async ({ page }) => {
  await mockSchoolApi(page, { me: PRINCIPAL_ME, handler: listHandler() });
  await open(page, '/expenses');

  // The clerk's open expense: the principal may neither edit nor void it.
  await expect(page.getByRole('row', { name: /Chalk and dusters/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Actions for expense 1' })).toHaveCount(0);

  // Pending, recorded by someone else: approve and reject.
  let menu = await menuOf(page, 2);
  await expect(menu.getByRole('menuitem', { name: 'Approve' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Reject' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Void' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // The principal's own self-approved expense: void, but no approve.
  await expect(page.getByRole('row', { name: /Rs 7,000/ })).toContainText('Self-approved');
  menu = await menuOf(page, 3);
  await expect(menu.getByRole('menuitem', { name: 'Void' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Approve' })).toHaveCount(0);
});

test('reject needs a reason; a refusal is shown and the list refreshed', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: listHandler(),
    replies: {
      'POST /expenses/e2/reject': {
        status: 409,
        body: errorBody('EXPENSE_NOT_PENDING', 'This expense is not waiting for approval.', { expenseId: 'e2' }),
      },
    },
  });
  await open(page, '/expenses');
  const menu = await menuOf(page, 2);
  await menu.getByRole('menuitem', { name: 'Reject' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill('No bill attached');
  await dialog.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText('This expense is not waiting for approval.')).toBeVisible();
  const [reject] = calls(requests, 'POST', '/expenses/e2/reject');
  expect(reject.postDataJSON()).toEqual({ reason: 'No bill attached', expectedUpdatedAt: STAMP });
});

test('the recorder edits and voids their own open expense', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: OFFICE_ME,
    handler: listHandler([OFFICE_OPEN, OFFICE_PENDING]),
    replies: {
      'PATCH /expenses/e1': { status: 200, body: { ...OFFICE_OPEN, amount: 500 } },
      'POST /expenses/e1/void': { status: 200, body: { ...OFFICE_OPEN, status: 'voided', voidReason: 'Entered twice' } },
    },
  });
  await open(page, '/expenses');
  let menu = await menuOf(page, 1);
  await menu.getByRole('menuitem', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Amount (Rs)').fill('500');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toBeHidden();
  expect(calls(requests, 'PATCH', '/expenses/e1')[0].postDataJSON()).toEqual({ amount: 500 });

  // The clerk holds no expense.approve: no approve on their pending row.
  menu = await menuOf(page, 2);
  await expect(menu.getByRole('menuitem', { name: 'Approve' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  menu = await menuOf(page, 1);
  await menu.getByRole('menuitem', { name: 'Void' }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('Entered twice');
  await page.getByRole('dialog').getByRole('button', { name: 'Void' }).click();
  expect(calls(requests, 'POST', '/expenses/e1/void')[0].postDataJSON()).toEqual({ reason: 'Entered twice' });
});

test('the sidebar shows Expenses to finance readers only; the page fits a tablet', async ({ page }) => {
  await mockSchoolApi(page, { me: TEACHER_ME });
  await open(page, '/students');
  await expect(page.getByRole('link', { name: 'Expenses' })).toHaveCount(0);

  await page.setViewportSize(TABLET);
  await mockSchoolApi(page, { me: OFFICE_ME, handler: listHandler() });
  await open(page, '/expenses');
  await expect(page.getByRole('link', { name: 'Expenses' }).first()).toBeVisible();
  await expectNoSidewaysScroll(page);
});

test('approve sends the version shown; an edit since then is refused and the list reloads', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: listHandler(),
    replies: {
      'POST /expenses/e2/approve': {
        status: 409,
        body: errorBody('CONCURRENT_UPDATE', 'The record changed while this request ran. Reload and try again.'),
      },
    },
  });
  await open(page, '/expenses');
  const lists = () => calls(requests, 'GET', '/expenses').length;
  const before = lists();
  const menu = await menuOf(page, 2);
  await menu.getByRole('menuitem', { name: 'Approve' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('The record changed while this request ran. Reload and try again.')).toBeVisible();
  expect(calls(requests, 'POST', '/expenses/e2/approve')[0].postDataJSON()).toEqual({ expectedUpdatedAt: STAMP });
  await expect.poll(lists).toBeGreaterThan(before);
});
