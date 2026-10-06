import { expect as baseExpect, test } from '@playwright/test';
import type { MeDto } from '../lib/api/school-contract';
import type { ClaimDto, MyClaimDto, MyDuesDto, MyReceiptDto, VerifiedClaimDto } from '../lib/api/school-claims-contract';
import type { GuardianDuesDto, PaymentDto } from '../lib/api/school-payments-contract';
import { PRINCIPAL_ME, STAMP, TABLET, calls, expectNoSidewaysScroll, mockSchoolApi, open, page1 } from './support/wave-e';

// Deposit slips (phase-3-financial.md slice 21) against a mocked API: the office reviews a slip
// beside the family's dues and verifies it with a lower amount and a reason; a guardian sees a
// child's dues, sends a slip (upload, then the claim with a key) and opens a receipt.

const expect = baseExpect.configure({ timeout: 15_000 });
const KEY = /^[A-Za-z0-9_-]{16,64}$/;

const claim = (extra: Partial<ClaimDto> = {}): ClaimDto => ({
  id: 'c1',
  studentId: 'st1',
  studentName: 'Hamza Tariq',
  className: 'Class 5',
  guardianId: 'g1',
  guardianName: 'Tariq Mehmood',
  method: 'bank_transfer',
  claimedAmount: 4000,
  paidOn: '2026-10-02',
  reference: 'MZN-778812',
  note: null,
  hasImage: true,
  imageMime: 'image/png',
  status: 'pending',
  decidedByUserId: null,
  decidedByName: null,
  decidedAt: null,
  decisionReason: null,
  verifiedAmount: null,
  verifiedPaidOn: null,
  paymentId: null,
  receiptId: null,
  reopenedAt: null,
  createdAt: STAMP,
  possibleDuplicate: false,
  duplicateOfClaimId: null,
  ...extra,
});

const familyDues: GuardianDuesDto = {
  guardianId: 'g1',
  fullName: 'Tariq Mehmood',
  children: [
    {
      studentId: 'st1',
      fullName: 'Hamza Tariq',
      className: 'Class 5',
      enrolmentId: 'e1',
      academicYearId: 'y1',
      academicYearName: '2026-27',
      academicYearClosed: false,
      outstanding: 6000,
      advance: 0,
      openCharges: [],
    },
  ],
};

const payment = { id: 'p1', amount: 3500, receipt: { id: 'r1', receiptLabel: '18/2026-27' } } as unknown as PaymentDto;

test.describe('the office queue', () => {
  test('reviews a slip beside the family dues and verifies a lower amount with a reason', async ({ page }) => {
    const { requests } = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      replies: {
        'GET /payment-claims/c1': { status: 200, body: claim() },
        'GET /guardians/g1/dues': { status: 200, body: familyDues },
        'POST /payment-claims/c1/verify': {
          status: 200,
          body: { ...claim({ status: 'verified', verifiedAmount: 3500 }), payment } satisfies VerifiedClaimDto,
        },
      },
      handler: ({ method, path }) => (method === 'GET' && path === '/payment-claims' ? { status: 200, body: page1([claim({ possibleDuplicate: true })]) } : undefined),
    });
    await open(page, '/fees/claims');
    await expect(page.getByText('possible duplicate')).toBeVisible();
    await page.getByTestId('claims.review.c1').click();
    await expect(page.getByText('Family dues')).toBeVisible();
    await expect(page.getByText('Owes Rs 6,000')).toBeVisible();
    expect(calls(requests, 'GET', '/payment-claims')[0]?.url()).toContain('hasImage=true');
    await page.getByLabel('Amount on the slip (Rs)').fill('3500');
    await expect(page.getByTestId('claims.verify')).toBeDisabled();
    await page.getByLabel(/^Reason/).fill('The slip shows Rs 3,500');
    await page.getByTestId('claims.verify').click();
    await expect(page.getByText('Verified: receipt 18/2026-27 for Rs 3,500.')).toBeVisible();
    expect(calls(requests, 'POST', '/payment-claims/c1/verify')[0]?.postDataJSON()).toEqual({
      verifiedAmount: 3500,
      reason: 'The slip shows Rs 3,500',
    });
  });

  test('an empty queue, and no sideways scroll at tablet width', async ({ page }) => {
    await page.setViewportSize(TABLET);
    await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      handler: ({ method, path }) => (method === 'GET' && path === '/payment-claims' ? { status: 200, body: page1([]) } : undefined),
    });
    await open(page, '/fees/claims');
    await expect(page.getByText('No deposit slips here')).toBeVisible();
    await expectNoSidewaysScroll(page);
  });
});

const GUARDIAN_ME: MeDto = {
  ...PRINCIPAL_ME,
  id: 'u-guardian',
  staffId: null,
  fullName: 'Tariq Mehmood',
  roles: ['parent'],
  capabilities: [],
  capabilityScopes: [],
  capacities: ['guardian'],
  children: [{ studentId: 'st1', fullName: 'Hamza Tariq', relationship: 'father', status: 'active', current: null }],
};

const dues: MyDuesDto = {
  studentId: 'st1',
  academicYearId: null,
  outstanding: 6000,
  advance: 0,
  nextDueOn: '2026-10-10',
  charges: [
    {
      id: 'ch1',
      academicYearId: 'y1',
      feeHeadName: 'Tuition',
      kind: 'generated',
      period: '2026-10',
      description: 'Tuition October 2026',
      dueOn: '2026-10-10',
      grossAmount: 3000,
      concessionAmount: 0,
      amount: 3000,
      paidAmount: 0,
      creditedAmount: 0,
      outstanding: 3000,
      status: 'open',
    },
  ],
  claimsAccepted: true,
};

const myClaim: MyClaimDto = {
  id: 'c9',
  studentId: 'st1',
  method: 'jazzcash',
  claimedAmount: 3000,
  paidOn: '2026-10-06',
  reference: null,
  note: null,
  hasImage: true,
  submittedByMe: true,
  status: 'pending',
  decidedAt: null,
  decisionReason: null,
  verifiedAmount: null,
  verifiedPaidOn: null,
  receiptId: null,
  createdAt: STAMP,
};

const receipt: MyReceiptDto = {
  id: 'r1',
  receiptLabel: '17/2026-27',
  academicYearId: 'y1',
  academicYearName: '2026-27',
  amount: 6000,
  paidOn: '2026-10-01',
  method: 'cash',
  lines: [{ studentId: 'st1', studentName: 'Hamza Tariq', feeHeadName: 'Tuition', period: '2026-09', amount: 3000 }],
  otherChildrenAmount: 3000,
  issuedAt: STAMP,
  voidedAt: null,
};

test.describe("a guardian's children's fees", () => {
  test('shows the dues, sends a slip with a key, and opens a receipt with only their own child', async ({ page }) => {
    const { requests } = await mockSchoolApi(page, {
      me: GUARDIAN_ME,
      replies: {
        'GET /me/children/st1/dues': { status: 200, body: dues },
        'GET /me/children/st1/payment-claims': [
          { status: 200, body: page1([]) },
          { status: 200, body: page1([myClaim]) },
        ],
        'GET /me/receipts': { status: 200, body: page1([receipt]) },
        'GET /me/payment-accounts': {
          status: 200,
          body: page1([{ id: 'a1', kind: 'jazzcash', title: 'Green Valley School', accountNo: '03001234', bankName: null }]),
        },
        'POST /me/uploads': { status: 201, body: { id: 'up1', mime: 'image/png', sizeBytes: 120, expiresAt: STAMP } },
        'POST /me/children/st1/payment-claims': { status: 201, body: myClaim },
      },
    });
    await open(page, '/my-children');
    await expect(page.getByRole('link', { name: "Children's fees" })).toBeVisible();
    await expect(page.getByTestId('myFees.outstanding.st1')).toHaveText('Rs 6,000');
    await expect(page.getByText('03001234')).toBeVisible();

    await page.getByTestId('myFees.send.st1').click();
    await page.getByLabel('Paid by').selectOption('jazzcash');
    await page.getByLabel('Amount (Rs)').fill('3000');
    await page.getByLabel(/^Slip/).setInputFiles({ name: 'slip.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') });
    await page.getByTestId('myFees.submit.st1').click();
    await expect(page.getByText('Slip sent. The office will check it.')).toBeVisible();
    const sent = calls(requests, 'POST', '/me/children/st1/payment-claims')[0];
    expect(sent?.headers()['idempotency-key']).toMatch(KEY);
    expect(sent?.postDataJSON()).toMatchObject({ method: 'jazzcash', claimedAmount: 3000, stagedUploadId: 'up1' });
    await expect(page.getByText('Waiting for the office')).toBeVisible();

    await page.getByTestId('myFees.receipt.r1').click();
    await expect(page.getByRole('dialog').getByText('Other children')).toBeVisible();
    await expect(page.getByRole('dialog').getByText('Hamza Tariq: Tuition Sept 2026')).toBeVisible();
  });
});
