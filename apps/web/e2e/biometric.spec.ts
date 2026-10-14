import { expect as baseExpect, test } from '@playwright/test';
import { Capability } from '@asms/shared';
import type { MeDto } from '../lib/api/school-contract';
import type { SchoolSettingsDto } from '../lib/api/school-messaging-contract';
import type { StaffDto } from '../lib/api/school-staff-contract';
import type {
  AttendanceDisputeDto,
  DevicePunchDto,
  MyStaffAttendanceDto,
  StaffDayDto,
} from '../lib/api/school-staff-attendance-contract';
import { FINANCE_SETTINGS } from './support/settings';
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

// Biometric staff attendance and disputes (Phase 5 slice 44, contracts/slice-44.md §6) against a
// mocked API: the device token card (shown once, greyed on a default password), the device user id
// on the staff record, the day sheet's punch and conflict, the punches day view in its states, the
// disputes queue, a staff member's own dispute and withdrawal, and the Approvals section.

const expect = baseExpect.configure({ timeout: 15_000 });
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'; // pragma: allowlist secret

const OFFICE_DECIDER: MeDto = {
  ...OFFICE_ME,
  capabilities: [...OFFICE_ME.capabilities, Capability.ATTENDANCE_STAFF_MANAGE].sort(),
};

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

/** The settings page's other cards, answered so they render quietly. */
const settingsHandler =
  (current: () => SchoolSettingsDto): Handler =>
  ({ method, path }) => {
    if (method === 'GET' && path === '/school/settings') return { status: 200, body: current() };
    if (method === 'GET' && path === '/payment-accounts') return { status: 200, body: page1([]) };
    if (method === 'GET' && path === '/school/billing-status') return { status: 404, body: errorBody('NOT_FOUND', 'Not found.') };
    return undefined;
  };

const dispute = (id: string, extra: Partial<AttendanceDisputeDto> = {}): AttendanceDisputeDto => ({
  id,
  attendanceId: `sm-${id}`,
  staffId: 'st-1',
  staffName: 'Ayesha Malik',
  date: '2026-10-05',
  markStatus: 'absent',
  markSource: 'manual',
  requestedStatus: 'present',
  reason: 'I taught periods one to four',
  status: 'pending',
  createdAt: STAMP,
  decidedByName: null,
  decidedAt: null,
  decisionReason: null,
  withdrawnAt: null,
  ...extra,
});

// ---------------------------------------------------------------------------------- settings

test('settings: the device token is created once and shown once; afterwards only when it was made', async ({ page }) => {
  let rotatedAt: string | null = null;
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: (call) => {
      if (call.method === 'POST' && call.path === '/school/device-token/rotate') {
        rotatedAt = '2026-10-06T05:00:00.000Z';
        return { status: 200, body: { token: TOKEN, rotatedAt } };
      }
      return settingsHandler(() => settings({ deviceTokenRotatedAt: rotatedAt }))(call);
    },
  });
  await open(page, '/settings');
  const card = page.getByTestId('device-token-card');
  await expect(card.getByTestId('device-token-status')).toHaveText('No token yet: the device cannot send punches.');
  await card.getByRole('button', { name: 'Create token' }).click();
  await page.getByRole('dialog', { name: 'Create a device token?' }).getByRole('button', { name: 'Create token' }).click();
  const shown = page.getByRole('dialog', { name: 'The new device token' });
  await expect(shown.getByLabel('Device token')).toHaveValue(TOKEN);
  await shown.getByRole('button', { name: 'Done' }).click();
  await expect(shown).toBeHidden();
  await expect(card.getByTestId('device-token-status')).toContainText('A token is set, made');
  await expect(page.getByText(TOKEN)).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Replace token' })).toBeEnabled();
  expect(calls(requests, 'POST', '/school/device-token/rotate')).toHaveLength(1);
});

test('settings: "Turn off device" removes the token after a confirmation; it is absent without a token', async ({ page }) => {
  let rotatedAt: string | null = '2026-10-06T05:00:00.000Z';
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: (call) => {
      if (call.method === 'POST' && call.path === '/school/device-token/revoke') {
        rotatedAt = null;
        return { status: 200, body: { revoked: true } };
      }
      return settingsHandler(() => settings({ deviceTokenRotatedAt: rotatedAt }))(call);
    },
  });
  await open(page, '/settings');
  const card = page.getByTestId('device-token-card');
  await expect(card.getByTestId('device-token-status')).toContainText('A token is set, made');
  await card.getByRole('button', { name: 'Turn off device' }).click();
  const confirm = page.getByRole('dialog', { name: 'Turn off the biometric device?' });
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  expect(calls(requests, 'POST', '/school/device-token/revoke')).toHaveLength(0);
  await card.getByRole('button', { name: 'Turn off device' }).click();
  await confirm.getByRole('button', { name: 'Turn off device' }).click();
  await expect(page.getByText('The device is turned off. Its token no longer works.')).toBeVisible();
  await expect(card.getByTestId('device-token-status')).toHaveText('No token yet: the device cannot send punches.');
  await expect(card.getByRole('button', { name: 'Turn off device' })).toHaveCount(0);
  expect(calls(requests, 'POST', '/school/device-token/revoke')).toHaveLength(1);
});

test('settings: rotation is greyed on a default password; staff late after is saved, blank clears', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: { ...PRINCIPAL_ME, passwordIsDefault: true, blockedActions: ['device_token.rotate', 'device_token.revoke'] },
    handler: settingsHandler(() => settings({ staffLateAfter: '08:30', deviceTokenRotatedAt: '2026-10-06T05:00:00.000Z' })),
    replies: { 'PATCH /school/settings': { status: 200, body: settings({ staffLateAfter: null }) } },
  });
  await open(page, '/settings');
  await expect(page.getByTestId('device-token-card').getByRole('button', { name: 'Replace token' })).toBeDisabled();
  await expect(page.getByTestId('device-token-card').getByRole('button', { name: 'Turn off device' })).toBeDisabled();
  const lateAfter = page.getByLabel('Staff late after (biometric device)');
  await expect(lateAfter).toHaveValue('08:30');
  await lateAfter.fill('');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  expect(calls(requests, 'PATCH', '/school/settings')[0].postDataJSON()).toEqual({ staffLateAfter: null });
});

// -------------------------------------------------------------------------------- staff record

const STAFF: StaffDto = {
  id: 'st1',
  deviceUserId: null,
  fullName: 'Ayesha Malik',
  cnicMasked: '35201-*****-1',
  hasCnic: true,
  phone: '+923001234567',
  designation: 'Senior teacher',
  joinedOn: '2026-08-01',
  status: 'active',
  userId: 'u7',
  systemRoles: ['teacher'],
  customRoleNames: [],
  createdAt: STAMP,
  updatedAt: STAMP,
};

test('staff record: the device user id is set and cleared; one held by another is refused on the field', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: OFFICE_DECIDER,
    handler: ({ method, path }) => (method === 'GET' && path === '/staff/st1' ? { status: 200, body: STAFF } : undefined),
    replies: {
      'PATCH /staff/st1/device-user': [
        {
          status: 422,
          body: errorBody('VALIDATION_FAILED', 'Some fields are invalid.', {
            fields: [{ path: 'deviceUserId', code: 'INVALID_VALUE', message: 'deviceUserId is already used by another staff member' }],
          }),
        },
        { status: 200, body: { staffId: 'st1', deviceUserId: 'T-8' } },
      ],
    },
  });
  await open(page, '/staff/st1');
  const card = page.getByTestId('device-user-card');
  await card.getByLabel('Device user id').fill('T-7');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByText('deviceUserId is already used by another staff member')).toBeVisible();
  await card.getByLabel('Device user id').fill('T-8');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Device user id set to T-8.')).toBeVisible();
  expect(calls(requests, 'PATCH', '/staff/st1/device-user').map((r) => r.postDataJSON())).toEqual([
    { deviceUserId: 'T-7' },
    { deviceUserId: 'T-8' },
  ]);
  await card.getByLabel('Device user id').fill('has space');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByText('Use 1 to 40 letters, digits or symbols, with no spaces.')).toBeVisible();
  expect(calls(requests, 'PATCH', '/staff/st1/device-user')).toHaveLength(2);
});

test('staff record: one\'s own device user id is shown, not editable; without the key the card is absent', async ({ page }) => {
  await mockSchoolApi(page, {
    me: OFFICE_DECIDER,
    handler: ({ path }) => (path === '/staff/st-o' ? { status: 200, body: { ...STAFF, id: 'st-o', userId: 'u-office', deviceUserId: 'O-1' } } : undefined),
  });
  await open(page, '/staff/st-o');
  const card = page.getByTestId('device-user-card');
  await expect(card).toContainText('Your own device user id is set by another member of staff.');
  await expect(card).toContainText('O-1');
  await expect(card.getByLabel('Device user id')).toHaveCount(0);
});

// ------------------------------------------------------------------------------ the day sheet

const sheetRow = (extra: Partial<StaffDayDto>): StaffDayDto => ({
  staffId: 'st-1',
  fullName: 'Ayesha Malik',
  designation: 'Teacher',
  staffStatus: 'active',
  mark: null,
  approvedLeave: null,
  disputeId: null,
  disputeStatus: null,
  punch: null,
  punchConflict: false,
  ...extra,
});

test('day sheet: a device mark, a punch beside an office "absent" flagged as a conflict, a pending dispute', async ({ page }) => {
  const mark = (id: string, staffId: string, status: 'present' | 'absent', source: 'manual' | 'device') => ({
    id,
    staffId,
    date: TODAY,
    status,
    note: null,
    markedBy: source === 'device' ? null : 'u-office',
    markedByName: source === 'device' ? null : 'Bilal Office',
    source,
    markedAt: '2026-10-06T03:01:00.000Z',
    amended: false,
    lastAmendedAt: null,
    lastAmendedByName: null,
  });
  await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: ({ path }) =>
      path === '/staff-attendance'
        ? {
            status: 200,
            body: page1([
              sheetRow({ mark: mark('m1', 'st-1', 'present', 'device'), punch: { firstPunchAt: '2026-10-06T03:01:00.000Z', count: 2 } }),
              sheetRow({
                staffId: 'st-2',
                fullName: 'Imran Ali',
                mark: mark('m2', 'st-2', 'absent', 'manual'),
                punch: { firstPunchAt: '2026-10-06T03:05:00.000Z', count: 1 },
                punchConflict: true,
                disputeId: 'd1',
                disputeStatus: 'pending',
              }),
            ]),
          }
        : undefined,
  });
  await open(page, '/staff-attendance');
  const device = page.locator('tr[data-staff="st-1"]');
  await expect(device).toContainText('Biometric device');
  await expect(device.getByTestId('staff-punch')).toContainText('(+1 more)');
  await expect(device.getByTestId('punch-conflict')).toHaveCount(0);
  const office = page.locator('tr[data-staff="st-2"]');
  await expect(office.getByTestId('punch-conflict')).toHaveText('Conflict');
  await expect(office.getByTestId('staff-disputed')).toHaveAttribute('href', '/staff-attendance/disputes');
  await expect(page.getByRole('link', { name: 'Device punches' })).toHaveAttribute('href', '/staff-attendance/punches');
});

// ------------------------------------------------------------------------------- punches view

const punch = (id: string, extra: Partial<DevicePunchDto>): DevicePunchDto => ({
  id,
  deviceUserId: 'T-1',
  staffId: 'st-1',
  staffName: 'Ayesha Malik',
  punchedAt: '2026-10-06T03:01:00.000Z',
  direction: 'in',
  outcome: 'marked',
  receivedAt: '2026-10-06T03:02:00.000Z',
  staffAttendanceId: 'm1',
  ...extra,
});

test('punches: the day in punch order; unknown users filtered; empty, error and no-permission states', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: OFFICE_DECIDER,
    handler: ({ path, url }) => {
      if (path !== '/device-punches') return undefined;
      if (url.searchParams.get('date') === '2026-10-05') return { status: 200, body: page1([]) };
      if (url.searchParams.get('date') === '2026-10-04') return { status: 500, body: errorBody('INTERNAL_ERROR', 'Something went wrong.') };
      const rows = [
        punch('p1', {}),
        punch('p2', { deviceUserId: 'X-9', staffId: null, staffName: null, outcome: 'unmapped', staffAttendanceId: null, direction: null }),
        punch('p3', { punchedAt: '2026-10-06T08:00:00.000Z', outcome: 'stored', direction: 'out', staffAttendanceId: null }),
      ];
      return { status: 200, body: page1(url.searchParams.get('unmapped') === 'true' ? rows.filter((r) => r.staffId === null) : rows) };
    },
  });
  await open(page, '/staff-attendance/punches');
  const table = page.getByTestId('punches-table');
  await expect(table.locator('tbody tr')).toHaveCount(3);
  await expect(table.locator('tr[data-punch="p2"]')).toContainText('Unknown device user');
  await expect(table.locator('tr[data-punch="p2"]')).toContainText('Nobody');
  await page.getByLabel('Show').selectOption('unmapped');
  await expect(table.locator('tbody tr')).toHaveCount(1);
  expect(new URL(calls(requests, 'GET', '/device-punches').at(-1)!.url()).searchParams.get('unmapped')).toBe('true');
  await page.setViewportSize(TABLET);
  await expectNoSidewaysScroll(page);
  await page.getByLabel('Date').fill('2026-10-05');
  await expect(page.getByText('Nothing came from the device for this day.')).toBeVisible();
  await page.getByLabel('Date').fill('2026-10-04');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('punches: without attendance.staff.manage the page says so', async ({ page }) => {
  await mockSchoolApi(page, {
    me: TEACHER_ME,
    handler: ({ path }) => (path === '/device-punches' ? { status: 403, body: errorBody('PERMISSION_DENIED', 'No.') } : undefined),
  });
  await open(page, '/staff-attendance/punches');
  await expect(page.getByText('You do not have access')).toBeVisible();
});

// ------------------------------------------------------------------------------ disputes queue

test('disputes: approve with an optional note, reject with a reason, one\'s own is not decidable', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: OFFICE_DECIDER,
    handler: ({ method, path }) =>
      method === 'GET' && path === '/staff-attendance-disputes'
        ? {
            status: 200,
            body: page1([
              dispute('d1'),
              dispute('d2', { staffName: 'Imran Ali', staffId: 'st-2', requestedStatus: 'late', markSource: 'device', markStatus: 'present' }),
              dispute('d3', { staffName: 'Bilal Office', staffId: 'st-o' }),
            ]),
          }
        : undefined,
    replies: {
      'POST /staff-attendance-disputes/d1/approve': { status: 200, body: dispute('d1', { status: 'approved', markStatus: 'present' }) },
      'POST /staff-attendance-disputes/d2/reject': { status: 200, body: dispute('d2', { status: 'rejected', staffName: 'Imran Ali' }) },
    },
  });
  await open(page, '/staff-attendance/disputes');
  const table = page.getByTestId('disputes-table');
  await expect(table.locator('tr[data-dispute="d2"]')).toContainText('marked by the device');
  const own = table.locator('tr[data-dispute="d3"]');
  await expect(own).toContainText('your own');
  await expect(own).toContainText('A colleague decides this');
  await expect(own.getByRole('button', { name: 'Approve' })).toHaveCount(0);

  await table.locator('tr[data-dispute="d1"]').getByRole('button', { name: 'Approve' }).click();
  const approve = page.getByRole('dialog', { name: 'Approve the dispute?' });
  await expect(approve).toContainText('becomes Present');
  await approve.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Dispute of Ayesha Malik approved.')).toBeVisible();
  expect(calls(requests, 'POST', '/staff-attendance-disputes/d1/approve')[0].postDataJSON()).toEqual({});

  await table.locator('tr[data-dispute="d2"]').getByRole('button', { name: 'Reject' }).click();
  const reject = page.getByRole('dialog', { name: "Reject Imran Ali's dispute?" });
  await reject.getByLabel('Reason').fill('The gate log shows nine');
  await reject.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText('Dispute of Imran Ali rejected.')).toBeVisible();
  expect(calls(requests, 'POST', '/staff-attendance-disputes/d2/reject')[0].postDataJSON()).toEqual({ reason: 'The gate log shows nine' });
  const q = new URL(calls(requests, 'GET', '/staff-attendance-disputes')[0].url()).searchParams;
  expect(q.get('status')).toBe('pending');
  await page.setViewportSize(TABLET);
  await expectNoSidewaysScroll(page);
});

test('disputes: deciding one\'s own is explained; an empty queue says so', async ({ page }) => {
  await mockSchoolApi(page, {
    me: OFFICE_DECIDER,
    handler: ({ method, path, url }) =>
      method === 'GET' && path === '/staff-attendance-disputes'
        ? { status: 200, body: page1(url.searchParams.get('status') === 'pending' ? [dispute('d1')] : []) }
        : undefined,
    replies: {
      'POST /staff-attendance-disputes/d1/approve': {
        status: 409,
        body: errorBody('SELF_ACTION_FORBIDDEN', 'Nobody decides a dispute of their own attendance.', { reason: 'own_attendance' }),
      },
    },
  });
  await open(page, '/staff-attendance/disputes');
  await page.locator('tr[data-dispute="d1"]').getByRole('button', { name: 'Approve' }).click();
  await page.getByRole('dialog', { name: 'Approve the dispute?' }).getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('You cannot decide a dispute of your own attendance. Ask a colleague.')).toBeVisible();
  await page.getByLabel('Status').selectOption('approved');
  await expect(page.getByText('None match this filter.')).toBeVisible();
});

// ----------------------------------------------------------------------------- my attendance

test('my attendance: dispute a marked day with a key and a reason; withdraw a pending dispute', async ({ page }) => {
  const mine: MyStaffAttendanceDto = {
    staffId: 'st-t',
    dateFrom: '2026-10-01',
    dateTo: '2026-10-31',
    workingDays: 27,
    present: 1,
    absent: 1,
    late: 0,
    onLeave: 0,
    unrecorded: 25,
    days: Array.from({ length: 31 }, (_, i) => {
      const date = `2026-10-${String(i + 1).padStart(2, '0')}`;
      const status = date === '2026-10-02' ? ('absent' as const) : date === '2026-10-01' ? ('present' as const) : null;
      return {
        date,
        workingDay: true,
        employed: true,
        status,
        amended: false,
        markId: status ? `m-${date}` : null,
        source: status === 'present' ? ('device' as const) : status ? ('manual' as const) : null,
        disputeId: date === '2026-10-01' ? 'd9' : null,
        disputeStatus: date === '2026-10-01' ? ('pending' as const) : null,
      };
    }),
  };
  const { requests } = await mockSchoolApi(page, {
    me: TEACHER_ME,
    handler: ({ method, path }) => {
      if (method === 'GET' && path === '/me/staff/attendance') return { status: 200, body: mine };
      if (method === 'GET' && path === '/me/staff/attendance-disputes') {
        return { status: 200, body: page1([dispute('d9', { staffId: 'st-t', staffName: 'Ayesha Malik', date: '2026-10-01', markStatus: 'present', requestedStatus: 'late' })]) };
      }
      return undefined;
    },
    replies: {
      'POST /me/staff/attendance-disputes': { status: 201, body: dispute('d10', { staffId: 'st-t', date: '2026-10-02' }) },
      'POST /me/staff/attendance-disputes/d9/withdraw': { status: 200, body: dispute('d9', { status: 'withdrawn' }) },
    },
  });
  await open(page, '/my-attendance');
  const marks = page.getByTestId('my-marks');
  await expect(marks.locator('[data-day="2026-10-01"]')).toContainText('Dispute pending');
  await expect(marks.locator('[data-day="2026-10-01"]').getByRole('button', { name: 'Dispute' })).toHaveCount(0);
  await marks.locator('[data-day="2026-10-02"]').getByRole('button', { name: 'Dispute' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Send dispute' })).toBeDisabled();
  await dialog.getByLabel('It should say').selectOption('present');
  await dialog.getByLabel('Reason').fill('I taught periods one to four');
  await dialog.getByRole('button', { name: 'Send dispute' }).click();
  await expect(page.getByText('Dispute sent. You will be told the decision.')).toBeVisible();
  const raised = calls(requests, 'POST', '/me/staff/attendance-disputes')[0];
  expect(raised.postDataJSON()).toEqual({ attendanceId: 'm-2026-10-02', requestedStatus: 'present', reason: 'I taught periods one to four' });
  expect(raised.headers()['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{16,64}$/);

  await page.getByTestId('my-disputes').locator('[data-dispute="d9"]').getByRole('button', { name: 'Withdraw' }).click();
  await expect(page.getByText('Dispute withdrawn.')).toBeVisible();
  expect(calls(requests, 'POST', '/me/staff/attendance-disputes/d9/withdraw')).toHaveLength(1);
  await page.setViewportSize(TABLET);
  await expectNoSidewaysScroll(page);
});

// --------------------------------------------------------------------------------- Approvals

test('approvals: the disputes section for attendance.staff.manage holders, one\'s own flagged', async ({ page }) => {
  await mockSchoolApi(page, {
    me: OFFICE_DECIDER,
    handler: ({ path }) =>
      path === '/me/approvals'
        ? { status: 200, body: { disputes: { count: 2, items: [dispute('d1'), dispute('d3', { staffId: 'st-o', staffName: 'Bilal Office' })] } } }
        : undefined,
  });
  await open(page, '/approvals');
  const section = page.getByTestId('approvals.disputes');
  await expect(section.getByTestId('approvals.disputes.count')).toHaveText('2');
  await expect(section).toContainText('Absent → Present');
  await expect(section).toContainText('your own');
  await expect(section.getByRole('link', { name: 'Open queue' })).toHaveAttribute('href', '/staff-attendance/disputes');
});
