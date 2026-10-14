import { ErrorCode } from '@asms/shared';
import { fireEvent, screen } from '@testing-library/react-native';
import type { AttendanceDisputeDto, MyStaffAttendanceDto } from '../api/contracts';
import { queryClient } from '../api/query-client';
import { errorBody, resetDevice } from '../test/fake-api';
import { teacherMe, TODAY } from '../test/fixtures';
import { eventually, renderSignedIn, setOnline } from '../test/screen';
import { AttendanceMonthScreen } from './FamilyScreens';

// Phase 5 slice 44 (contracts/slice-44.md §2.5, §6; R346): a staff member disputes a mark of their
// own from "My attendance": online only, with a reason and a fresh Idempotency-Key per sheet; a
// pending dispute can be withdrawn.

const MINE = 'GET /api/v1/me/staff/attendance';
const DISPUTES = 'GET /api/v1/me/staff/attendance-disputes';

const month = (): MyStaffAttendanceDto => ({
  absent: 1,
  dateFrom: `${TODAY.slice(0, 8)}01`,
  dateTo: TODAY,
  days: [{ amended: false, date: TODAY, employed: true, status: 'absent', workingDay: true, markId: '501', source: 'manual', disputeId: null, disputeStatus: null }],
  late: 0,
  onLeave: 0,
  present: 0,
  staffId: '9',
  unrecorded: 0,
  workingDays: 1,
});

const dispute = (id: string, extra: Partial<AttendanceDisputeDto> = {}): AttendanceDisputeDto => ({
  id,
  attendanceId: '400',
  staffId: '9',
  staffName: 'Rabia Teacher',
  date: '2026-10-02',
  markStatus: 'present',
  markSource: 'device',
  requestedStatus: 'late',
  reason: 'The device was slow',
  status: 'pending',
  createdAt: '2026-10-03T04:00:00.000Z',
  decidedByName: null,
  decidedAt: null,
  decisionReason: null,
  withdrawnAt: null,
  ...extra,
});

beforeEach(async () => {
  await resetDevice();
  setOnline(true);
});
afterEach(() => queryClient.clear());

test('R346: raising a dispute needs a reason, sends a key, and says it was sent', async () => {
  const { fake } = await renderSignedIn(<AttendanceMonthScreen source={{ kind: 'staff' }} />, teacherMe(), {
    [MINE]: () => ({ status: 200, body: month() }),
    [DISPUTES]: () => ({ status: 200, body: { data: [], page: 1, limit: 10, total: 0 } }),
    'POST /api/v1/me/staff/attendance-disputes': () => ({ status: 201, body: dispute('70', { attendanceId: '501' }) }),
  });
  fireEvent.press(await screen.findByTestId(`myDisputes.day.${TODAY}`));
  expect(screen.getByTestId('myDisputes.sheet')).toHaveTextContent(/It says Absent/);
  fireEvent.press(screen.getByTestId('myDisputes.send'));
  expect(await screen.findByTestId('myDisputes.reason.error')).toHaveTextContent('Give a reason of at least 3 characters.');
  expect(fake.calls.some((c) => c.method === 'POST')).toBe(false);
  fireEvent.changeText(screen.getByTestId('myDisputes.reason'), 'I taught all morning');
  fireEvent.press(screen.getByTestId('myDisputes.send'));
  await eventually(() => expect(screen.getByTestId('myDisputes.message')).toHaveTextContent('Dispute sent. You will be told the decision.'));
  const sent = fake.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/me/staff/attendance-disputes')!;
  expect(sent.body).toEqual({ attendanceId: '501', requestedStatus: 'present', reason: 'I taught all morning' });
  expect(sent.headers.get('Idempotency-Key')).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
});

test('a refusal is shown in the sheet; a pending dispute is withdrawn from the list', async () => {
  const { fake } = await renderSignedIn(<AttendanceMonthScreen source={{ kind: 'staff' }} />, teacherMe(), {
    [MINE]: () => ({ status: 200, body: month() }),
    [DISPUTES]: () => ({ status: 200, body: { data: [dispute('71')], page: 1, limit: 10, total: 1 } }),
    'POST /api/v1/me/staff/attendance-disputes': () => ({
      status: 422,
      body: errorBody(ErrorCode.VALIDATION_FAILED, 'Some fields are invalid.', {
        fields: [{ path: 'requestedStatus', code: 'INVALID_VALUE', message: 'The mark already says this' }],
      }),
    }),
    'POST /api/v1/me/staff/attendance-disputes/71/withdraw': () => ({ status: 200, body: dispute('71', { status: 'withdrawn' }) }),
  });
  fireEvent.press(await screen.findByTestId(`myDisputes.day.${TODAY}`));
  fireEvent.changeText(screen.getByTestId('myDisputes.reason'), 'I taught all morning');
  fireEvent.press(screen.getByTestId('myDisputes.send'));
  expect(await screen.findByTestId('myDisputes.failure')).toHaveTextContent('The mark already says this');
  fireEvent.press(screen.getByLabelText('Close'));

  fireEvent.press(await screen.findByTestId('myDisputes.dispute.71'));
  await eventually(() => expect(screen.getByTestId('myDisputes.message')).toHaveTextContent('Dispute withdrawn.'));
  expect(fake.calls.some((c) => c.path === '/api/v1/me/staff/attendance-disputes/71/withdraw')).toBe(true);
});

test('offline: the month still shows from the phone, and disputing needs a connection', async () => {
  await renderSignedIn(<AttendanceMonthScreen source={{ kind: 'staff' }} />, teacherMe(), {
    [MINE]: () => ({ status: 200, body: month() }),
    [DISPUTES]: () => ({ status: 200, body: { data: [], page: 1, limit: 10, total: 0 } }),
  });
  expect(await screen.findByTestId(`myDisputes.day.${TODAY}`)).toHaveTextContent(/Dispute/);
  setOnline(false);
  expect(await screen.findByText('Needs a connection to dispute a day.')).toBeOnTheScreen();
  fireEvent.press(screen.getByTestId(`myDisputes.day.${TODAY}`));
  expect(screen.queryByTestId('myDisputes.sheet')).toBeNull();
});
