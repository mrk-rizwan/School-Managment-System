import { Capability } from '@asms/shared';
import { expect as baseExpect, test } from '@playwright/test';
import type { AcademicYearDto } from '../lib/api/school-academics-contract';
import type { MeDto } from '../lib/api/school-contract';
import type {
  FeeHeadDto,
  FeeStructureClassDto,
  FeeStructureDto,
  PaymentAccountDto,
} from '../lib/api/school-fees-contract';
import type { SchoolSettingsDto } from '../lib/api/school-messaging-contract';
import { FINANCE_SETTINGS } from './support/settings';
import {
  OFFICE_ME,
  PRINCIPAL_ME,
  STAMP,
  TABLET,
  TEACHER_ME,
  YEARS,
  calls,
  errorBody,
  expectNoSidewaysScroll,
  mockSchoolApi,
  open,
  page1,
  type Handler,
} from './support/wave-e';

// Fee setup (phase-3-financial.md slice 18) against a mocked API: fee heads and their fixed
// flags, the fee-structure grid with its replace-with-a-reason flow, the payment accounts and the
// new settings on the settings page, the rule-24 banner, and the Fees entry in the sidebar.

const expect = baseExpect.configure({ timeout: 15_000 });
const KEY = /^[A-Za-z0-9_-]{16,64}$/;

const head = (id: string, name: string, extra: Partial<FeeHeadDto> = {}): FeeHeadDto => ({
  id,
  name,
  category: 'other',
  frequency: 'monthly',
  concessionEligible: true,
  refundable: true,
  status: 'active',
  archivedAt: null,
  archiveReason: null,
  seeded: true,
  createdAt: STAMP,
  ...extra,
});
const TUITION = head('fh1', 'Tuition', { category: 'tuition' });
const ADMISSION = head('fh2', 'Admission', { category: 'admission', frequency: 'once', refundable: false });
const EXAM = head('fh3', 'Exam', { category: 'exam', frequency: 'per_term' });
const FINE = head('fh4', 'Fine', { category: 'fine', frequency: 'ad_hoc', concessionEligible: false });

const structure = (id: string, extra: Partial<FeeStructureDto> = {}): FeeStructureDto => ({
  id,
  academicYearId: 'y1',
  classId: 'c5',
  feeHeadId: 'fh1',
  feeHeadName: 'Tuition',
  amount: 2500,
  effectiveFrom: '2026-04',
  status: 'active',
  supersededBy: null,
  supersededAt: null,
  reason: null,
  createdAt: STAMP,
  ...extra,
});
const CLASS_5: FeeStructureClassDto = {
  classId: 'c5',
  className: 'Class 5',
  heads: [{ feeHeadId: 'fh1', name: 'Tuition', frequency: 'monthly', amount: 2500, effectiveFrom: '2026-04', structureId: 'fs2' }],
  history: [
    structure('fs2', { reason: null }),
    structure('fs1', {
      amount: 2200,
      status: 'superseded',
      supersededBy: 'fs2',
      supersededAt: STAMP,
      reason: 'Typed the wrong amount',
    }),
  ],
};

const account = (id: string, extra: Partial<PaymentAccountDto> = {}): PaymentAccountDto => ({
  id,
  kind: 'bank',
  title: 'Green Valley School',
  accountNo: 'PK36SCBL0000001123456702',
  bankName: 'Meezan Bank',
  status: 'active',
  disabledAt: null,
  disableReason: null,
  createdAt: STAMP,
  ...extra,
});

const settings = (extra: Partial<SchoolSettingsDto> = {}): SchoolSettingsDto => ({
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
  ...extra,
});

/** The fee screens' reads: heads, structures, payment accounts and settings. */
const feesHandler =
  ({ heads = [TUITION, ADMISSION, EXAM, FINE], accounts = [account('pa1')] } = {}): Handler =>
  ({ method, path, url }) => {
    if (method !== 'GET') return undefined;
    if (path === '/fee-heads') {
      const status = url.searchParams.get('status');
      return { status: 200, body: page1(heads.filter((h) => !status || h.status === status)) };
    }
    if (path === '/fee-structures') return { status: 200, body: page1([CLASS_5]) };
    if (path === '/payment-accounts') return { status: 200, body: page1(accounts) };
    if (path === '/school/settings') return { status: 200, body: settings() };
    return undefined;
  };

/** Office staff with the settings key granted: reads payment accounts, may not change them. */
const OFFICE_WITH_SETTINGS: MeDto = {
  ...OFFICE_ME,
  capabilities: [...OFFICE_ME.capabilities, Capability.SCHOOL_SETTINGS_MANAGE].sort(),
};

test.describe('fee heads', () => {
  test('lists heads; a new head is posted; fine and admission flags are fixed', async ({ page }) => {
    const created = head('fh9', 'Transport', { seeded: false });
    const { requests } = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      handler: feesHandler(),
      replies: {
        'POST /fee-heads': [
          { status: 409, body: errorBody('FEE_HEAD_NAME_TAKEN', 'A fee head of that name already exists.', { feeHeadId: 'fh1' }) },
          { status: 201, body: created },
        ],
      },
    });
    await open(page, '/fees/heads');

    const table = page.getByRole('table');
    await expect(table.getByRole('row', { name: /Tuition/ })).toContainText('Monthly');
    await expect(table.getByRole('row', { name: /Fine/ })).toContainText('Ad hoc');

    await page.getByRole('button', { name: 'New fee head' }).click();
    const dialog = page.getByRole('dialog');
    const concession = dialog.getByLabel('Concession applies');
    const refundable = dialog.getByLabel('Refundable');

    // Rule 19: a fine is never concession-eligible.
    await dialog.getByLabel('Category').selectOption('fine');
    await expect(concession).toBeDisabled();
    await expect(concession).not.toBeChecked();
    await expect(refundable).toBeEnabled();
    // Rule 20: an admission fee is never refundable.
    await dialog.getByLabel('Category').selectOption('admission');
    await expect(refundable).toBeDisabled();
    await expect(refundable).not.toBeChecked();

    await dialog.getByLabel('Category').selectOption('other');
    await concession.check();
    await refundable.check();
    await dialog.getByLabel('Name').fill('Transport');
    await dialog.getByLabel('Charged').selectOption('monthly');
    await dialog.getByRole('button', { name: 'Add fee head' }).click();
    // The name clash lands on the name field; the dialog stays open.
    await expect(dialog.getByText('A fee head of that name already exists.')).toBeVisible();

    await dialog.getByRole('button', { name: 'Add fee head' }).click();
    await expect(dialog).toBeHidden();
    const posts = calls(requests, 'POST', '/fee-heads');
    expect(posts).toHaveLength(2);
    expect(posts[1].postDataJSON()).toEqual({
      name: 'Transport',
      category: 'other',
      frequency: 'monthly',
      concessionEligible: true,
      refundable: true,
    });
  });

  test('archiving asks for a reason of at least 3 characters', async ({ page }) => {
    const { requests } = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      handler: feesHandler(),
      replies: {
        'POST /fee-heads/fh3/archive': {
          status: 200,
          body: { ...EXAM, status: 'archived', archivedAt: STAMP, archiveReason: 'No exams this year' },
        },
      },
    });
    await open(page, '/fees/heads');

    await page.getByRole('button', { name: 'Actions for Exam' }).click();
    await page.getByRole('menuitem', { name: 'Archive' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Archive fee head: Exam' })).toBeVisible();
    const confirm = dialog.getByRole('button', { name: 'Archive' });
    await dialog.getByLabel('Reason').fill('No');
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel('Reason').fill('No exams this year');
    await confirm.click();
    await expect(dialog).toBeHidden();
    expect(calls(requests, 'POST', '/fee-heads/fh3/archive')[0].postDataJSON()).toEqual({
      reason: 'No exams this year',
    });
  });

  test('a reader without fee_head.manage sees the heads read-only', async ({ page }) => {
    await mockSchoolApi(page, { me: OFFICE_ME, handler: feesHandler() });
    await open(page, '/fees/heads');
    await expect(page.getByRole('table').getByRole('row', { name: /Tuition/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New fee head' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Actions for/ })).toHaveCount(0);
  });
});

test.describe('fee structure', () => {
  test('a same-month amount is replaced only with a reason, under a fresh key', async ({ page }) => {
    const replaced = structure('fs3', { amount: 3000, effectiveFrom: '2026-10', reason: 'Board approved new fee' });
    const { requests } = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      handler: feesHandler(),
      replies: {
        'POST /fee-structures': [
          {
            status: 409,
            body: errorBody(
              'FEE_STRUCTURE_EXISTS',
              'This class already has an amount for that head from that month. Give a reason to replace it.',
              { structureId: 'fs2' },
            ),
          },
          { status: 201, body: replaced },
        ],
      },
    });
    await open(page, '/fees/structures');

    // Columns are the monthly, yearly and one-time heads; per-term and ad hoc heads are not.
    const grid = page.getByRole('table', { name: 'Fee structure 2026-27' });
    await expect(grid.getByRole('columnheader', { name: /Tuition/ })).toBeVisible();
    await expect(grid.getByRole('columnheader', { name: /Admission/ })).toBeVisible();
    await expect(grid.getByRole('columnheader', { name: /Exam/ })).toHaveCount(0);
    await expect(grid.getByRole('columnheader', { name: /Fine/ })).toHaveCount(0);

    const tuition = grid.getByRole('button', { name: /^Class 5, Tuition: Rs 2,500 from Apr 2026/ });
    await expect(tuition).toBeVisible();
    await expect(grid.getByRole('button', { name: /^Class 5, Admission: not set/ })).toBeVisible();

    await tuition.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Amount (Rs)')).toHaveValue('2500');
    // This month (October 2026), inside the year.
    await expect(dialog.getByLabel('From month')).toHaveValue('2026-10');
    await dialog.getByLabel('Amount (Rs)').fill('3000');
    await dialog.getByRole('button', { name: 'Set amount' }).click();

    const replace = page.getByRole('dialog');
    await expect(replace.getByRole('heading', { name: 'Replace the amount for Oct 2026' })).toBeVisible();
    await replace.getByLabel('Reason').fill('Board approved new fee');
    await replace.getByRole('button', { name: 'Replace amount' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    const posts = calls(requests, 'POST', '/fee-structures');
    expect(posts).toHaveLength(2);
    const base = { academicYearId: 'y1', classId: 'c5', feeHeadId: 'fh1', amount: 3000, effectiveFrom: '2026-10' };
    expect(posts[0].postDataJSON()).toEqual(base);
    expect(posts[1].postDataJSON()).toEqual({ ...base, reason: 'Board approved new fee' });
    const [first, second] = posts.map((p) => p.headers()['idempotency-key']);
    expect(first).toMatch(KEY);
    expect(second).toMatch(KEY);
    expect(second).not.toBe(first);
  });

  test('an earlier month is refused on the month field; history lists replaced amounts', async ({ page }) => {
    await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      handler: feesHandler(),
      replies: {
        'POST /fee-structures': {
          status: 409,
          body: errorBody('FEE_STRUCTURE_NOT_LATER', 'A new amount must start after 2026-10.', {
            latestEffectiveFrom: '2026-10',
          }),
        },
      },
    });
    await open(page, '/fees/structures');

    await page.getByRole('button', { name: /^Class 5, Admission: not set/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Amount (Rs)').fill('5000');
    await dialog.getByLabel('From month').fill('2026-09');
    await dialog.getByRole('button', { name: 'Set amount' }).click();
    await expect(dialog.getByText('Pick a month after Oct 2026, the latest month already set.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: /History of Class 5/ }).click();
    const history = page.locator('#history-c5');
    await expect(history).toContainText('Rs 2,200');
    await expect(history).toContainText('Replaced');
    await expect(history).toContainText('Typed the wrong amount');
  });

  test('copies another year’s amounts into this one', async ({ page }) => {
    const next: AcademicYearDto = {
      ...YEARS[0],
      id: 'y2',
      name: '2027-28',
      startsOn: '2027-04-01',
      endsOn: '2028-03-31',
      status: 'planned',
    };
    const base = feesHandler();
    const { requests } = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      handler: (call) =>
        call.method === 'GET' && call.path === '/academic-years'
          ? { status: 200, body: page1([next, ...YEARS]) }
          : base(call),
      replies: { 'POST /fee-structures/copy': { status: 200, body: { created: 4, skipped: 1 } } },
    });
    await open(page, '/fees/structures');

    // The active year is chosen first; switch to next year.
    await expect(page.getByLabel('Academic year')).toHaveValue('y1');
    await page.getByLabel('Academic year').selectOption('y2');
    await page.getByRole('button', { name: 'Copy from another year' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('From month')).toHaveValue('2027-04');
    await dialog.getByRole('button', { name: 'Copy amounts' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('4 amounts copied; 1 already set were left as they are.')).toBeVisible();
    expect(calls(requests, 'POST', '/fee-structures/copy')[0].postDataJSON()).toEqual({
      fromAcademicYearId: 'y1',
      toAcademicYearId: 'y2',
      effectiveFrom: '2027-04',
    });
  });

  test('a reader sees amounts but no controls', async ({ page }) => {
    await mockSchoolApi(page, { me: OFFICE_ME, handler: feesHandler() });
    await open(page, '/fees/structures');
    const grid = page.getByRole('table', { name: 'Fee structure 2026-27' });
    await expect(grid).toContainText('Rs 2,500');
    await expect(grid.getByRole('button', { name: /^Class 5, Tuition/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Copy from another year' })).toHaveCount(0);
  });

  test('fits a tablet: the grid scrolls inside its frame, never the page', async ({ page }) => {
    await page.setViewportSize(TABLET);
    await mockSchoolApi(page, { me: PRINCIPAL_ME, handler: feesHandler() });
    await open(page, '/fees/structures');
    await expect(page.getByRole('table', { name: 'Fee structure 2026-27' })).toBeVisible();
    await expectNoSidewaysScroll(page);
    await page.goto('/fees/heads');
    await expect(page.getByRole('table')).toBeVisible();
    await expectNoSidewaysScroll(page);
  });
});

test.describe('payment accounts', () => {
  test('the principal adds and disables an account', async ({ page }) => {
    const added = account('pa2', { kind: 'jazzcash', title: 'Amina Principal', accountNo: '03001234567', bankName: null });
    const { requests } = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      handler: feesHandler(),
      replies: {
        'POST /payment-accounts': { status: 201, body: added },
        'POST /payment-accounts/pa1/disable': {
          status: 200,
          body: account('pa1', { status: 'disabled', disabledAt: STAMP, disableReason: 'Account closed' }),
        },
      },
    });
    await open(page, '/settings');

    await expect(page.getByText('An active account lets parents upload a deposit slip')).toBeVisible();
    await expect(page.getByText('PK36SCBL0000001123456702')).toBeVisible();

    await page.getByRole('button', { name: 'Add account' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Kind').selectOption('jazzcash');
    await expect(dialog.getByLabel('Bank (optional)')).toHaveCount(0);
    await dialog.getByLabel('Account title').fill('Amina Principal');
    // An identity-shaped number is refused before it is sent.
    await dialog.getByLabel('Wallet number').fill('35202 1234567 1');
    await dialog.getByRole('button', { name: 'Add account' }).click();
    await expect(dialog.getByText('This looks like an identity number.')).toBeVisible();
    await dialog.getByLabel('Wallet number').fill('0300 1234567');
    await dialog.getByRole('button', { name: 'Add account' }).click();
    await expect(dialog).toBeHidden();
    expect(calls(requests, 'POST', '/payment-accounts')[0].postDataJSON()).toEqual({
      kind: 'jazzcash',
      title: 'Amina Principal',
      accountNo: '03001234567',
    });

    await page.getByRole('button', { name: 'Disable Green Valley School' }).click();
    const confirm = page.getByRole('dialog');
    await confirm.getByLabel('Reason').fill('Account closed');
    await confirm.getByRole('button', { name: 'Disable' }).click();
    await expect(confirm).toBeHidden();
    expect(calls(requests, 'POST', '/payment-accounts/pa1/disable')[0].postDataJSON()).toEqual({
      reason: 'Account closed',
    });
  });

  test('a principal-only refusal is explained', async ({ page }) => {
    await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      handler: feesHandler({ accounts: [] }),
      replies: {
        'POST /payment-accounts': {
          status: 403,
          body: errorBody('PERMISSION_DENIED', 'Not allowed.', { reason: 'principal_required' }),
        },
      },
    });
    await open(page, '/settings');
    await expect(page.getByText('No payment accounts')).toBeVisible();
    await page.getByRole('button', { name: 'Add account' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Account title').fill('Green Valley School');
    await dialog.getByLabel('Account number or IBAN').fill('PK36 SCBL 0000 0011 2345 6702');
    await dialog.getByRole('button', { name: 'Add account' }).click();
    await expect(dialog.getByText('Only the principal can change where parents pay.')).toBeVisible();
  });

  test('office staff with the settings key see the accounts but cannot change them', async ({ page }) => {
    await mockSchoolApi(page, { me: OFFICE_WITH_SETTINGS, handler: feesHandler() });
    await open(page, '/settings');
    await expect(page.getByText('PK36SCBL0000001123456702')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add account' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Disable/ })).toHaveCount(0);
  });
});

test.describe('fee settings', () => {
  test('a late fee needs an amount; only the changed fields are sent', async ({ page }) => {
    const { requests } = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      handler: feesHandler(),
      replies: {
        'PATCH /school/settings': {
          status: 200,
          body: settings({ lateFeeEnabled: true, lateFeeAmount: 500, lateFeeEnabledAt: '2026-10-06T05:00:00.000Z' }),
        },
      },
    });
    await open(page, '/settings');

    await expect(page.getByLabel('Joining cut-off day')).toHaveValue('15');
    await expect(page.getByLabel('Late fee amount (Rs)')).toHaveCount(0);
    await page.getByLabel('Charge a late fee').check();
    await expect(page.getByLabel('Grace days after the due day')).toHaveValue('7');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Enter the late fee in whole rupees, from 1 to 10,000,000.')).toBeVisible();
    expect(calls(requests, 'PATCH', '/school/settings')).toHaveLength(0);

    await page.getByLabel('Late fee amount (Rs)').fill('500');
    await page.getByLabel('Pay day').selectOption('28');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Late fees on since')).toBeVisible();
    expect(calls(requests, 'PATCH', '/school/settings')[0].postDataJSON()).toEqual({
      lateFeeEnabled: true,
      lateFeeAmount: 500,
      payDay: 28,
    });
  });
});

test.describe('rule 24 and the sidebar', () => {
  test('a default password holds back account management, with a calm prompt', async ({ page }) => {
    const me: MeDto = {
      ...PRINCIPAL_ME,
      passwordIsDefault: true,
      capabilities: PRINCIPAL_ME.capabilities.filter(
        (c) => c !== Capability.ROLE_MANAGE && c !== Capability.USER_ACCOUNT_MANAGE,
      ),
      blockedCapabilities: [Capability.ROLE_MANAGE, Capability.USER_ACCOUNT_MANAGE],
    };
    await mockSchoolApi(page, {
      me,
      replies: {
        'GET /users': {
          status: 403,
          body: errorBody(
            'DEFAULT_PASSWORD_BLOCKS_ACTION',
            'Change your password first. Managing user accounts and roles is off while you use the default password.',
          ),
        },
      },
    });
    await open(page, '/users');
    const banner = page.getByTestId('blocked-capabilities-banner');
    await expect(banner).toContainText('Change your password to manage user accounts and roles.');
    await expect(banner.getByRole('link', { name: 'Change your password' })).toHaveAttribute('href', '/account');
    // The screen itself prompts rather than failing.
    await expect(page.getByText('Change your password first')).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('no banner once nothing is blocked', async ({ page }) => {
    await mockSchoolApi(page, { me: PRINCIPAL_ME, handler: feesHandler() });
    await open(page, '/fees/heads');
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByTestId('blocked-capabilities-banner')).toHaveCount(0);
  });

  test('Fees is in the sidebar for finance keys only', async ({ page }) => {
    await mockSchoolApi(page, { me: OFFICE_ME, handler: feesHandler() });
    await open(page, '/my-attendance');
    const nav = page.getByRole('complementary', { name: 'Main navigation' });
    await expect(nav.getByRole('link', { name: 'Fees' })).toHaveAttribute('href', '/fees');

    await page.unrouteAll();
    await mockSchoolApi(page, { me: TEACHER_ME, handler: feesHandler() });
    await open(page, '/my-attendance');
    await expect(nav.getByRole('link', { name: 'Calendar' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Fees' })).toHaveCount(0);
  });
});
