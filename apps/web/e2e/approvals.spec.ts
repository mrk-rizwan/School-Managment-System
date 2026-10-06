import { expect as baseExpect, test } from '@playwright/test';
import type { MeDto } from '../lib/api/school-contract';
import type { ApprovalsDto } from '../lib/api/school-approvals-contract';
import type { ClaimDto } from '../lib/api/school-claims-contract';
import type { ExpenseDto } from '../lib/api/school-expenses-contract';
import type { LeaveRequestDto } from '../lib/api/school-leave-contract';
import type { HandoverDto } from '../lib/api/school-payments-contract';
import {
  OFFICE_ME,
  PRINCIPAL_ME,
  STAMP,
  TABLET,
  TEACHER_ME,
  TODAY,
  calls,
  expectNoSidewaysScroll,
  mockSchoolApi,
  open,
  page1,
} from './support/wave-e';

// The Approvals page (phase-3-financial.md slice 27, R227) against a mocked API: the principal's
// tiles and the four queues; a clerk with payment.verify only sees deposit slips; a teacher holds
// none of the keys, so has no Approvals entry and an empty page.

const expect = baseExpect.configure({ timeout: 15_000 });

const claim: ClaimDto = {
  id: 'c1',
  studentId: 'st1',
  studentName: 'Hamza Tariq',
  className: 'Class 5',
  guardianId: 'g1',
  guardianName: 'Tariq Mehmood',
  method: 'jazzcash',
  claimedAmount: 4000,
  paidOn: '2026-10-02',
  reference: 'JC-1',
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
  possibleDuplicate: true,
  duplicateOfClaimId: 'c0',
};

const handover: HandoverDto = {
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
};

const expense: ExpenseDto = {
  id: 'e2',
  expenseNo: 2,
  category: 'repairs',
  amount: 9000,
  spentOn: TODAY,
  description: 'Generator repair',
  payee: null,
  method: 'cash',
  reference: null,
  hasReceipt: false,
  receiptMime: null,
  status: 'pending_approval',
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
};

const leave: LeaveRequestDto = {
  id: 'lr-1',
  staffId: 'st-t',
  staffName: 'Ayesha Malik',
  leaveType: { id: 'lt-c', name: 'Casual leave', code: 'casual', paid: true },
  startsOn: '2026-10-12',
  endsOn: '2026-10-14',
  endedEarlyOn: null,
  workingDays: 3,
  reason: 'Family wedding',
  status: 'pending',
  requestedByUserId: 'u-teacher',
  requestedAt: STAMP,
  onBehalf: false,
  decidedByUserId: null,
  decidedByName: null,
  decidedAt: null,
  decisionReason: null,
  selfApproved: false,
  coverAssignmentId: null,
  coverEndedOn: null,
  sectionsNeedingCover: [{ sectionId: 'sec-a', classId: 'c5', name: 'Class 5 A' }],
  cancelledAt: null,
  cancelReason: null,
};

const ALL: ApprovalsDto = {
  claims: { count: 12, items: [claim] },
  handovers: { count: 1, items: [handover] },
  expenses: { count: 1, items: [expense] },
  leave: { count: 1, items: [leave] },
};

const CLERK_ME: MeDto = { ...OFFICE_ME, capabilities: [...OFFICE_ME.capabilities, 'payment.verify'] };

test.describe('Approvals', () => {
  test('the principal sees the tiles and the four queues, each linking to its full page', async ({ page }) => {
    const { requests } = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      replies: {
        'GET /me/approvals': { status: 200, body: ALL },
        'GET /finance-reports/collections': {
          status: 200,
          body: {
            basis: 'verified',
            rows: [],
            total: 15500,
            count: 4,
            refunds: { amount: 0, count: 0 },
            refundReversals: { amount: 0, count: 0 },
            net: 15500,
            voided: { amount: 0, count: 0 },
            carriedForward: { amount: 0, count: 0 },
          },
        },
        'GET /finance-reports/outstanding': { status: 200, body: { asOf: TODAY, rows: [], total: 245000, adjustments: { amount: 0, count: 0 } } },
        'GET /charges': { status: 200, body: { data: [], page: 1, limit: 1, total: 3 } },
        'GET /expenses': { status: 200, body: { data: [], page: 1, limit: 1, total: 2 } },
      },
    });
    await open(page, '/approvals');

    await expect(page.getByTestId('approvals.tile.claims')).toContainText('12');
    await expect(page.getByTestId('approvals.tile.handovers')).toContainText('1');
    await expect(page.getByTestId('approvals.tile.leave')).toContainText('1');
    await expect(page.getByTestId('approvals.tile.collections')).toContainText('Rs 15,500');
    await expect(page.getByTestId('approvals.tile.outstanding')).toContainText('Rs 245,000');
    await expect(page.getByTestId('approvals.tile.voided')).toContainText('3');
    await expect(page.getByTestId('approvals.tile.selfApproved')).toContainText('2');

    const collections = new URL(calls(requests, 'GET', '/finance-reports/collections')[0]!.url()).searchParams;
    expect([collections.get('receivedFrom'), collections.get('receivedTo')]).toEqual([TODAY, TODAY]);
    expect(new URL(calls(requests, 'GET', '/finance-reports/outstanding')[0]!.url()).searchParams.get('academicYearId')).toBe('y1');
    const voided = new URL(calls(requests, 'GET', '/charges')[0]!.url()).searchParams;
    expect([voided.get('status'), voided.get('voidedFrom')]).toEqual(['voided', '2026-09-30']);
    const self = new URL(calls(requests, 'GET', '/expenses')[0]!.url()).searchParams;
    // By the decision day and with no status filter: a self-approved expense voided since still counts.
    expect([self.get('selfApproved'), self.get('decidedFrom'), self.get('status'), self.get('spentFrom')]).toEqual([
      'true',
      '2026-10-01',
      null,
      null,
    ]);

    const slips = page.getByTestId('approvals.claims');
    await expect(slips.getByTestId('approvals.claims.count')).toHaveText('12');
    await expect(slips.getByText('Hamza Tariq · Class 5')).toBeVisible();
    await expect(slips.getByText('possible duplicate')).toBeVisible();
    await expect(slips.getByText('Showing the first 10 of 12.')).toBeVisible();
    await expect(page.getByTestId('approvals.handovers').getByText('Bilal Office')).toBeVisible();
    await expect(page.getByTestId('approvals.expenses').getByText('No. 2 · Repairs')).toBeVisible();
    await expect(page.getByTestId('approvals.leave').getByText('Ayesha Malik · Casual leave')).toBeVisible();
    await expect(page.getByTestId('approvals.leave').getByText('needs cover')).toBeVisible();

    await slips.getByRole('link', { name: 'Open queue' }).click();
    await expect(page).toHaveURL(/\/fees\/claims$/);
  });

  test('a clerk with payment.verify only sees deposit slips and no tiles', async ({ page }) => {
    await mockSchoolApi(page, {
      me: CLERK_ME,
      replies: { 'GET /me/approvals': { status: 200, body: { claims: { count: 1, items: [claim] } } satisfies ApprovalsDto } },
    });
    await open(page, '/approvals');
    await expect(page.getByRole('link', { name: 'Approvals' })).toBeVisible();
    await expect(page.getByTestId('approvals.claims')).toBeVisible();
    await expect(page.getByTestId('approvals.claims.count')).toHaveText('1');
    await expect(page.getByTestId('approvals.handovers')).toHaveCount(0);
    await expect(page.getByTestId('approvals.expenses')).toHaveCount(0);
    await expect(page.getByTestId('approvals.leave')).toHaveCount(0);
    await expect(page.getByTestId('approvals.tiles')).toHaveCount(0);
  });

  test('a teacher has no Approvals entry; the page says there is nothing to approve', async ({ page }) => {
    await mockSchoolApi(page, {
      me: TEACHER_ME,
      handler: ({ method, path }) => (method === 'GET' && path === '/me/approvals' ? { status: 200, body: {} } : undefined),
    });
    await open(page, '/approvals');
    await expect(page.getByText('Nothing for you to approve')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Approvals' })).toHaveCount(0);
  });

  test('no sideways scroll at tablet width', async ({ page }) => {
    await page.setViewportSize(TABLET);
    await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      handler: ({ method, path }) => {
        if (method !== 'GET') return undefined;
        if (path === '/me/approvals') return { status: 200, body: ALL };
        if (path === '/charges' || path === '/expenses') return { status: 200, body: page1([]) };
        return undefined;
      },
    });
    await open(page, '/approvals');
    await expect(page.getByTestId('approvals.claims')).toBeVisible();
    await expectNoSidewaysScroll(page);
  });
});
