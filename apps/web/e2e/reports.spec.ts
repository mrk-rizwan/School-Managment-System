import { expect as baseExpect, test } from '@playwright/test';
import type { ChargeDto } from '../lib/api/school-charges-contract';
import type {
  CollectionsReportDto,
  DailyCashReportDto,
  DefaulterDto,
  DuesClearanceDto,
} from '../lib/api/school-reports-contract';
import type { StudentDetailDto } from '../lib/api/school-students-contract';
import { OFFICE_ME, PRINCIPAL_ME, STAMP, calls, errorBody, mockSchoolApi, open, page1 } from './support/wave-e';

// Finance reports, fee reminders and dues clearance (phase-3-financial.md slice 22) against a
// mocked API: the defaulters list and a reminder send, the collections and daily-cash reports, the
// clearance panel on the student record with the principal's override, and the dues warning in
// the status dialog.

const expect = baseExpect.configure({ timeout: 15_000 });

const defaulter = (studentId: string, studentName: string, extra: Partial<DefaulterDto> = {}): DefaulterDto => ({
  studentId,
  studentName,
  admissionNo: '1001',
  className: 'Class 5',
  sectionName: 'A',
  outstanding: 6000,
  overdue: 3000,
  oldestDueOn: '2026-09-10',
  openCharges: 2,
  feePayer: { name: 'Tariq Mehmood', contactCapability: 'keypad' },
  lastPaymentOn: '2026-08-05',
  lastReminderAt: null,
  pendingClaim: false,
  ...extra,
});

const DEFAULTERS = [
  defaulter('st1', 'Hamza Tariq', { pendingClaim: true }),
  defaulter('st2', 'Hira Khan', { outstanding: 3000, overdue: 0, feePayer: null, lastPaymentOn: null }),
];

const defaultersHandler = ({ method, path }: { method: string; path: string }) =>
  method === 'GET' && path === '/finance-reports/defaulters' ? { status: 200, body: page1(DEFAULTERS) } : undefined;

test.describe('defaulters', () => {
  test('the principal sees the reports entry and the list with its count', async ({ page }) => {
    const { requests } = await mockSchoolApi(page, { me: PRINCIPAL_ME, handler: defaultersHandler });
    await open(page, '/reports');
    await expect(page).toHaveURL(/\/reports\/defaulters$/);
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Finance reports' })).toHaveAttribute('href', '/reports');
    await expect(page.getByText('2 students owing')).toBeVisible();
    const row = page.getByRole('row', { name: /Hamza Tariq/ });
    await expect(row.getByRole('link', { name: 'Hamza Tariq' })).toHaveAttribute('href', '/students/st1');
    await expect(row.getByText('Rs 6,000')).toBeVisible();
    await expect(row.getByText('overdue Rs 3,000')).toBeVisible();
    await expect(row.getByText('Keypad phone')).toBeVisible();
    await expect(row.getByText('Slip to verify')).toBeVisible();
    await expect(page.getByRole('row', { name: /Hira Khan/ }).getByText('None recorded')).toBeVisible();
    expect(new URL(calls(requests, 'GET', '/finance-reports/defaulters')[0].url()).searchParams.get('sort')).toBe('-outstanding');

    await page.getByLabel('Overdue only').check();
    await expect
      .poll(() => calls(requests, 'GET', '/finance-reports/defaulters').some((r) => new URL(r.url()).searchParams.get('overdueOnly') === 'true'))
      .toBe(true);
  });

  test('office staff without finance.report.view see no reports entry and no send button', async ({ page }) => {
    await mockSchoolApi(page, { me: OFFICE_ME, handler: defaultersHandler });
    await open(page, '/reports/defaulters');
    await expect(page.getByText('2 students owing')).toBeVisible();
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Finance reports' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send reminder' })).toHaveCount(0);
  });

  test('selected families are sent a reminder and the result is summarised', async ({ page }) => {
    const { requests } = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      handler: defaultersHandler,
      replies: { 'POST /fee-reminders/send': { status: 200, body: { families: 2, smsUnits: 1, enqueued: 2, capped: 1 } } },
    });
    await open(page, '/reports/defaulters');
    await expect(page.getByRole('button', { name: 'Send reminder' })).toBeDisabled();
    await page.getByLabel('Select Hamza Tariq').check();
    await page.getByLabel('Select Hira Khan').check();
    await expect(page.getByText('2 selected')).toBeVisible();
    await page.getByRole('button', { name: 'Send reminder' }).click();
    const dialog = page.getByRole('dialog', { name: 'Send a fee reminder' });
    await dialog.getByLabel('Due: fees owed, due soon').check();
    await dialog.getByRole('button', { name: 'Send reminder' }).click();
    await expect(page.getByText('2 families reminded; 1 SMS; 1 without SMS (allowance used up)')).toBeVisible();
    await expect(dialog).toBeHidden();
    expect(calls(requests, 'POST', '/fee-reminders/send')[0].postDataJSON()).toEqual({ kind: 'due', studentIds: ['st1', 'st2'] });
    await expect(page.getByText('2 selected')).toHaveCount(0);
  });
});

const collections: CollectionsReportDto = {
  basis: 'received',
  rows: [
    { key: '2026-10-05', label: '5 Oct 2026', amount: 7000, count: 3 },
    { key: '2026-10-06', label: '6 Oct 2026', amount: 3000, count: 1 },
  ],
  total: 10000,
  count: 4,
  refunds: { amount: 500, count: 1 },
  refundReversals: { amount: 200, count: 1 },
  net: 9700,
  voided: { amount: 1500, count: 1 },
  carriedForward: { amount: 800, count: 1 },
  carryForwardReversals: { amount: 300, count: 1 },
};

test.describe('collections', () => {
  test('rows, total, and the refunds, reversals, net, voided, carried-forward and undone lines', async ({ page }) => {
    const { requests } = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      handler: ({ method, path }) =>
        method === 'GET' && path === '/finance-reports/collections' ? { status: 200, body: collections } : undefined,
    });
    await open(page, '/reports/collections');
    await expect(page.getByRole('row', { name: /5 Oct 2026/ })).toContainText('Rs 7,000');
    await expect(page.getByRole('row', { name: /Total/ })).toContainText('Rs 10,000');
    const line = (label: string) => page.locator('dl > div').filter({ hasText: new RegExp(`^${label}`) });
    await expect(line('Refunds paid')).toContainText('-Rs 500');
    await expect(line('Refunds reversed')).toContainText('Rs 200');
    await expect(line('Net')).toContainText('Rs 9,700');
    await expect(line('Voided')).toContainText('Rs 1,500');
    await expect(line('Carried forward from another year')).toContainText('Rs 800');
    await expect(line('Carry-forwards undone')).toContainText('Rs 300');
    const first = new URL(calls(requests, 'GET', '/finance-reports/collections')[0].url()).searchParams;
    expect(Object.fromEntries(first)).toEqual({ receivedFrom: '2026-09-07', receivedTo: '2026-10-06', groupBy: 'day', basis: 'received' });

    await page.getByLabel('Dated by').selectOption('verified');
    await expect
      .poll(() => calls(requests, 'GET', '/finance-reports/collections').some((r) => new URL(r.url()).searchParams.get('basis') === 'verified'))
      .toBe(true);
  });

  test('a range the API refuses shows its sentence', async ({ page }) => {
    await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      handler: ({ method, path }) =>
        method === 'GET' && path === '/finance-reports/collections'
          ? {
              status: 422,
              body: errorBody('VALIDATION_FAILED', 'The request is not valid.', {
                fields: [{ path: 'receivedTo', code: 'INVALID_VALUE', message: 'The range is at most 92 days.' }],
              }),
            }
          : undefined,
    });
    await open(page, '/reports/collections');
    await expect(page.getByText('The range is at most 92 days.')).toBeVisible();
  });
});

test('daily cash: the identity line balances with a check mark', async ({ page }) => {
  const cash: DailyCashReportDto = {
    date: '2026-10-06',
    cashReceived: 10000,
    voidedBeforeHandover: 1000,
    withCollectors: [{ collectorUserId: 'u-office', collector: 'Bilal Office', amount: 4000, since: STAMP }],
    handedOver: [
      {
        handoverId: 'h1',
        status: 'confirmed',
        collector: 'Bilal Office',
        confirmedBy: 'Amina Principal',
        expected: 5000,
        counted: 4800,
        shortfall: 200,
        surplus: 0,
        shortfallResolution: 'written_off',
        fromDay: 5000,
      },
    ],
    voidedAfterHandover: 0,
    refundsPaidCash: 0,
    cashExpenses: 700,
    shortfallWrittenOff: 200,
    salariesPaidCash: 0,
  };
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: ({ method, path }) => (method === 'GET' && path === '/finance-reports/daily-cash' ? { status: 200, body: cash } : undefined),
  });
  await open(page, '/reports/daily-cash');
  const identity = page.getByTestId('cash-identity');
  await expect(identity).toContainText('Rs 10,000 − Rs 1,000 = Rs 4,000 with collectors + Rs 5,000 handed over');
  await expect(identity).toContainText('(balances)');
  await expect(page.getByText('short Rs 200, written off')).toBeVisible();
  expect(new URL(calls(requests, 'GET', '/finance-reports/daily-cash')[0].url()).searchParams.get('date')).toBe('2026-10-06');
});

// ---- The student record ----

const STUDENT: StudentDetailDto = {
  id: 'st1',
  admissionNo: '1001',
  fullName: 'Hamza Tariq',
  gender: 'male',
  dateOfBirth: '2016-05-04',
  hasBForm: true,
  bFormMasked: '35202-*****-3',
  status: 'active',
  admittedOn: '2025-04-01',
  current: {
    enrolmentId: 'e1',
    academicYearId: 'y1',
    academicYearName: '2026-27',
    classId: 'c5',
    className: 'Class 5',
    sectionId: 'sec-a',
    sectionName: 'A',
    rollNo: 7,
  },
  userId: null,
  createdAt: STAMP,
  updatedAt: STAMP,
  notes: null,
  photoDocumentId: null,
};

const openCharge: ChargeDto = {
  id: 'c1',
  studentId: 'st1',
  studentName: 'Hamza Tariq',
  admissionNo: '1001',
  enrolmentId: 'e0',
  className: 'Class 4',
  sectionName: 'B',
  academicYearId: 'y0',
  feeHeadId: 'fh1',
  feeHeadName: 'Tuition',
  kind: 'generated',
  period: '2026-03',
  campaignId: null,
  lateFeeForChargeId: null,
  adjustsChargeId: null,
  concessionId: null,
  grossAmount: 3000,
  concessionAmount: 0,
  amount: 3000,
  allocatedAmount: 0,
  creditedAmount: 0,
  outstanding: 3000,
  description: 'Tuition March 2026',
  dueOn: '2026-03-10',
  status: 'open',
  settledAt: null,
  voidedAt: null,
  voidReason: null,
  waivedAt: null,
  waiveReason: null,
  createdByUserId: null,
  createdAt: STAMP,
};

const owing: DuesClearanceDto = { studentId: 'st1', outstanding: 3000, openCharges: [openCharge], advance: 0, cleared: false, override: null };

const studentHandler = ({ method, path }: { method: string; path: string }) => {
  if (method !== 'GET') return undefined;
  if (path === '/students/st1') return { status: 200, body: STUDENT };
  if (path === '/school/settings') return { status: 200, body: { feeDueDay: 10, studentLoginEnabled: true, updatedAt: STAMP } };
  if (path === '/students/st1/fee-statement') {
    return {
      status: 200,
      body: {
        totals: { charged: 3000, concession: 0, adjustments: 0, paid: 0, outstanding: 3000, advance: 0 },
        charges: page1([]),
        payments: [],
        adjustments: [],
        concessions: [],
      },
    };
  }
  return undefined;
};

test('the clearance panel shows the dues across years and a principal overrides them with a reason', async ({ page }) => {
  const overridden: DuesClearanceDto = {
    ...owing,
    cleared: true,
    override: { byUserId: 'u-principal', byName: 'Amina Principal', at: STAMP, reason: 'Family hardship, agreed' },
  };
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: studentHandler,
    replies: {
      'GET /students/st1/dues-clearance': { status: 200, body: owing },
      'POST /students/st1/dues-clearance/override': { status: 200, body: overridden },
    },
  });
  await open(page, '/students/st1');
  await page.getByRole('tab', { name: 'Fees' }).click();
  await expect(page.getByText('Not cleared')).toBeVisible();
  await expect(page.getByText(/Owes Rs 3,000 across all years/)).toBeVisible();
  await expect(page.getByRole('row', { name: /Tuition March 2026/ })).toContainText('Class 4 B');
  await page.getByRole('button', { name: 'Override' }).click();
  const dialog = page.getByRole('dialog', { name: 'Override unpaid dues' });
  await dialog.getByLabel('Reason').fill('Family hardship, agreed');
  await dialog.getByRole('button', { name: 'Override' }).click();
  await expect(page.getByText('Dues override recorded.')).toBeVisible();
  await expect(page.getByText(/Overridden by Amina Principal/)).toBeVisible();
  await expect(page.getByText('Cleared', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Override' })).toHaveCount(0);
  expect(calls(requests, 'POST', '/students/st1/dues-clearance/override')[0].postDataJSON()).toEqual({ reason: 'Family hardship, agreed' });
});

test('a principal who is a guardian of the child is refused the override (R232)', async ({ page }) => {
  await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: studentHandler,
    replies: {
      'GET /students/st1/dues-clearance': { status: 200, body: owing },
      'POST /students/st1/dues-clearance/override': {
        status: 409,
        body: errorBody('SELF_ACTION_FORBIDDEN', 'You cannot do this for your own child. Ask a colleague.', { reason: 'own_child' }),
      },
    },
  });
  await open(page, '/students/st1');
  await page.getByRole('tab', { name: 'Fees' }).click();
  await page.getByRole('button', { name: 'Override' }).click();
  const dialog = page.getByRole('dialog', { name: 'Override unpaid dues' });
  await dialog.getByLabel('Reason').fill('Leaving for abroad');
  await dialog.getByRole('button', { name: 'Override' }).click();
  await expect(page.getByText("You cannot override your own child's dues. Another principal must decide.")).toBeVisible();
  await expect(page.getByText('Not cleared')).toBeVisible();
});

test('office staff see the clearance but no override', async ({ page }) => {
  await mockSchoolApi(page, {
    me: OFFICE_ME,
    handler: studentHandler,
    replies: { 'GET /students/st1/dues-clearance': { status: 200, body: owing } },
  });
  await open(page, '/students/st1');
  await page.getByRole('tab', { name: 'Fees' }).click();
  await expect(page.getByText('Not cleared')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Override' })).toHaveCount(0);
});

test('the status dialog warns of unpaid dues before a leaving status, without blocking it', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: OFFICE_ME,
    handler: studentHandler,
    replies: {
      'GET /students/st1/dues-clearance': { status: 200, body: owing },
      'POST /students/st1/change-status': { status: 200, body: { ...STUDENT, status: 'withdrawn' } },
    },
  });
  await open(page, '/students/st1');
  await page.getByRole('button', { name: 'Change status' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change status: Hamza Tariq' });
  await dialog.getByLabel('New status').selectOption('suspended');
  await expect(dialog.getByText(/This student owes/)).toHaveCount(0);
  expect(calls(requests, 'GET', '/students/st1/dues-clearance')).toHaveLength(0);
  await dialog.getByLabel('New status').selectOption('withdrawn');
  await expect(
    dialog.getByText("This student owes Rs 3,000 across all years; the leaving certificate will need the dues cleared or a principal's override."),
  ).toBeVisible();
  await dialog.getByLabel('Reason').fill('Family moved away');
  await dialog.getByRole('button', { name: 'Change status' }).click();
  await expect(dialog).toBeHidden();
  expect(calls(requests, 'POST', '/students/st1/change-status')).toHaveLength(1);
});
