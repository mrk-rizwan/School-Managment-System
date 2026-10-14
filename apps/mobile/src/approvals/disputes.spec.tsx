import { ErrorCode } from '@asms/shared';
import { fireEvent, screen } from '@testing-library/react-native';
import type { AttendanceDisputeDto } from '../api/contracts';
import { queryClient } from '../api/query-client';
import { LANES, ONLINE_ONLY_ACTIONS } from '../outbox/lanes';
import { errorBody, resetDevice, type FakeApi } from '../test/fake-api';
import { meFixture } from '../test/fixtures';
import { eventually, renderSignedIn, setOnline } from '../test/screen';
import { ApprovalsScreen } from './ApprovalsScreen';

// Phase 5 slice 44 (contracts/slice-44.md §2.6, §6; R346, R347): the Disputes section of the
// Approvals tab. Approve and reject are online-only; one's own dispute offers no decision.

const APPROVALS = 'GET /api/v1/me/approvals';

const dispute = (id: string, extra: Partial<AttendanceDisputeDto> = {}): AttendanceDisputeDto => ({
  id,
  attendanceId: `7${id}`,
  staffId: '12',
  staffName: 'Rabia Teacher',
  date: '2026-10-05',
  markStatus: 'absent',
  markSource: 'manual',
  requestedStatus: 'present',
  reason: 'I taught periods one to four',
  status: 'pending',
  createdAt: '2026-10-06T04:00:00.000Z',
  decidedByName: null,
  decidedAt: null,
  decisionReason: null,
  withdrawnAt: null,
  ...extra,
});

// meFixture's staff id is '5': the second dispute is the caller's own.
const BODY = { disputes: { count: 2, items: [dispute('61'), dispute('62', { staffId: '5', staffName: 'Sara Office', markSource: 'device' })] } };
const office = () => meFixture({ capabilities: ['attendance.staff.manage'] });
const reads = (fake: FakeApi) => fake.calls.filter((c) => c.method === 'GET' && c.path === '/api/v1/me/approvals').length;

beforeEach(async () => {
  await resetDevice();
  setOnline(true);
});
afterEach(() => queryClient.clear());

test('R346: every dispute action is online-only, never an outbox lane', () => {
  const actions = ['raise_attendance_dispute', 'withdraw_attendance_dispute', 'approve_attendance_dispute', 'reject_attendance_dispute'];
  expect(ONLINE_ONLY_ACTIONS).toEqual(expect.arrayContaining(actions));
  expect(Object.keys(LANES)).toEqual(expect.not.arrayContaining(actions));
  expect(Object.values(LANES).map((l) => l.path)).toEqual(expect.not.arrayContaining([expect.stringContaining('dispute')]));
});

test('R347: the section lists the disputes with the count; one\'s own is marked', async () => {
  await renderSignedIn(<ApprovalsScreen secure />, office(), { [APPROVALS]: () => ({ status: 200, body: BODY }) });
  expect(await screen.findByText('Attendance disputes · 2')).toBeOnTheScreen();
  expect(screen.getByTestId('approvals.dispute.61')).toHaveTextContent(/Rabia Teacher.*Absent → Present/);
  expect(screen.getByTestId('approvals.dispute.62')).toHaveTextContent(/marked by the device.*Your own/);
});

test('approves a dispute and reads the list again', async () => {
  const { fake } = await renderSignedIn(<ApprovalsScreen secure />, office(), {
    [APPROVALS]: () => ({ status: 200, body: BODY }),
    'POST /api/v1/staff-attendance-disputes/61/approve': () => ({ status: 200, body: dispute('61', { status: 'approved', markStatus: 'present' }) }),
  });
  fireEvent.press(await screen.findByTestId('approvals.dispute.61'));
  expect(screen.getByTestId('approvals.disputeSheet')).toHaveTextContent(/I taught periods one to four/);
  fireEvent.press(screen.getByTestId('approvals.dispute.approve'));
  await eventually(() => expect(screen.getByTestId('approvals.message')).toHaveTextContent(/Dispute approved/));
  expect(fake.calls.find((c) => c.path === '/api/v1/staff-attendance-disputes/61/approve')?.body).toEqual({});
  await eventually(() => expect(reads(fake)).toBe(2));
});

test('rejects a dispute with a reason', async () => {
  const { fake } = await renderSignedIn(<ApprovalsScreen secure />, office(), {
    [APPROVALS]: () => ({ status: 200, body: BODY }),
    'POST /api/v1/staff-attendance-disputes/61/reject': () => ({ status: 200, body: dispute('61', { status: 'rejected' }) }),
  });
  fireEvent.press(await screen.findByTestId('approvals.dispute.61'));
  fireEvent.press(screen.getByTestId('approvals.dispute.reject'));
  fireEvent.changeText(await screen.findByTestId('reasonSheet.reason'), 'The gate log shows nine');
  fireEvent.press(screen.getByTestId('reasonSheet.confirm'));
  await eventually(() => expect(screen.getByTestId('approvals.message')).toHaveTextContent('Dispute rejected. Rabia Teacher is told.'));
  expect(fake.calls.find((c) => c.path === '/api/v1/staff-attendance-disputes/61/reject')?.body).toEqual({ reason: 'The gate log shows nine' });
});

test('one\'s own dispute cannot be decided; a decision taken elsewhere shows the server\'s word; offline needs a connection', async () => {
  const { fake } = await renderSignedIn(<ApprovalsScreen secure />, office(), {
    [APPROVALS]: () => ({ status: 200, body: BODY }),
    'POST /api/v1/staff-attendance-disputes/61/approve': () => ({
      status: 409,
      body: errorBody(ErrorCode.ATTENDANCE_DISPUTE_NOT_PENDING, 'This dispute is no longer pending.', { status: 'withdrawn' }),
    }),
  });
  fireEvent.press(await screen.findByTestId('approvals.dispute.62'));
  expect(screen.getByTestId('approvals.dispute.own')).toBeOnTheScreen();
  expect(screen.getByTestId('approvals.dispute.approve')).toBeDisabled();
  expect(screen.getByTestId('approvals.dispute.reject')).toBeDisabled();
  fireEvent.press(screen.getByLabelText('Close'));

  fireEvent.press(await screen.findByTestId('approvals.dispute.61'));
  fireEvent.press(screen.getByTestId('approvals.dispute.approve'));
  await eventually(() => expect(screen.getByTestId('approvals.message')).toHaveTextContent('This dispute is no longer pending.'));
  await eventually(() => expect(reads(fake)).toBe(2));

  setOnline(false);
  expect(await screen.findByText('Needs a connection')).toBeOnTheScreen();
});
