import { expect as baseExpect, test } from '@playwright/test';
import type { ChargeDto } from '../lib/api/school-charges-contract';
import type { GuardianDuesDto, HandoverDto, PaymentDto, PaymentPreviewDto } from '../lib/api/school-payments-contract';
import { OFFICE_ME, PRINCIPAL_ME, STAMP, TABLET, calls, errorBody, expectNoSidewaysScroll, mockSchoolApi, open, page1 } from './support/wave-e';

// Payments (phase-3-financial.md slice 20) against a mocked API: the counter (find the guardian,
// the family's dues, preview, save, print), the payments list with a void, and the cash handovers
// (my custody and handing it over; counting with a shortfall; the principal's shortfall banner).

const expect = baseExpect.configure({ timeout: 15_000 });
const KEY = /^[A-Za-z0-9_-]{16,64}$/;

const charge = (id: string, studentId: string, description: string, dueOn: string): ChargeDto => ({
  id,
  studentId,
  studentName: studentId === 'st1' ? 'Hamza Tariq' : 'Hira Tariq',
  admissionNo: '1001',
  enrolmentId: `e-${studentId}`,
  className: 'Class 5',
  sectionName: 'A',
  academicYearId: 'y1',
  feeHeadId: 'fh1',
  feeHeadName: 'Tuition',
  kind: 'generated',
  period: dueOn.slice(0, 7),
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
  description,
  dueOn,
  status: 'open',
  settledAt: null,
  voidedAt: null,
  voidReason: null,
  waivedAt: null,
  waiveReason: null,
  createdByUserId: null,
  createdAt: STAMP,
});

const dues: GuardianDuesDto = {
  guardianId: 'g1',
  fullName: 'Tariq Mehmood',
  children: [
    {
      studentId: 'st1',
      fullName: 'Hamza Tariq',
      className: 'Class 5',
      enrolmentId: 'e-st1',
      academicYearId: 'y1',
      academicYearName: '2026-27',
      academicYearClosed: false,
      outstanding: 6000,
      advance: 0,
      openCharges: [charge('c1', 'st1', 'Tuition September 2026', '2026-09-10'), charge('c2', 'st1', 'Tuition October 2026', '2026-10-10')],
    },
    {
      studentId: 'st2',
      fullName: 'Hira Tariq',
      className: 'Class 3',
      enrolmentId: 'e-st2',
      academicYearId: 'y1',
      academicYearName: '2026-27',
      academicYearClosed: false,
      outstanding: 3000,
      advance: 500,
      openCharges: [charge('c3', 'st2', 'Tuition October 2026', '2026-10-10')],
    },
  ],
};

const preview: PaymentPreviewDto = {
  allocations: [
    { chargeId: 'c1', studentId: 'st1', studentName: 'Hamza Tariq', feeHeadName: 'Tuition', period: '2026-09', dueOn: '2026-09-10', amount: 3000, fromAdvance: false },
    { chargeId: 'c3', studentId: 'st2', studentName: 'Hira Tariq', feeHeadName: 'Tuition', period: '2026-10', dueOn: '2026-10-10', amount: 500, fromAdvance: true },
    { chargeId: 'c2', studentId: 'st1', studentName: 'Hamza Tariq', feeHeadName: 'Tuition', period: '2026-10', dueOn: '2026-10-10', amount: 2000, fromAdvance: false },
  ],
  remainder: 0,
  outstanding: 9000,
  advanceUsed: 500,
};

const payment = (extra: Partial<PaymentDto> = {}): PaymentDto => ({
  id: 'p1',
  academicYearId: 'y1',
  payerGuardianId: 'g1',
  payerName: 'Tariq Mehmood',
  students: [{ studentId: 'st1', fullName: 'Hamza Tariq', amount: 5000 }],
  method: 'cash',
  amount: 5000,
  allocatedAmount: 5000,
  unallocatedAmount: 0,
  advanceForStudentId: null,
  receivedOn: '2026-10-06',
  verifiedAt: STAMP,
  reference: null,
  recordedByUserId: 'u-office',
  recordedByName: 'Bilal Office',
  handoverId: null,
  claimId: null,
  status: 'verified',
  voidedAt: null,
  receipt: {
    id: 'r1',
    receiptNo: 17,
    receiptLabel: '17/2026-27',
    academicYearId: 'y1',
    paymentId: 'p1',
    amount: 5000,
    lines: [],
    issuedAt: STAMP,
    issuedByName: 'Bilal Office',
    voidedAt: null,
  },
  reversals: [],
  possibleDuplicate: false,
  duplicateOfPaymentId: null,
  ...extra,
});

const handover = (extra: Partial<HandoverDto> = {}): HandoverDto => ({
  id: 'h1',
  collector: { userId: 'u-office', staffId: 'st-o', name: 'Bilal Office' },
  openedByUserId: 'u-office',
  openedByName: 'Bilal Office',
  onBehalf: false,
  expectedAmount: 5000,
  paymentCount: 2,
  openedAt: STAMP,
  note: null,
  status: 'open',
  confirmedByUserId: null,
  confirmedByName: null,
  confirmedAt: null,
  countedAmount: null,
  shortfallAmount: null,
  surplusAmount: null,
  confirmNote: null,
  shortfallResolution: null,
  shortfallResolvedAt: null,
  shortfallResolutionReason: null,
  shortfallExpenseId: null,
  shortfallReversalId: null,
  ...extra,
});

test.describe('the counter', () => {
  test('finds the family, previews the allocation, saves with a key and offers the receipt to print', async ({ page }) => {
    const { requests } = await mockSchoolApi(page, {
      me: OFFICE_ME,
      replies: {
        'GET /guardians/g1/dues': { status: 200, body: dues },
        'POST /payments/preview': { status: 200, body: preview },
        'POST /payments': { status: 201, body: payment({ amount: 5500 }) },
      },
      handler: ({ method, path }) =>
        method === 'GET' && path === '/guardians'
          ? { status: 200, body: page1([{ id: 'g1', fullName: 'Tariq Mehmood' }]) }
          : undefined,
    });
    await open(page, '/fees/counter');
    await page.getByLabel('Guardian').fill('Tariq');
    await page.getByRole('button', { name: 'Tariq Mehmood' }).click();
    await expect(page.getByText('Tuition September 2026')).toBeVisible();
    await expect(page.getByText('Advance held: Rs 500 (spent first)')).toBeVisible();
    await page.getByLabel('Amount (Rs)').fill('5500');
    await page.getByRole('button', { name: 'Preview' }).click();
    await expect(page.getByText('Where the money goes')).toBeVisible();
    await expect(page.getByText('advance', { exact: true })).toBeVisible();
    expect(calls(requests, 'POST', '/payments/preview')[0]?.postDataJSON()).toEqual({
      academicYearId: 'y1',
      payerGuardianId: 'g1',
      studentIds: ['st1', 'st2'],
      amount: 5500,
    });
    await page.getByRole('button', { name: 'Save Rs 5,500' }).click();
    await expect(page.getByText('Receipt 17/2026-27: Rs 5,500 from Tariq Mehmood')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Print receipt' })).toHaveAttribute('href', '/api/v1/receipts/r1/print');
    const saved = calls(requests, 'POST', '/payments')[0];
    expect(saved?.headers()['idempotency-key']).toMatch(KEY);
    expect(saved?.postDataJSON()).toMatchObject({ method: 'cash', receivedOn: '2026-10-06', amount: 5500 });
  });

  test('a refusal is shown on the form; an empty search says so', async ({ page }) => {
    await mockSchoolApi(page, {
      me: OFFICE_ME,
      replies: {
        'GET /guardians/g1/dues': { status: 200, body: dues },
        'POST /payments/preview': { status: 200, body: preview },
        'POST /payments': { status: 409, body: errorBody('SELF_ACTION_FORBIDDEN', 'You cannot do this for your own child. Ask a colleague.', { reason: 'own_child' }) },
      },
      handler: ({ method, path, url }) =>
        method === 'GET' && path === '/guardians'
          ? { status: 200, body: page1(url.searchParams.get('q') === 'Nobody' ? [] : [{ id: 'g1', fullName: 'Tariq Mehmood' }]) }
          : undefined,
    });
    await open(page, '/fees/counter');
    await page.getByLabel('Guardian').fill('Nobody');
    await expect(page.getByText('No guardian found')).toBeVisible();
    await page.getByLabel('Guardian').fill('Tariq');
    await page.getByRole('button', { name: 'Tariq Mehmood' }).click();
    await page.getByLabel('Amount (Rs)').fill('100');
    await page.getByRole('button', { name: 'Preview' }).click();
    await page.getByRole('button', { name: 'Save Rs 100' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'your own child' })).toBeVisible();
  });
});

test.describe('payments', () => {
  test('a principal voids a payment with a reason; the receipt prints in a new tab', async ({ page }) => {
    const { requests } = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      replies: { 'POST /payments/p1/void': { status: 200, body: payment({ status: 'voided', voidedAt: STAMP }) } },
      handler: ({ method, path }) => (method === 'GET' && path === '/payments' ? { status: 200, body: page1([payment()]) } : undefined),
    });
    await open(page, '/fees/payments');
    await expect(page.getByRole('link', { name: '17/2026-27' })).toHaveAttribute('target', '_blank');
    await page.getByRole('button', { name: /actions/i }).first().click();
    await page.getByRole('menuitem', { name: 'Void' }).click();
    await page.getByLabel(/reason/i).fill('Wrong family');
    await page.getByRole('button', { name: 'Void payment' }).click();
    await expect(page.getByText('Payment of Rs 5,000 voided.')).toBeVisible();
    expect(calls(requests, 'POST', '/payments/p1/void')[0]?.postDataJSON()).toEqual({ reason: 'Wrong family' });
  });

  test('an empty list, and no sideways scroll at tablet width', async ({ page }) => {
    await page.setViewportSize(TABLET);
    await mockSchoolApi(page, {
      me: OFFICE_ME,
      handler: ({ method, path }) => (method === 'GET' && path === '/payments' ? { status: 200, body: page1([]) } : undefined),
    });
    await open(page, '/fees/payments');
    await expect(page.getByText('No payments match')).toBeVisible();
    await expectNoSidewaysScroll(page);
  });
});

test.describe('cash handovers', () => {
  test('the office hands over its cash', async ({ page }) => {
    const { requests } = await mockSchoolApi(page, {
      me: OFFICE_ME,
      replies: {
        'GET /me/staff/custody': [
          { status: 200, body: { cashInHand: 5000, paymentCount: 2, since: STAMP } },
          { status: 200, body: { cashInHand: 0, paymentCount: 0, since: null } },
        ],
        'POST /me/staff/cash-handovers': { status: 201, body: handover() },
      },
      handler: ({ method, path }) =>
        method === 'GET' && path === '/me/staff/cash-handovers' ? { status: 200, body: page1([]) } : undefined,
    });
    await open(page, '/fees/handovers');
    await expect(page.getByText('Rs 5,000')).toBeVisible();
    await page.getByRole('button', { name: 'Hand over' }).click();
    await expect(page.getByText('Rs 5,000 handed over. Someone else will count it.')).toBeVisible();
    expect(calls(requests, 'POST', '/me/staff/cash-handovers')).toHaveLength(1);
    await expect(page.getByText('Handovers to count')).toHaveCount(0);
  });

  test('a principal counts a handover short and sees the shortfall banner', async ({ page }) => {
    const { requests } = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      replies: {
        'POST /cash-handovers/h1/confirm': {
          status: 200,
          body: handover({ status: 'confirmed', countedAmount: 4800, shortfallAmount: 200, surplusAmount: 0, confirmedAt: STAMP }),
        },
      },
      handler: ({ method, path, url }) => {
        if (method === 'GET' && path === '/me/staff/custody') return { status: 200, body: { cashInHand: 0, paymentCount: 0, since: null } };
        if (method === 'GET' && path === '/me/staff/cash-handovers') return { status: 200, body: page1([]) };
        if (method === 'GET' && path === '/cash-handovers') {
          return url.searchParams.get('unresolvedShortfall') === 'true'
            ? { status: 200, body: { data: [], page: 1, limit: 1, total: 1 } }
            : { status: 200, body: page1([handover()]) };
        }
        return undefined;
      },
    });
    await open(page, '/fees/handovers');
    await expect(page.getByText('1 counted handover has a shortfall to resolve.')).toBeVisible();
    await page.getByRole('button', { name: /actions/i }).first().click();
    await page.getByRole('menuitem', { name: 'Count…' }).click();
    await page.getByLabel('Counted (Rs)').fill('4800');
    await page.getByRole('button', { name: 'Confirm count' }).click();
    await expect(page.getByText(/short Rs 200\. The principals are told\./)).toBeVisible();
    expect(calls(requests, 'POST', '/cash-handovers/h1/confirm')[0]?.postDataJSON()).toEqual({ countedAmount: 4800 });
  });
});
