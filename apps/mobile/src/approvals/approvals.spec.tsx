import { ErrorCode } from '@asms/shared';
import { fireEvent, screen } from '@testing-library/react-native';
import type { ApprovalsDto, ClaimDto, ExpenseDto, HandoverDto, LeaveRequestDto, MeDto } from '../api/contracts';
import { queryClient } from '../api/query-client';
import { LANES, ONLINE_ONLY_ACTIONS } from '../outbox/lanes';
import { errorBody, resetDevice, type FakeApi } from '../test/fake-api';
import { meFixture, TODAY } from '../test/fixtures';
import { eventually, renderSignedIn, setOnline } from '../test/screen';
import { confirmedMessage, decisionFailure } from './approvals';
import { ApprovalsScreen } from './ApprovalsScreen';

// Phase 3 slice 27: the Approvals tab (R226, R227). Online only: no outbox lane, no cache; a
// decision taken elsewhere (409) shows the server's sentence and reads the list again.

const APPROVALS = 'GET /api/v1/me/approvals';

const claim: ClaimDto = {
  id: '61',
  studentId: '301',
  studentName: 'Hamza Tariq',
  className: 'Class 5',
  guardianId: '77',
  guardianName: 'Tariq Mehmood',
  method: 'jazzcash',
  claimedAmount: 3000,
  paidOn: TODAY,
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
  createdAt: '2026-10-06T04:00:00.000Z',
  possibleDuplicate: false,
  duplicateOfClaimId: null,
};

const handover: HandoverDto = {
  id: '71',
  collector: { userId: '90', staffId: '9', name: 'Bilal Office' },
  openedByUserId: '90',
  openedByName: 'Bilal Office',
  onBehalf: false,
  expectedAmount: 5000,
  paymentCount: 2,
  openedAt: '2026-10-06T10:00:00.000Z',
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

const expense = (patch: Partial<ExpenseDto> = {}): ExpenseDto => ({
  id: '81',
  expenseNo: 12,
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
  recordedByUserId: '90',
  recordedByName: 'Bilal Office',
  recordedAt: '2026-10-06T05:00:00.000Z',
  decidedByUserId: null,
  decidedAt: null,
  decisionReason: null,
  voidedAt: null,
  voidReason: null,
  updatedAt: '2026-10-06T05:00:00.123Z',
  ...patch,
});

const leave: LeaveRequestDto = {
  id: '91',
  staffId: '12',
  staffName: 'Rabia Teacher',
  leaveType: { id: '1', name: 'Casual leave', code: 'casual', paid: true },
  startsOn: TODAY,
  endsOn: TODAY,
  endedEarlyOn: null,
  workingDays: 1,
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
  sectionsNeedingCover: [{ sectionId: '501', classId: '50', name: 'Class 5 A' }],
  cancelledAt: null,
  cancelReason: null,
};

const ALL: ApprovalsDto = {
  claims: { count: 1, items: [claim] },
  handovers: { count: 1, items: [handover] },
  expenses: { count: 1, items: [expense()] },
  leave: { count: 1, items: [leave] },
};

const principal = (): MeDto =>
  meFixture({
    capabilities: ['payment.verify', 'collection.handover.confirm', 'expense.approve', 'staff.leave.approve', 'class.manage'],
  });

const reads = (fake: FakeApi) => fake.calls.filter((c) => c.method === 'GET' && c.path === '/api/v1/me/approvals').length;

beforeEach(async () => {
  await resetDevice();
  setOnline(true);
});
afterEach(() => queryClient.clear());

test('R226: every Approvals decision is online-only and none is an outbox lane', () => {
  const decisions = ['verify_claim', 'reject_claim', 'confirm_handover', 'approve_expense', 'reject_expense', 'approve_leave', 'reject_leave'];
  expect(ONLINE_ONLY_ACTIONS).toEqual(expect.arrayContaining(decisions));
  expect(Object.keys(LANES)).toEqual(expect.not.arrayContaining(decisions));
});

test('R227: only the sections the server sent; counts in the titles', async () => {
  await renderSignedIn(<ApprovalsScreen secure />, meFixture({ capabilities: ['payment.verify'] }), {
    [APPROVALS]: () => ({ status: 200, body: { claims: { count: 12, items: [claim] } } }),
  });
  expect(await screen.findByText('Deposit slips · 12')).toBeOnTheScreen();
  expect(screen.getByTestId('approvals.claim.61')).toHaveTextContent(/Hamza Tariq · Rs 3,000.*JazzCash/);
  expect(screen.getByText('Showing the first 10 of 12. The rest are on the web console.')).toBeOnTheScreen();
  expect(screen.queryByTestId('approvals.handovers')).toBeNull();
  expect(screen.queryByTestId('approvals.expenses')).toBeNull();
  expect(screen.queryByTestId('approvals.leave')).toBeNull();
});

test('nothing to approve', async () => {
  await renderSignedIn(<ApprovalsScreen secure />, principal(), { [APPROVALS]: () => ({ status: 200, body: {} }) });
  expect(await screen.findByText('Nothing for you to approve')).toBeOnTheScreen();
});

test('offline: nothing is read and the screen says it needs a connection', async () => {
  setOnline(false);
  const { fake } = await renderSignedIn(<ApprovalsScreen secure />, principal(), { [APPROVALS]: () => ({ status: 200, body: ALL }) });
  expect(await screen.findByText('Needs a connection')).toBeOnTheScreen();
  expect(reads(fake)).toBe(0);
});

test('verifies a claim (the slip on tap) and reads the list again', async () => {
  const { fake } = await renderSignedIn(<ApprovalsScreen secure />, principal(), {
    [APPROVALS]: () => ({ status: 200, body: ALL }),
    'POST /api/v1/payment-claims/61/verify': () => ({
      status: 200,
      body: { ...claim, status: 'verified', payment: { amount: 3000, receipt: { receiptLabel: '18/2026-27' } } },
    }),
  });
  fireEvent.press(await screen.findByTestId('approvals.claim.61'));
  expect(screen.getByTestId('attachment.show')).toBeOnTheScreen();
  fireEvent.press(screen.getByTestId('approvals.claim.verify'));
  await eventually(() => expect(screen.getByTestId('approvals.message')).toHaveTextContent('Verified: receipt 18/2026-27 for Rs 3,000.'));
  expect(fake.calls.find((c) => c.path === '/api/v1/payment-claims/61/verify')?.body).toEqual({});
  await eventually(() => expect(reads(fake)).toBe(2));
});

test('nothing owed: the verifier may keep the money as the child\'s advance', async () => {
  const bodies: unknown[] = [];
  await renderSignedIn(<ApprovalsScreen secure />, principal(), {
    [APPROVALS]: () => ({ status: 200, body: ALL }),
    'POST /api/v1/payment-claims/61/verify': (req) => {
      bodies.push(req.body);
      return bodies.length === 1
        ? { status: 409, body: errorBody(ErrorCode.PAYMENT_NOTHING_DUE, 'Nothing is owed.') }
        : { status: 200, body: { ...claim, status: 'verified', payment: { amount: 3000, receipt: { receiptLabel: '19/2026-27' } } } };
    },
  });
  fireEvent.press(await screen.findByTestId('approvals.claim.61'));
  fireEvent.press(screen.getByTestId('approvals.claim.verify'));
  await eventually(() => expect(screen.getByTestId('approvals.claim.failure')).toHaveTextContent(/Nothing is owed by Hamza Tariq/));
  fireEvent.press(screen.getByTestId('approvals.claim.advance'));
  await eventually(() => expect(screen.getByTestId('approvals.message')).toHaveTextContent('Verified: receipt 19/2026-27 for Rs 3,000.'));
  expect(bodies).toEqual([{}, { advanceForStudentId: '301' }]);
});

test('rejects a claim with a reason', async () => {
  const { fake } = await renderSignedIn(<ApprovalsScreen secure />, principal(), {
    [APPROVALS]: () => ({ status: 200, body: ALL }),
    'POST /api/v1/payment-claims/61/reject': () => ({ status: 200, body: { ...claim, status: 'rejected' } }),
  });
  fireEvent.press(await screen.findByTestId('approvals.claim.61'));
  fireEvent.press(screen.getByTestId('approvals.claim.reject'));
  fireEvent.changeText(await screen.findByTestId('reasonSheet.reason'), 'The slip is unreadable');
  fireEvent.press(screen.getByTestId('reasonSheet.confirm'));
  await eventually(() => expect(screen.getByTestId('approvals.message')).toHaveTextContent('Slip not accepted. The parent is told why.'));
  expect(fake.calls.find((c) => c.path === '/api/v1/payment-claims/61/reject')?.body).toEqual({ reason: 'The slip is unreadable' });
});

test('confirms a handover with the counted amount; a shortfall is said', async () => {
  const { fake } = await renderSignedIn(<ApprovalsScreen secure />, principal(), {
    [APPROVALS]: () => ({ status: 200, body: ALL }),
    'POST /api/v1/cash-handovers/71/confirm': () => ({ status: 200, body: { ...handover, status: 'confirmed', countedAmount: 4800 } }),
  });
  fireEvent.press(await screen.findByTestId('approvals.handover.71'));
  expect(screen.getByTestId('approvals.handover.counted').props.value).toBe('5000');
  fireEvent.changeText(screen.getByTestId('approvals.handover.counted'), '4,800');
  fireEvent.press(screen.getByTestId('approvals.handover.confirm'));
  await eventually(() =>
    expect(screen.getByTestId('approvals.message')).toHaveTextContent('Handover confirmed, Rs 200 short. The principals are told.'),
  );
  expect(fake.calls.find((c) => c.path === '/api/v1/cash-handovers/71/confirm')?.body).toEqual({ countedAmount: 4800 });
});

test('R226: a decision taken elsewhere (409) shows the server\'s message and reads the list again', async () => {
  const { fake } = await renderSignedIn(<ApprovalsScreen secure />, principal(), {
    [APPROVALS]: () => ({ status: 200, body: ALL }),
    'POST /api/v1/cash-handovers/71/confirm': () => ({
      status: 409,
      body: errorBody(ErrorCode.HANDOVER_NOT_OPEN, 'This handover has already been counted.'),
    }),
  });
  fireEvent.press(await screen.findByTestId('approvals.handover.71'));
  fireEvent.press(screen.getByTestId('approvals.handover.confirm'));
  await eventually(() => expect(screen.getByTestId('approvals.message')).toHaveTextContent('This handover has already been counted.'));
  expect(screen.queryByTestId('approvals.handoverSheet')).toBeNull();
  await eventually(() => expect(reads(fake)).toBe(2));
});

test('the collector cannot confirm their own handover', async () => {
  await renderSignedIn(<ApprovalsScreen secure />, meFixture({ id: '90', capabilities: ['collection.handover.confirm'] }), {
    [APPROVALS]: () => ({ status: 200, body: { handovers: ALL.handovers } }),
  });
  fireEvent.press(await screen.findByTestId('approvals.handover.71'));
  expect(screen.getByTestId('approvals.handover.own')).toBeOnTheScreen();
  expect(screen.getByTestId('approvals.handover.confirm')).toBeDisabled();
});

test('approves an expense with the version read; one\'s own cannot be decided', async () => {
  const { fake } = await renderSignedIn(<ApprovalsScreen secure />, principal(), {
    [APPROVALS]: () => ({ status: 200, body: { expenses: { count: 2, items: [expense(), expense({ id: '82', recordedByUserId: '41' })] } } }),
    'POST /api/v1/expenses/81/approve': () => ({ status: 200, body: expense({ status: 'approved' }) }),
  });
  fireEvent.press(await screen.findByTestId('approvals.expense.82'));
  expect(screen.getByTestId('approvals.expense.own')).toBeOnTheScreen();
  expect(screen.getByTestId('approvals.expense.approve')).toBeDisabled();
  fireEvent.press(screen.getByTestId('approvals.expenseSheet.close'));
  fireEvent.press(await screen.findByTestId('approvals.expense.81'));
  fireEvent.press(screen.getByTestId('approvals.expense.approve'));
  await eventually(() => expect(screen.getByTestId('approvals.message')).toHaveTextContent('Expense approved. The recorder is told.'));
  expect(fake.calls.find((c) => c.path === '/api/v1/expenses/81/approve')?.body).toEqual({ expectedUpdatedAt: '2026-10-06T05:00:00.123Z' });
});

test('approves leave with a cover chosen from the active staff (never the person on leave)', async () => {
  const { fake } = await renderSignedIn(<ApprovalsScreen secure />, principal(), {
    [APPROVALS]: () => ({ status: 200, body: { leave: ALL.leave } }),
    'GET /api/v1/staff': () => ({
      status: 200,
      body: {
        data: [
          { id: '12', fullName: 'Rabia Teacher', designation: 'Teacher' },
          { id: '13', fullName: 'Imran Ali', designation: 'Teacher' },
        ],
        page: 1,
        limit: 50,
        total: 2,
      },
    }),
    'POST /api/v1/leave-requests/91/approve': () => ({ status: 200, body: { ...leave, status: 'approved' } }),
  });
  fireEvent.press(await screen.findByTestId('approvals.leave.91'));
  fireEvent.press(await screen.findByTestId('approvals.leave.cover.13'));
  expect(screen.queryByTestId('approvals.leave.cover.12')).toBeNull();
  expect(screen.queryByTestId('approvals.leave.coverMore')).toBeNull();
  fireEvent.press(screen.getByTestId('approvals.leave.approve'));
  await eventually(() => expect(screen.getByTestId('approvals.message')).toHaveTextContent('Leave approved; Imran Ali covers. Both are told.'));
  expect(fake.calls.find((c) => c.path === '/api/v1/leave-requests/91/approve')?.body).toEqual({
    cover: { sectionId: '501', coverStaffId: '13' },
  });
});

test('the cover picker says so when the active staff are more than the one page it reads', async () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ id: String(100 + i), fullName: `Staff ${i}`, designation: 'Teacher' }));
  await renderSignedIn(<ApprovalsScreen secure />, principal(), {
    [APPROVALS]: () => ({ status: 200, body: { leave: ALL.leave } }),
    'GET /api/v1/staff': () => ({ status: 200, body: { data: many, page: 1, limit: 50, total: 64 } }),
  });
  fireEvent.press(await screen.findByTestId('approvals.leave.91'));
  expect(await screen.findByTestId('approvals.leave.coverMore')).toHaveTextContent(
    'Showing the first 50 staff; choose the cover on the web if not listed.',
  );
  expect(screen.getByTestId('approvals.leave.cover.149')).toBeOnTheScreen();
});

test('rejects leave with a reason', async () => {
  const { fake } = await renderSignedIn(<ApprovalsScreen secure />, meFixture({ capabilities: ['staff.leave.approve'] }), {
    [APPROVALS]: () => ({ status: 200, body: { leave: ALL.leave } }),
    'POST /api/v1/leave-requests/91/reject': () => ({ status: 200, body: { ...leave, status: 'rejected' } }),
  });
  fireEvent.press(await screen.findByTestId('approvals.leave.91'));
  // Without class.manage there is no cover picker and no staff read.
  expect(screen.queryByTestId('approvals.leave.cover.13')).toBeNull();
  fireEvent.press(screen.getByTestId('approvals.leave.reject'));
  fireEvent.changeText(await screen.findByTestId('reasonSheet.reason'), 'Exams week');
  fireEvent.press(screen.getByTestId('reasonSheet.confirm'));
  await eventually(() => expect(screen.getByTestId('approvals.message')).toHaveTextContent('Leave rejected. Rabia Teacher is told.'));
  expect(fake.calls.find((c) => c.path === '/api/v1/leave-requests/91/reject')?.body).toEqual({ reason: 'Exams week' });
  expect(fake.calls.some((c) => c.path === '/api/v1/staff')).toBe(false);
});

test('decisionFailure and confirmedMessage', () => {
  expect(decisionFailure(new TypeError('Network request failed'))).toEqual({
    message: 'No connection. Nothing was sent; try again when connected.',
    stale: false,
  });
  expect(confirmedMessage(5000, 5000)).toBe('Handover confirmed.');
  expect(confirmedMessage(5000, 5100)).toBe('Handover confirmed, Rs 100 over.');
});
