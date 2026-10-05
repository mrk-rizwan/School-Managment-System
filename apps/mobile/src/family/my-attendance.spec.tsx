import { fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { preventScreenCaptureAsync } from 'expo-screen-capture';
import type { MyStaffAttendanceDto } from '../api/contracts';
import { queryClient } from '../api/query-client';
import { monthRange } from '../platform/dates';
import { resetDevice } from '../test/fake-api';
import { teacherMe, TODAY } from '../test/fixtures';
import { eventually, renderSignedIn, setOnline } from '../test/screen';
import { AttendanceMonthScreen } from './FamilyScreens';
import { MyAttendanceCard, staffCardLine } from './MyAttendance';

// slice-16 §6 (home/my-attendance.spec.tsx): the staff card on Home and the month screen.

const MINE = 'GET /api/v1/me/staff/attendance';

function mine(patch: Partial<MyStaffAttendanceDto> = {}): MyStaffAttendanceDto {
  return {
    absent: 1,
    dateFrom: `${TODAY.slice(0, 8)}01`,
    dateTo: TODAY,
    days: [{ amended: false, date: TODAY, employed: true, status: 'present', workingDay: true }],
    late: 1,
    onLeave: 0,
    present: 17,
    staffId: '9',
    unrecorded: 1,
    workingDays: 20,
    ...patch,
  };
}

beforeEach(async () => {
  await resetDevice();
  setOnline(true);
});
afterEach(() => queryClient.clear());

test('the card: "<Month>: n of m working days", this month to today; opens the month', async () => {
  const { fake } = await renderSignedIn(<MyAttendanceCard />, teacherMe(), {
    [MINE]: () => ({ status: 200, body: mine() }),
  });
  const month = monthRange(TODAY, 0).title.split(' ')[0];
  await eventually(() =>
    expect(screen.getByTestId('home.myAttendance')).toHaveTextContent(
      `My attendance${month}: 18 of 20 working days`,
    ),
  );
  const read = fake.calls.find((c) => c.path === '/api/v1/me/staff/attendance')!;
  expect(read.query.get('dateTo')).toBe(TODAY);
  fireEvent.press(screen.getByTestId('home.myAttendance.open'));
  expect(router.push).toHaveBeenCalledWith('/home/my-attendance');
  expect(staffCardLine('October 2026', mine())).toBe('October: 18 of 20 working days');
});

test('the month screen: staff wording, no note, no marker; not a secure screen', async () => {
  await renderSignedIn(<AttendanceMonthScreen source={{ kind: 'staff' }} />, teacherMe(), {
    [MINE]: () => ({ status: 200, body: mine() }),
  });
  expect(await screen.findByTestId('attendanceMonth.grid')).toBeOnTheScreen();
  expect(screen.getByText('20 working days')).toBeOnTheScreen();
  expect(preventScreenCaptureAsync).not.toHaveBeenCalled();
});
