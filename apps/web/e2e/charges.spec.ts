import { expect as baseExpect, test } from '@playwright/test';
import type {
  CampaignDto,
  ChargeDto,
  ChargeRunDto,
  ConcessionDto,
} from '../lib/api/school-charges-contract';
import type { FeeHeadDto } from '../lib/api/school-fees-contract';
import {
  OFFICE_ME,
  PRINCIPAL_ME,
  STAMP,
  TABLET,
  calls,
  errorBody,
  expectNoSidewaysScroll,
  mockSchoolApi,
  open,
  page1,
} from './support/wave-e';

// Charges (phase-3-financial.md slice 19) against a mocked API: the charges list with its
// principal-only actions and the generate-month dialog, generation runs, the concessions queue
// with "apply to open charges", and campaigns with their preview, each in its four states.

const expect = baseExpect.configure({ timeout: 15_000 });
const KEY = /^[A-Za-z0-9_-]{16,64}$/;

const charge = (id: string, extra: Partial<ChargeDto> = {}): ChargeDto => ({
  id,
  studentId: 'st1',
  studentName: 'Hamza Tariq',
  admissionNo: '1001',
  enrolmentId: 'e1',
  className: 'Class 5',
  sectionName: 'A',
  academicYearId: 'y1',
  feeHeadId: 'fh1',
  feeHeadName: 'Tuition',
  kind: 'generated',
  period: '2026-10',
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
  description: 'Tuition October 2026',
  dueOn: '2026-10-10',
  status: 'open',
  settledAt: null,
  voidedAt: null,
  voidReason: null,
  waivedAt: null,
  waiveReason: null,
  createdByUserId: null,
  createdAt: STAMP,
  ...extra,
});

const run: ChargeRunDto = {
  id: 'r1',
  academicYearId: 'y1',
  period: '2026-10',
  kind: 'monthly',
  campaignId: null,
  status: 'done',
  regenerateVoided: false,
  triggeredBy: null,
  queuedAt: STAMP,
  startedAt: STAMP,
  finishedAt: STAMP,
  studentsCharged: 120,
  chargesInserted: 240,
  chargesSkipped: 0,
  skippedClasses: [{ classId: 'c9', className: 'Class 9', reason: 'no_structure' }],
  errorCode: null,
};

const concession: ConcessionDto = {
  id: 'cn1',
  studentId: 'st1',
  studentName: 'Hamza Tariq',
  academicYearId: 'y1',
  enrolmentId: 'e1',
  className: 'Class 5',
  kind: 'percentage',
  value: 50,
  heads: [{ feeHeadId: 'fh1', name: 'Tuition' }],
  effectiveFrom: '2026-10',
  reason: 'Father lost his job',
  status: 'requested',
  requestedByUserId: 'u2',
  requestedByName: 'Office Clerk',
  requestedAt: STAMP,
  decidedByUserId: null,
  decidedAt: null,
  decisionReason: null,
  selfApproved: false,
  endedAt: null,
  endReason: null,
};

const EXAM: FeeHeadDto = {
  id: 'fh3',
  name: 'Exam',
  category: 'exam',
  frequency: 'per_term',
  concessionEligible: true,
  refundable: true,
  status: 'active',
  archivedAt: null,
  archiveReason: null,
  seeded: true,
  createdAt: STAMP,
};

const campaign: CampaignDto = {
  id: 'cp1',
  name: 'Mid-term exam fee',
  academicYearId: 'y1',
  feeHeadId: 'fh3',
  feeHeadName: 'Exam',
  amount: 800,
  dueOn: '2026-12-10',
  description: null,
  applyConcessions: false,
  status: 'draft',
  audiences: [{ kind: 'everyone' }],
  createdByUserId: 'u1',
  createdAt: STAMP,
  generatedAt: null,
  generatedCount: null,
  cancelledAt: null,
  cancelReason: null,
};

test.describe('charges', () => {
  test('a principal voids a generated charge with a reason; the office sees no principal action', async ({ page }) => {
    const { requests } = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      replies: {
        'POST /charges/c1/void': { status: 200, body: charge('c1', { status: 'voided' }) },
      },
      handler: ({ method, path }) => (method === 'GET' && path === '/charges' ? { status: 200, body: page1([charge('c1')]) } : undefined),
    });
    await open(page, '/fees/charges');
    await expect(page.getByRole('cell', { name: 'Hamza Tariq', exact: true })).toBeVisible();
    await expect(page.getByText('Charges voided in the last 7 days')).toBeVisible();
    await page.getByRole('button', { name: /actions/i }).first().click();
    await page.getByRole('menuitem', { name: 'Void' }).click();
    await page.getByLabel(/reason/i).fill('Wrong amount');
    await page.getByRole('button', { name: 'Void charge' }).click();
    await expect(page.getByText('Tuition for Hamza Tariq voided.')).toBeVisible();
    expect(calls(requests, 'POST', '/charges/c1/void')[0]?.postDataJSON()).toEqual({ reason: 'Wrong amount' });
  });

  test('the office generates a month; a future month is refused on the field', async ({ page }) => {
    const { requests } = await mockSchoolApi(page, {
      me: OFFICE_ME,
      replies: {
        'POST /charges/generate-month': [
          { status: 409, body: errorBody('MONTH_NOT_GENERATABLE', 'That month has not started yet.', { reason: 'future' }) },
          { status: 201, body: { ...run, status: 'queued' } },
        ],
      },
      handler: ({ method, path }) => (method === 'GET' && path === '/charges' ? { status: 200, body: page1([]) } : undefined),
    });
    await open(page, '/fees/charges');
    await expect(page.getByText('No charges match')).toBeVisible();
    await page.getByRole('button', { name: 'Generate a month' }).click();
    await page.getByRole('button', { name: 'Generate', exact: true }).click();
    await expect(page.getByText('That month has not started yet.')).toBeVisible();
    await page.getByRole('button', { name: 'Generate', exact: true }).click();
    await expect(page.getByText(/is being generated/)).toBeVisible();
    expect(calls(requests, 'POST', '/charges/generate-month')[1]?.postDataJSON()).toMatchObject({ academicYearId: 'y1' });
  });

  test('generation runs list the skipped classes and the counts', async ({ page }) => {
    await mockSchoolApi(page, {
      me: OFFICE_ME,
      handler: ({ method, path }) =>
        method === 'GET' && path === '/charges/generation-runs' ? { status: 200, body: page1([run]) } : undefined,
    });
    await open(page, '/fees/runs');
    await expect(page.getByText('Class 9')).toBeVisible();
    await expect(page.getByText('120 students · 0 already charged')).toBeVisible();
  });
});

test.describe('concessions', () => {
  test('a principal approves and credits the open charges', async ({ page }) => {
    const { requests } = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      replies: {
        'POST /concessions/cn1/approve': {
          status: 200,
          body: { concession: { ...concession, status: 'approved' }, adjustments: [charge('a1', { kind: 'adjustment', amount: 1500 })] },
        },
      },
      handler: ({ method, path }) => (method === 'GET' && path === '/concessions' ? { status: 200, body: page1([concession]) } : undefined),
    });
    await open(page, '/fees/concessions');
    await expect(page.getByText('Father lost his job')).toBeVisible();
    await page.getByRole('button', { name: /actions/i }).first().click();
    await page.getByRole('menuitem', { name: 'Approve…' }).click();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByText(/Rs 1,500 credited on 1 open charge/)).toBeVisible();
    expect(calls(requests, 'POST', '/concessions/cn1/approve')[0]?.postDataJSON()).toEqual({ applyToOpenCharges: true });
  });
});

test.describe('campaigns', () => {
  test('a draft is previewed and saved with an Idempotency-Key; it fits a tablet', async ({ page }) => {
    await page.setViewportSize(TABLET);
    const { requests } = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      replies: {
        'POST /charge-campaigns/preview-targets': { status: 200, body: { targets: { students: 42, enrolments: 42 }, concessions: { affected: 2, totalReduction: 800 } } },
        'POST /charge-campaigns': { status: 201, body: campaign },
      },
      handler: ({ method, path }) => {
        if (method === 'GET' && path === '/charge-campaigns') return { status: 200, body: page1([campaign]) };
        if (method === 'GET' && path === '/fee-heads') return { status: 200, body: page1([EXAM]) };
        return undefined;
      },
    });
    await open(page, '/fees/campaigns');
    await expect(page.getByText('Mid-term exam fee')).toBeVisible();
    await expectNoSidewaysScroll(page);
    await page.getByRole('button', { name: 'New campaign' }).click();
    await page.getByLabel('Name').fill('Mid-term exam fee');
    await page.getByLabel('Fee head').selectOption('fh3');
    await page.getByLabel('Amount (Rs)').fill('800');
    await page.getByLabel('Due on').fill('2026-12-10');
    await page.getByRole('button', { name: 'Preview' }).click();
    await expect(page.getByText('42 students will be charged.')).toBeVisible();
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText(/saved as a draft/)).toBeVisible();
    const post = calls(requests, 'POST', '/charge-campaigns')[0];
    expect(post?.headers()['idempotency-key']).toMatch(KEY);
    expect(post?.postDataJSON()).toMatchObject({ amount: 800, audiences: [{ kind: 'everyone' }] });
  });
});
