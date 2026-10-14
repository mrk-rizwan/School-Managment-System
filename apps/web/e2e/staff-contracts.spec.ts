import { expect as baseExpect, test } from '@playwright/test';
import type { StaffContractDto } from '../lib/api/school-staff-contracts-contract';
import type { StaffDto } from '../lib/api/school-staff-contract';
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
  type Handler,
} from './support/wave-e';

// Staff contracts (phase-5-extended.md slice 39, contracts/slice-39.md §6) against a mocked API:
// the Contracts tab's four states, add with a scan and a key, renew from the day after, end with a
// reason, End employment opening the status change at "left", the ending list and the Approvals
// tile; the tab hidden without staff.contract.manage; tablet width.

const expect = baseExpect.configure({ timeout: 15_000 });
const KEY = /^[A-Za-z0-9_-]{16,64}$/;

const STAFF: StaffDto = {
  id: 'st1',
  deviceUserId: null,
  fullName: 'Rabia Teacher',
  cnicMasked: '35201-*****-1',
  hasCnic: true,
  phone: '+923001234567',
  designation: 'Science teacher',
  joinedOn: '2025-04-01',
  status: 'active',
  userId: 'u-st1',
  systemRoles: ['teacher'],
  customRoleNames: [],
  createdAt: STAMP,
  updatedAt: STAMP,
};

const contract = (extra: Partial<StaffContractDto>): StaffContractDto => ({
  id: 'k1',
  staffId: 'st1',
  staffName: 'Rabia Teacher',
  type: 'fixed_term',
  startsOn: '2026-01-01',
  endsOn: '2026-10-31',
  status: 'live',
  daysLeft: 25,
  salaryStructureId: 'ss1',
  hasDocument: true,
  documentMime: 'application/pdf',
  note: 'Science post',
  createdByName: 'Amina Principal',
  createdAt: STAMP,
  endedAt: null,
  endedOn: null,
  endReason: null,
  endedByName: null,
  ...extra,
});

const CURRENT = contract({});
const RENEWED = contract({
  id: 'k0',
  startsOn: '2025-04-01',
  endsOn: '2025-12-31',
  status: 'ended',
  daysLeft: null,
  hasDocument: false,
  documentMime: null,
  note: null,
  endedAt: STAMP,
  endedOn: '2025-12-31',
  endReason: 'renewed',
  endedByName: 'Amina Principal',
});

const staffHandler =
  (contracts: StaffContractDto[]): Handler =>
  ({ method, path }) => {
    if (method === 'GET' && path === '/staff/st1') return { status: 200, body: STAFF };
    if (method === 'GET' && path === '/staff/st1/contracts') return { status: 200, body: page1(contracts) };
    return undefined;
  };

test.describe('Staff contracts', () => {
  test('the tab lists the current and renewed contracts; renew starts the day after; end needs a reason', async ({ page }) => {
    const { requests, unmocked } = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      handler: staffHandler([CURRENT, RENEWED]),
      replies: {
        'POST /staff-contracts/k1/renew': { status: 201, body: contract({ id: 'k2', startsOn: '2026-11-01', endsOn: '2027-10-31', status: 'upcoming' }) },
        'POST /staff-contracts/k1/end': { status: 200, body: { ...CURRENT, status: 'ended', endedOn: '2026-10-06', endReason: 'Moved city' } },
      },
    });
    await open(page, '/staff/st1?tab=contracts');

    const current = page.getByTestId('staff.contract.k1');
    await expect(current).toContainText('Fixed term ·');
    await expect(current).toContainText('25 days left');
    await expect(current).toContainText('Current');
    await expect(page.getByTestId('staff.contract.k0')).toContainText('(renewed), by Amina Principal');
    // A live contract exists: no Add.
    await expect(page.getByRole('button', { name: 'Add contract' })).toHaveCount(0);

    await current.getByRole('button', { name: 'Renew' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Starts on')).toHaveValue('2026-11-01');
    await expect(dialog.getByLabel('Starts on')).toBeDisabled();
    await dialog.getByLabel('Last working day').fill('2027-10-31');
    await dialog.getByRole('button', { name: 'Renew' }).click();
    await expect(page.getByText('Contract renewed.')).toBeVisible();
    expect(calls(requests, 'POST', '/staff-contracts/k1/renew')[0]!.postDataJSON()).toEqual({
      type: 'fixed_term',
      startsOn: '2026-11-01',
      endsOn: '2027-10-31',
    });

    await current.getByRole('button', { name: 'End contract' }).click();
    const end = page.getByRole('dialog');
    await expect(end.getByLabel('Actual last day')).toHaveValue('2026-10-06');
    await expect(end.getByRole('button', { name: 'End contract' })).toBeDisabled();
    await end.getByLabel('Reason').fill('Moved city');
    await end.getByRole('button', { name: 'End contract' }).click();
    await expect(page.getByText('Contract ended.')).toBeVisible();
    expect(calls(requests, 'POST', '/staff-contracts/k1/end')[0]!.postDataJSON()).toEqual({ endedOn: '2026-10-06', reason: 'Moved city' });
    expect(unmocked).toEqual([]);
  });

  test('empty, then add a fixed-term contract with its scan under one idempotency key', async ({ page }) => {
    const { requests, unmocked } = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      handler: staffHandler([]),
      replies: {
        'POST /uploads': { status: 201, body: { id: 'up1', mime: 'application/pdf', sizeBytes: 12, expiresAt: STAMP } },
        'POST /staff/st1/contracts': { status: 201, body: CURRENT },
      },
    });
    await open(page, '/staff/st1?tab=contracts');
    await expect(page.getByText('No contract recorded')).toBeVisible();

    await page.getByRole('button', { name: 'Add contract' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Starts on').fill('2026-01-01');
    // Fixed term needs its last day before saving.
    await expect(dialog.getByRole('button', { name: 'Add contract' })).toBeDisabled();
    await dialog.getByLabel('Last working day').fill('2026-10-31');
    await dialog.getByLabel('Note (optional, staff do not see it)').fill('Science post');
    await dialog.getByLabel(/Signed contract/).setInputFiles({ name: 'contract.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') });
    await dialog.getByRole('button', { name: 'Add contract' }).click();
    await expect(page.getByText('Contract added.')).toBeVisible();

    const post = calls(requests, 'POST', '/staff/st1/contracts')[0]!;
    expect(post.headers()['idempotency-key']).toMatch(KEY);
    expect(post.postDataJSON()).toEqual({
      type: 'fixed_term',
      startsOn: '2026-01-01',
      endsOn: '2026-10-31',
      note: 'Science post',
      stagedUploadId: 'up1',
    });
    expect(unmocked).toEqual([]);
  });

  test('a permanent contract sends no end; a refusal is shown in the dialog', async ({ page }) => {
    await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      handler: staffHandler([]),
      replies: {
        'POST /staff/st1/contracts': {
          status: 409,
          body: errorBody('STAFF_CONTRACT_LIVE_EXISTS', 'This staff member already has a live contract.', { staffId: 'st1', contractId: 'k9' }),
        },
      },
    });
    await open(page, '/staff/st1?tab=contracts');
    await page.getByRole('button', { name: 'Add contract' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Type').selectOption('permanent');
    await expect(dialog.getByLabel('Last working day')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Add contract' }).click();
    await expect(dialog.getByText('already has a current contract')).toBeVisible();
  });

  test('End employment opens the status change set to "left"; an expired contract says nothing changes on its own', async ({ page }) => {
    const { requests } = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      handler: staffHandler([contract({ endsOn: '2026-09-30', status: 'expired', daysLeft: -6 })]),
      replies: { 'POST /staff/st1/change-status': { status: 200, body: { ...STAFF, status: 'left' } } },
    });
    await open(page, '/staff/st1?tab=contracts');
    const card = page.getByTestId('staff.contract.k1');
    await expect(card).toContainText('Expired, not ended');
    await expect(card).toContainText('Ended its term 6 days ago');
    await expect(card).toContainText('Nothing changes on its own');

    await card.getByRole('button', { name: 'End employment' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('New status')).toHaveValue('left');
    await dialog.getByLabel('Reason').fill('Contract not renewed');
    await dialog.getByRole('button', { name: 'Mark as left' }).click();
    await expect.poll(() => calls(requests, 'POST', '/staff/st1/change-status').length).toBe(1);
    expect(calls(requests, 'POST', '/staff/st1/change-status')[0]!.postDataJSON()).toEqual({ status: 'left', reason: 'Contract not renewed' });
  });

  test('loading, then an error with a retry', async ({ page }) => {
    let fail = true;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await mockSchoolApi(page, { me: PRINCIPAL_ME, handler: staffHandler([CURRENT]) });
    // Registered later, so it answers first.
    await page.route('**/api/v1/staff/st1/contracts**', async (route) => {
      if (fail) {
        await held;
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify(errorBody('INTERNAL_ERROR', 'Database unavailable.')) });
      }
      return route.fallback();
    });
    await open(page, '/staff/st1');
    await page.getByRole('tab', { name: 'Contracts' }).click();
    await expect(page.getByTestId('staff.contracts').getByRole('status', { name: 'Loading' })).toBeVisible();
    release();
    await expect(page.getByText('Something went wrong')).toBeVisible();
    fail = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByTestId('staff.contract.k1')).toBeVisible();
  });

  test('office staff without staff.contract.manage see no Contracts tab', async ({ page }) => {
    await mockSchoolApi(page, { me: OFFICE_ME, handler: staffHandler([CURRENT]) });
    await open(page, '/staff/st1');
    await expect(page.getByRole('tab', { name: 'Details' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Contracts' })).toHaveCount(0);
  });

  test('the ending list and the Approvals tile; tablet width never scrolls sideways', async ({ page }) => {
    const ending = [contract({ endsOn: '2026-09-30', status: 'expired', daysLeft: -6 }), contract({ id: 'k3', staffId: 'st3', staffName: 'Kamran Lab', endsOn: '2026-10-20', daysLeft: 14 })];
    const { requests } = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      handler: (call) =>
        call.method === 'GET' && call.path === '/staff-contracts' ? { status: 200, body: page1(ending) } : staffHandler([CURRENT])(call),
      replies: { 'GET /me/approvals': { status: 200, body: {} } },
    });
    await page.setViewportSize(TABLET);
    await open(page, '/staff/contracts');
    const table = page.getByTestId('contracts.ending');
    await expect(table.getByRole('link', { name: 'Kamran Lab' })).toHaveAttribute('href', '/staff/st3?tab=contracts');
    await expect(table).toContainText('Expired, not ended');
    expect(new URL(calls(requests, 'GET', '/staff-contracts')[0]!.url()).searchParams.get('endsBy')).toBe('2026-11-05');
    await expectNoSidewaysScroll(page);

    await open(page, '/approvals');
    const tile = page.getByTestId('approvals.tile.contracts');
    await expect(tile).toContainText('2');
    await expect(tile).toHaveAttribute('href', '/staff/contracts');

    await open(page, '/staff/st1?tab=contracts');
    await expectNoSidewaysScroll(page);
  });

  test('no contract is ending: the list says so', async ({ page }) => {
    await mockSchoolApi(page, { me: PRINCIPAL_ME, handler: ({ method, path }) => (method === 'GET' && path === '/staff-contracts' ? { status: 200, body: page1([]) } : undefined) });
    await open(page, '/staff/contracts');
    await expect(page.getByText('No contract is ending')).toBeVisible();
  });
});
