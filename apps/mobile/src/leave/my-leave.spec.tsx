import { addDaysTo, ErrorCode } from '@asms/shared';
import { fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { LeaveBalanceDto, LeaveRequestDto, LeaveTypeDto } from '../api/contracts';
import { queryClient } from '../api/query-client';
import { ONLINE_ONLY_ACTIONS } from '../outbox/lanes';
import { errorBody, resetDevice } from '../test/fake-api';
import { teacherMe, TODAY } from '../test/fixtures';
import { eventually, renderSignedIn, setOnline } from '../test/screen';
import { balanceLine, canCancel, formProblems } from './my-leave';
import { MyLeaveCard, MyLeaveScreen } from './MyLeave';

// Phase 3 slice 24: My leave on the phone. Online only (R226): no outbox lane, no cache.

const BALANCE = 'GET /api/v1/me/staff/leave-balance';
const REQUESTS = 'GET /api/v1/me/staff/leave-requests';
const TYPES = 'GET /api/v1/leave-types';
const CREATE = 'POST /api/v1/me/staff/leave-requests';

const types: LeaveTypeDto[] = [
  { id: '1', name: 'Casual leave', code: 'casual', daysPerYear: 10, paid: true, status: 'active', archivedAt: null, seeded: true },
  { id: '3', name: 'Unpaid leave', code: 'unpaid', daysPerYear: null, paid: false, status: 'active', archivedAt: null, seeded: true },
];

const balance: LeaveBalanceDto = {
  year: Number(TODAY.slice(0, 4)),
  types: [
    { leaveTypeId: '1', name: 'Casual leave', code: 'casual', paid: true, entitlement: 10, used: 3, pending: 2, balance: 7 },
    { leaveTypeId: '3', name: 'Unpaid leave', code: 'unpaid', paid: false, entitlement: null, used: 1, pending: 0, balance: null },
  ],
};

function request(patch: Partial<LeaveRequestDto> = {}): LeaveRequestDto {
  return {
    id: '41',
    staffId: '9',
    staffName: 'Rabia Teacher',
    leaveType: { id: '1', name: 'Casual leave', code: 'casual', paid: true },
    startsOn: addDaysTo(TODAY, 3),
    endsOn: addDaysTo(TODAY, 4),
    endedEarlyOn: null,
    workingDays: 2,
    reason: 'Family wedding',
    status: 'pending',
    requestedByUserId: '7',
    requestedAt: '2026-10-04T04:00:00.000Z',
    onBehalf: false,
    decidedByUserId: null,
    decidedByName: null,
    decidedAt: null,
    decisionReason: null,
    selfApproved: false,
    coverAssignmentId: null,
    coverEndedOn: null,
    sectionsNeedingCover: [],
    cancelledAt: null,
    cancelReason: null,
    ...patch,
  };
}

const page = <T,>(data: T[]) => ({ data, page: 1, limit: 25, total: data.length });

const routes = (requests: LeaveRequestDto[] = [request()]) => ({
  [BALANCE]: () => ({ status: 200, body: balance }),
  [REQUESTS]: () => ({ status: 200, body: page(requests) }),
  [TYPES]: () => ({ status: 200, body: page(types) }),
});

beforeEach(async () => {
  await resetDevice();
  setOnline(true);
});
afterEach(() => queryClient.clear());

test('leave actions are online-only and never an outbox lane', () => {
  expect(ONLINE_ONLY_ACTIONS).toEqual(expect.arrayContaining(['request_leave', 'cancel_leave']));
});

test('the Home card opens My leave and reads nothing itself', async () => {
  const { fake } = await renderSignedIn(<MyLeaveCard />, teacherMe());
  fireEvent.press(screen.getByTestId('home.myLeave.open'));
  expect(router.push).toHaveBeenCalledWith('/home/my-leave');
  expect(fake.calls.filter((c) => c.path.includes('leave'))).toEqual([]);
});

test('balances and requests; a pending request offers Cancel', async () => {
  await renderSignedIn(<MyLeaveScreen />, teacherMe(), routes());
  await eventually(() => expect(screen.getByTestId('myLeave.balance.1')).toHaveTextContent('Casual leave7 of 10 left, 2 pending'));
  expect(screen.getByTestId('myLeave.balance.3')).toHaveTextContent('Unpaid leave1 day taken, no limit');
  expect(screen.getByTestId('myLeave.request.41')).toHaveTextContent(/Casual leave · Waiting for a decision.*2 working days.*Cancel/);
});

test('offline: nothing is read and the screen says it needs a connection', async () => {
  setOnline(false);
  const { fake } = await renderSignedIn(<MyLeaveScreen />, teacherMe(), routes());
  expect(await screen.findByText('Needs a connection')).toBeOnTheScreen();
  expect(fake.calls.filter((c) => c.path.includes('leave'))).toEqual([]);
});

test('requesting leave sends the form once with an Idempotency-Key; a refusal is explained', async () => {
  let attempts = 0;
  const { fake } = await renderSignedIn(<MyLeaveScreen />, teacherMe(), {
    ...routes(),
    [CREATE]: () => {
      attempts += 1;
      return attempts === 1
        ? { status: 409, body: errorBody(ErrorCode.LEAVE_BALANCE_EXCEEDED, 'Not enough', { balance: 1 }) }
        : { status: 201, body: request({ id: '42' }) };
    },
  });
  fireEvent.press(await screen.findByTestId('myLeave.request'));
  fireEvent.press(await screen.findByTestId('leaveForm.type.1'));
  fireEvent.changeText(screen.getByTestId('leaveForm.reason'), 'Family wedding');
  fireEvent.press(screen.getByTestId('leaveForm.endsOn'));
  fireEvent.press(await screen.findByTestId(`leaveForm.day.${addDaysTo(TODAY, 1)}`));
  fireEvent.press(screen.getByTestId('leaveForm.send'));
  await eventually(() => expect(screen.getByTestId('leaveForm.failure')).toHaveTextContent('Not enough leave left: 1 working day.'));
  fireEvent.press(screen.getByTestId('leaveForm.send'));
  await eventually(() => expect(screen.getByTestId('myLeave.message')).toHaveTextContent(/^Request sent\./));

  const sends = fake.calls.filter((c) => `${c.method} ${c.path}` === CREATE);
  expect(sends.map((c) => c.body)).toEqual([
    { leaveTypeId: '1', startsOn: TODAY, endsOn: addDaysTo(TODAY, 1), reason: 'Family wedding' },
    { leaveTypeId: '1', startsOn: TODAY, endsOn: addDaysTo(TODAY, 1), reason: 'Family wedding' },
  ]);
  // One key per opening of the form: the retry replays rather than duplicates.
  const keys = sends.map((c) => c.headers.get('Idempotency-Key'));
  expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  expect(keys[1]).toBe(keys[0]);
});

test('cancelling asks for a reason and posts it', async () => {
  const { fake } = await renderSignedIn(<MyLeaveScreen />, teacherMe(), {
    ...routes(),
    'POST /api/v1/me/staff/leave-requests/41/cancel': () => ({ status: 200, body: request({ status: 'cancelled' }) }),
  });
  fireEvent.press(await screen.findByTestId('myLeave.request.41'));
  fireEvent.changeText(await screen.findByTestId('reasonSheet.reason'), 'Plans changed');
  fireEvent.press(screen.getByTestId('reasonSheet.confirm'));
  await eventually(() => expect(screen.getByTestId('myLeave.message')).toHaveTextContent(/^Request cancelled\./));
  expect(fake.calls.find((c) => c.path.endsWith('/cancel'))?.body).toEqual({ reason: 'Plans changed' });
});

test('the pure rules: cancellable states, the form mirrors the server, balance wording', () => {
  expect(canCancel(request({ status: 'approved', startsOn: addDaysTo(TODAY, 1) }), TODAY)).toBe(true);
  expect(canCancel(request({ status: 'approved', startsOn: TODAY }), TODAY)).toBe(false);
  expect(canCancel(request({ status: 'rejected' }), TODAY)).toBe(false);
  const ok = { leaveTypeId: '1', startsOn: TODAY, endsOn: TODAY, reason: 'Sick child' };
  expect(formProblems(ok, TODAY)).toEqual({});
  expect(Object.keys(formProblems({ ...ok, startsOn: addDaysTo(TODAY, -8), endsOn: addDaysTo(TODAY, -8) }, TODAY))).toEqual(['startsOn']);
  expect(Object.keys(formProblems({ ...ok, endsOn: addDaysTo(TODAY, 60) }, TODAY))).toEqual(['endsOn']);
  expect(Object.keys(formProblems({ ...ok, leaveTypeId: null, reason: 'x' }, TODAY))).toEqual(['leaveTypeId', 'reason']);
  expect(balanceLine(balance.types[0]!)).toBe('7 of 10 left, 2 pending');
});
