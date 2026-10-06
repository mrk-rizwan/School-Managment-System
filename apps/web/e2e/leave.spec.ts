import { expect as baseExpect, test } from '@playwright/test';
import type { StaffDto } from '../lib/api/school-staff-contract';
import type { LeaveBalanceDto, LeaveRequestDto, LeaveTypeDto } from '../lib/api/school-leave-contract';
import {
  OFFICE_ME,
  PRINCIPAL_ME,
  STAMP,
  TEACHER_ME,
  TODAY,
  calls,
  errorBody,
  mockSchoolApi,
  open,
  page1,
  type Handler,
} from './support/wave-e';

// Staff leave (phase-3-financial.md slice 24) against a mocked API: My leave (balance, request,
// cancel), the approvers' queue with the cover picker, reject and end early.

const expect = baseExpect.configure({ timeout: 15_000 });

const TYPES: LeaveTypeDto[] = [
  { id: 'lt-c', name: 'Casual leave', code: 'casual', daysPerYear: 10, paid: true, status: 'active', archivedAt: null, seeded: true },
  { id: 'lt-u', name: 'Unpaid leave', code: 'unpaid', daysPerYear: null, paid: false, status: 'active', archivedAt: null, seeded: true },
];

const BALANCE: LeaveBalanceDto = {
  year: 2026,
  types: [
    { leaveTypeId: 'lt-c', name: 'Casual leave', code: 'casual', paid: true, entitlement: 10, used: 3, pending: 2, balance: 7 },
    { leaveTypeId: 'lt-u', name: 'Unpaid leave', code: 'unpaid', paid: false, entitlement: null, used: 0, pending: 0, balance: null },
  ],
};

const request = (extra: Partial<LeaveRequestDto> = {}): LeaveRequestDto => ({
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
  ...extra,
});

const TEACHERS = [
  { id: 'st-t', fullName: 'Ayesha Malik' },
  { id: 'st-2', fullName: 'Imran Ali' },
] as unknown as StaffDto[];

const leaveHandler: Handler = ({ method, path }) => {
  if (method === 'GET' && path === '/leave-types') return { status: 200, body: page1(TYPES) };
  if (method === 'GET' && path === '/me/staff/leave-balance') return { status: 200, body: BALANCE };
  if (method === 'GET' && path === '/me/staff/leave-requests') return { status: 200, body: page1([request()]) };
  if (method === 'GET' && path === '/leave-requests') return { status: 200, body: page1([request(), request({ id: 'lr-2', status: 'approved', startsOn: '2026-10-02', endsOn: '2026-10-09', sectionsNeedingCover: [] })]) };
  if (method === 'GET' && path === '/staff') return { status: 200, body: page1(TEACHERS) };
  return undefined;
};

test('My leave: the balance, a request sent once with its key, a balance refusal explained, cancel with a reason', async ({ page }) => {
  const { requests, unmocked } = await mockSchoolApi(page, {
    me: TEACHER_ME,
    handler: leaveHandler,
    replies: {
      'POST /me/staff/leave-requests': [
        { status: 409, body: errorBody('LEAVE_BALANCE_EXCEEDED', 'Not enough.', { balance: 1, year: 2026 }) },
        { status: 201, body: request({ id: 'lr-9' }) },
      ],
      'POST /me/staff/leave-requests/lr-1/cancel': { status: 200, body: request({ status: 'cancelled' }) },
    },
  });
  await open(page, '/my-leave');
  await expect(page.getByTestId('balance-lt-c')).toContainText('7 of 10 left');
  await expect(page.getByTestId('balance-lt-c')).toContainText('2 pending');
  await expect(page.getByTestId('balance-lt-u')).toContainText('0 taken');

  await page.getByRole('button', { name: 'Request leave' }).click();
  const dialog = page.getByRole('dialog', { name: 'Request leave' });
  await dialog.getByLabel('Type').selectOption('lt-c');
  await dialog.getByLabel('First day').fill('2026-10-12');
  await dialog.getByLabel('Last day').fill('2026-10-13');
  await dialog.getByLabel('Reason').fill('Family wedding');
  await dialog.getByRole('button', { name: 'Send request' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Not enough leave left: 1 working day.');
  await dialog.getByRole('button', { name: 'Send request' }).click();
  await expect(dialog).toBeHidden();
  const posts = calls(requests, 'POST', '/me/staff/leave-requests');
  expect(posts.map((p) => p.postDataJSON())).toEqual([
    { leaveTypeId: 'lt-c', startsOn: '2026-10-12', endsOn: '2026-10-13', reason: 'Family wedding' },
    { leaveTypeId: 'lt-c', startsOn: '2026-10-12', endsOn: '2026-10-13', reason: 'Family wedding' },
  ]);
  // One key per opening of the form: the retry replays, never duplicates.
  expect(posts[1].headers()['idempotency-key']).toBe(posts[0].headers()['idempotency-key']);

  await page.getByRole('button', { name: 'Actions for Casual leave' }).click();
  await page.getByRole('menuitem', { name: 'Cancel request' }).click();
  const confirm = page.getByRole('dialog', { name: 'Cancel this request?' });
  await confirm.getByLabel('Reason').fill('Plans changed');
  await confirm.getByRole('button', { name: 'Cancel the request' }).click();
  await expect(confirm).toBeHidden();
  expect(calls(requests, 'POST', '/me/staff/leave-requests/lr-1/cancel')[0].postDataJSON()).toEqual({ reason: 'Plans changed' });
  expect(unmocked).toEqual([]);
  expect(TODAY).toBe('2026-10-06');
});

test('approvers: approve with the cover picker; end early records a reason', async ({ page }) => {
  const { requests, unmocked } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: leaveHandler,
    replies: {
      'POST /leave-requests/lr-1/approve': { status: 200, body: request({ status: 'approved', coverAssignmentId: 'ta-9', sectionsNeedingCover: [] }) },
      // Ended on a past day: the cover could only end yesterday, and the toast says so.
      'POST /leave-requests/lr-2/end-early': {
        status: 200,
        body: request({ id: 'lr-2', status: 'ended_early', endedEarlyOn: '2026-10-04', coverAssignmentId: 'ta-8', coverEndedOn: '2026-10-05' }),
      },
    },
  });
  await open(page, '/leave');
  await expect(page.getByRole('heading', { name: 'Staff leave' })).toBeVisible();
  await expect(page.getByRole('row', { name: /Ayesha Malik.*Class 5 A/ }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Actions for Ayesha Malik' }).first().click();
  await page.getByRole('menuitem', { name: 'Approve' }).click();
  const approve = page.getByRole('dialog', { name: 'Approve leave: Ayesha Malik' });
  // The person on leave is not offered as their own cover.
  await expect(approve.getByLabel('Covering teacher').locator('option')).toHaveText(['No cover now', 'Imran Ali']);
  await approve.getByLabel('Covering teacher').selectOption('st-2');
  await approve.getByRole('button', { name: 'Approve' }).click();
  await expect(approve).toBeHidden();
  expect(calls(requests, 'POST', '/leave-requests/lr-1/approve')[0].postDataJSON()).toEqual({
    cover: { sectionId: 'sec-a', coverStaffId: 'st-2' },
  });

  await page.getByRole('button', { name: 'Actions for Ayesha Malik' }).nth(1).click();
  await page.getByRole('menuitem', { name: 'End early' }).click();
  const end = page.getByRole('dialog', { name: 'End leave early: Ayesha Malik' });
  await expect(end.getByLabel('Last day of leave')).toHaveValue(TODAY);
  await end.getByLabel('Last day of leave').fill('2026-10-04');
  await end.getByLabel('Reason').fill('Came back early');
  await end.getByRole('button', { name: 'End early' }).click();
  await expect(end).toBeHidden();
  await expect(page.getByText(/Leave ended early\. Its cover ended on .*5 Oct/)).toBeVisible();
  expect(calls(requests, 'POST', '/leave-requests/lr-2/end-early')[0].postDataJSON()).toEqual({
    endedOn: '2026-10-04',
    reason: 'Came back early',
  });
  // The leave types section is there for a settings manager.
  await expect(page.getByRole('heading', { name: 'Leave types' })).toBeVisible();
  expect(unmocked).toEqual([]);
});

test('a teacher sees My leave but not the approvers’ page in the sidebar', async ({ page }) => {
  await mockSchoolApi(page, { me: TEACHER_ME, handler: leaveHandler });
  await open(page, '/my-leave');
  const nav = page.getByRole('navigation').first();
  await expect(nav.getByRole('link', { name: 'My leave' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Staff leave' })).toHaveCount(0);
});

test('an approver without class.manage approves without a cover and is told why', async ({ page }) => {
  const capabilities = [...OFFICE_ME.capabilities, 'staff.leave.approve' as const].sort();
  const { requests } = await mockSchoolApi(page, {
    me: { ...OFFICE_ME, capabilities },
    handler: leaveHandler,
    replies: { 'POST /leave-requests/lr-1/approve': { status: 200, body: request({ status: 'approved', sectionsNeedingCover: [] }) } },
  });
  await open(page, '/leave');
  await page.getByRole('button', { name: 'Actions for Ayesha Malik' }).first().click();
  await page.getByRole('menuitem', { name: 'Approve' }).click();
  const approve = page.getByRole('dialog', { name: 'Approve leave: Ayesha Malik' });
  await expect(approve.getByTestId('cover-not-allowed')).toContainText('Assigning a cover needs permission to manage classes');
  await expect(approve.getByLabel('Covering teacher')).toHaveCount(0);
  await approve.getByRole('button', { name: 'Approve' }).click();
  await expect(approve).toBeHidden();
  expect(calls(requests, 'POST', '/leave-requests/lr-1/approve')[0].postDataJSON()).toEqual({});
});
