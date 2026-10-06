import { fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Share } from 'react-native';
import type { PayslipDto } from '../api/contracts';
import { queryClient } from '../api/query-client';
import { resetDevice } from '../test/fake-api';
import { teacherMe } from '../test/fixtures';
import { eventually, renderSignedIn, setOnline } from '../test/screen';
import { payslipRows, payslipText } from './my-payslips';
import { MyPayslipsCard, MyPayslipsScreen } from './MyPayslips';

// Phase 3 slice 25: My payslips on the phone. Online read only, rendered natively, shared as text.

const SALARY = 'GET /api/v1/me/staff/salary-structure';
const PAYSLIPS = 'GET /api/v1/me/staff/payslips';

const slip: PayslipDto = {
  id: '71',
  runId: '5',
  yearMonth: '2026-09',
  runStatus: 'finalised',
  staffId: '9',
  staffName: 'Rabia Teacher',
  designation: null,
  workingDays: 26,
  employedWorkingDays: 26,
  basic: 52_000,
  lines: [
    { id: '1', kind: 'allowance', name: 'House rent', amount: 5_200, adjustsPayslipId: null, reason: null },
    { id: '2', kind: 'deduction', name: 'Provident fund', amount: 2_600, adjustsPayslipId: null, reason: null },
    { id: '3', kind: 'adjustment', name: 'Exam duty', amount: 1_500, adjustsPayslipId: null, reason: 'Invigilation' },
  ],
  allowancesTotal: 5_200,
  deductionsTotal: 2_600,
  deductionsNotTaken: [],
  unpaidDays: 0,
  unmarkedDays: 0,
  absenceDeduction: 0,
  advanceRecovery: 0,
  adjustmentTotal: 1_500,
  net: 56_100,
  status: 'paid',
  paidOn: '2026-10-01',
  paidMethod: 'bank_transfer',
  paidReference: null,
  days: null,
};

const routes = {
  [SALARY]: () => ({
    status: 200,
    body: {
      current: {
        id: '3', staffId: '9', basic: 52_000, components: [{ kind: 'allowance', name: 'House rent', amount: 5_200 }],
        effectiveFrom: '2026-01-01', endedOn: null, status: 'active', supersededBy: null, createdByUserId: '7',
        reason: 'Appointment terms', selfApproved: false, createdAt: '2026-01-01T04:00:00.000Z',
      },
      upcoming: null,
    },
  }),
  [PAYSLIPS]: () => ({ status: 200, body: { data: [slip], page: 1, limit: 12, total: 1 } }),
};

beforeEach(async () => {
  await resetDevice();
  setOnline(true);
});
afterEach(() => queryClient.clear());

test('the payslip in print order, and as shareable text', () => {
  expect(payslipRows(slip).map((r) => `${r.label}: ${r.amount}`)).toEqual([
    'Basic (26 of 26 working days): Rs 52,000',
    'House rent: Rs 5,200',
    'Provident fund: -Rs 2,600',
    'Exam duty: +Rs 1,500',
    'Net pay: Rs 56,100',
  ]);
  expect(payslipText(slip, 'Green Valley School')).toMatch(/^Green Valley School\nPayslip, September 2026\nRabia Teacher\n/);
  expect(payslipText(slip, 'Green Valley School')).toContain('Paid on');
});

test('the Home card opens My payslips and reads nothing itself', async () => {
  const { fake } = await renderSignedIn(<MyPayslipsCard />, teacherMe());
  fireEvent.press(screen.getByTestId('home.myPayslips.open'));
  expect(router.push).toHaveBeenCalledWith('/home/my-payslips');
  expect(fake.calls.filter((c) => c.path.includes('payslips') || c.path.includes('salary'))).toEqual([]);
});

test('salary and payslips are read online; a payslip opens natively and shares as text', async () => {
  const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
  await renderSignedIn(<MyPayslipsScreen />, teacherMe(), routes);
  await eventually(() => expect(screen.getByTestId('myPayslips.slip.71')).toHaveTextContent(/September 2026.*Paid on.*Rs 56,100/));
  expect(screen.getByTestId('myPayslips.salary')).toHaveTextContent(/Basic.*Rs 52,000/);
  fireEvent.press(screen.getByTestId('myPayslips.slip.71'));
  expect(await screen.findByText('Exam duty')).toBeOnTheScreen();
  fireEvent.press(screen.getByTestId('myPayslips.share'));
  expect(share).toHaveBeenCalledWith({ message: expect.stringContaining('Net pay: Rs 56,100') });
});

test('offline: nothing is read and the screen says it needs a connection', async () => {
  setOnline(false);
  const { fake } = await renderSignedIn(<MyPayslipsScreen />, teacherMe(), routes);
  expect(await screen.findByText('Needs a connection')).toBeOnTheScreen();
  expect(fake.calls.filter((c) => c.path.includes('payslips'))).toEqual([]);
});
