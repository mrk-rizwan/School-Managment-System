import { expect as baseExpect, test } from '@playwright/test';
import type { PayrollRunDto, PayslipDto } from '../lib/api/school-payroll-contract';
import {
  OFFICE_ME,
  PRINCIPAL_ME,
  STAMP,
  TABLET,
  TEACHER_ME,
  calls,
  expectNoSidewaysScroll,
  mockSchoolApi,
  open,
  page1,
  type Handler,
} from './support/wave-e';

// Payroll (phase-3-financial.md slice 25) against a mocked API: a draft run's review with the
// days behind each count and the skipped staff, an adjustment with an idempotency key, finalise;
// My payslips with the print link; the sidebar entries by role.

const expect = baseExpect.configure({ timeout: 15_000 });
const KEY = /^[A-Za-z0-9_-]{16,64}$/;

const RUN: PayrollRunDto = {
  id: 'r1',
  yearMonth: '2026-09',
  workingDays: 26,
  status: 'draft',
  preparedAt: STAMP,
  preparedByUserId: null,
  finalisedByUserId: null,
  finalisedAt: null,
  finaliseReason: null,
  staffCount: 1,
  skipped: [{ staffId: 'st-x', name: 'Chand Suspended', reason: 'suspended' }],
  totalNet: 42_600,
  unmarkedDaysTotal: 1,
};

const SLIP: PayslipDto = {
  id: 'ps1',
  runId: 'r1',
  yearMonth: '2026-09',
  runStatus: 'draft',
  staffId: 'st-t',
  staffName: 'Rabia Teacher',
  designation: 'Science teacher',
  workingDays: 26,
  employedWorkingDays: 26,
  basic: 52_000,
  lines: [
    { id: 'l1', kind: 'allowance', name: 'House rent', amount: 5_200, adjustsPayslipId: null, reason: null },
    { id: 'l2', kind: 'deduction', name: 'Provident fund', amount: 2_600, adjustsPayslipId: null, reason: null },
    { id: 'l3', kind: 'absence', name: 'Unpaid absence, 6 days', amount: 12_000, adjustsPayslipId: null, reason: null },
  ],
  allowancesTotal: 5_200,
  deductionsTotal: 2_600,
  deductionsNotTaken: [],
  unpaidDays: 6,
  unmarkedDays: 1,
  absenceDeduction: 12_000,
  advanceRecovery: 0,
  adjustmentTotal: 0,
  net: 42_600,
  status: 'pending',
  paidOn: null,
  paidMethod: null,
  paidReference: null,
  days: { unpaid: ['2026-09-02', '2026-09-03'], unmarked: ['2026-09-10'], unapprovedLeave: ['2026-09-03'] },
};

const runHandler: Handler = ({ method, path }) => {
  if (method === 'GET' && path === '/payroll-runs/r1') return { status: 200, body: RUN };
  if (method === 'GET' && path === '/payroll-runs/r1/payslips') return { status: 200, body: page1([SLIP]) };
  return undefined;
};

test('a draft run shows the days behind each count; an adjustment carries a key; finalise', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: runHandler,
    replies: {
      'POST /payslips/ps1/adjust': { status: 200, body: { ...SLIP, adjustmentTotal: 1_500, net: 44_100 } },
      'POST /payroll-runs/r1/finalise': { status: 200, body: { ...RUN, status: 'finalised' } },
    },
  });
  await open(page, '/payroll/r1');
  await expect(page.getByRole('heading', { name: 'Payroll, September 2026' })).toBeVisible();
  const row = page.getByRole('row', { name: /Rabia Teacher/ });
  await expect(row).toContainText('Rs 42,600');
  await expect(row).toContainText('6 unpaid, 1 unmarked');
  await expect(row).toContainText('On leave without approval');
  await expect(page.getByLabel('Skipped')).toContainText('Chand Suspended: Suspended');
  await expect(row.getByRole('link', { name: 'Print' })).toHaveAttribute('href', '/api/v1/payslips/ps1/print');

  await page.getByRole('button', { name: 'Actions for Rabia Teacher' }).click();
  await page.getByRole('menuitem', { name: 'Adjust' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Amount (Rs)').fill('1500');
  await dialog.getByLabel('Shown on the payslip as').fill('Exam duty');
  await dialog.getByLabel('Reason').fill('Invigilation');
  await dialog.getByRole('button', { name: 'Add adjustment' }).click();
  await expect(dialog).toBeHidden();
  const [adjust] = calls(requests, 'POST', '/payslips/ps1/adjust');
  expect(adjust?.headers()['idempotency-key']).toMatch(KEY);
  expect(adjust?.postDataJSON()).toEqual({ amount: 1500, name: 'Exam duty', reason: 'Invigilation' });

  await page.getByRole('button', { name: 'Finalise' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Finalise' }).click();
  await expect.poll(() => calls(requests, 'POST', '/payroll-runs/r1/finalise').length).toBe(1);
});

test('nobody adjusts their own payslip: the menu offers no Adjust on one\'s own row', async ({ page }) => {
  await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: (call) =>
      call.method === 'GET' && call.path === '/payroll-runs/r1/payslips'
        ? { status: 200, body: page1([{ ...SLIP, staffId: PRINCIPAL_ME.staffId ?? '' }]) }
        : runHandler(call),
  });
  await open(page, '/payroll/r1');
  await expect(page.getByRole('row', { name: /Rabia Teacher/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Actions for Rabia Teacher' })).toHaveCount(0);
});

test('My payslips: the salary in force and finalised payslips with their print view', async ({ page }) => {
  await page.setViewportSize(TABLET);
  await mockSchoolApi(page, {
    me: TEACHER_ME,
    handler: ({ method, path }) => {
      if (method === 'GET' && path === '/me/staff/salary-structure') {
        return {
          status: 200,
          body: {
            current: {
              id: 'ss1', staffId: 'st-t', basic: 52_000, components: [{ kind: 'allowance', name: 'House rent', amount: 5_200 }],
              effectiveFrom: '2026-01-01', endedOn: null, status: 'active', supersededBy: null, createdByUserId: 'u-principal',
              reason: 'Appointment terms', selfApproved: false, createdAt: STAMP,
            },
            upcoming: null,
          },
        };
      }
      if (method === 'GET' && path === '/me/staff/payslips') {
        return { status: 200, body: page1([{ ...SLIP, runStatus: 'finalised', days: null, status: 'paid', paidOn: '2026-10-01', paidMethod: 'cash' }]) };
      }
      return undefined;
    },
  });
  await open(page, '/my-payslips');
  await expect(page.getByLabel('My salary')).toContainText('Rs 52,000');
  const card = page.getByTestId('payslip-ps1');
  await expect(card).toContainText('September 2026');
  await expect(card).toContainText('Paid');
  await expect(card).toContainText('Rs 42,600');
  await expect(card.getByRole('link', { name: 'Print' })).toHaveAttribute('href', '/api/v1/me/staff/payslips/ps1/print');
  await expectNoSidewaysScroll(page);
});

test('the sidebar: Payroll for payroll readers only, My payslips for every staff member', async ({ page }) => {
  await mockSchoolApi(page, { me: OFFICE_ME, handler: () => undefined });
  await open(page, '/my-payslips');
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link', { name: 'My payslips' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Payroll' })).toHaveCount(0);
});
