import { DAY_STATUSES } from '@asms/shared';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import type { MyStaffAttendanceDto, StudentAttendanceDto } from '../api/contracts';
import { studentAttendance, TODAY } from '../test/fixtures';
import { AttendanceMonth, summaryLine } from './AttendanceMonth';
import { statusTone } from './theme';

// slice-16 §5.2, §6 (attendance/attendance-month.spec.tsx): one month, child or staff kind.

const text = () => JSON.stringify(screen.toJSON());

test('every day status and "not recorded" has its word and its letter; colour is never alone', () => {
  for (const status of [...DAY_STATUSES, null] as const) {
    const tone = statusTone(status);
    expect(tone.word).toMatch(/^(Present|Absent|Late|On leave|Partly absent|Not recorded)$/);
    if (status !== null && status !== 'partial') expect(tone.letter).toMatch(/^[PALO]$/);
  }
  expect(statusTone('present').background).toBe('#15803D');
  expect(statusTone('absent').background).toBe('#B91C1C');
  expect(statusTone('late').background).toBe('#B45309');
  expect(statusTone('on_leave').background).toBe('#475569');
  expect(statusTone('partial').border).toBe('dashed');
  expect(statusTone(null)).toMatchObject({
    background: '#F5F5F5',
    foreground: '#737373',
    border: 'hollow',
  });
});

test('cells: recorded days by status; a non-teaching day and an unenrolled day are muted', () => {
  const data = studentAttendance();
  data.days.push({
    date: '2099-01-01',
    enrolled: false,
    periods: [],
    status: null,
    teachingDay: true,
    value: null,
  });
  render(<AttendanceMonth kind="student" data={data} />);
  const label = (date: string) =>
    screen.getByTestId(`attendanceMonth.day.${date}`).props.accessibilityLabel as string;
  expect(label(TODAY)).toMatch(/: Absent$/);
  expect(label(data.days[1]!.date)).toMatch(/: Late$/);
  expect(label(data.days[2]!.date)).toMatch(/: Not a school day$/);
  expect(label('2099-01-01')).toMatch(/: Not a school day$/);
  expect(screen.getByTestId('attendanceMonth.legend')).toHaveTextContent(
    /Present.*Absent.*Late.*On leave.*Partly absent.*Not recorded/,
  );
});

test('a teaching day with nothing recorded is hollow and says "Not recorded"', () => {
  const data = studentAttendance();
  data.days[3] = { ...data.days[3]!, status: null, periods: [], value: null };
  render(<AttendanceMonth kind="student" data={data} />);
  expect(screen.getByTestId(`attendanceMonth.day.${TODAY}`).props.accessibilityLabel).toMatch(
    /: Not recorded$/,
  );
});

test('the summary line, and "No recorded days yet" when there is no percentage', () => {
  const data = studentAttendance();
  expect(summaryLine({ kind: 'student', data })).toEqual([
    '66.7% — 2 of 3 days',
    '1 present · 1 absent · 1 late · 0 on leave · 0 partly absent · 0 not recorded',
  ]);
  const none: StudentAttendanceDto = { ...data, percentage: null, excludedLeaveDays: 2 };
  expect(summaryLine({ kind: 'student', data: none })).toEqual([
    'No recorded days yet',
    '1 present · 1 absent · 1 late · 0 on leave · 0 partly absent · 0 not recorded',
    '2 leave days not counted',
  ]);
});

test('tapping a day lists its periods, with the arrival time of a late one', () => {
  const data = studentAttendance();
  render(<AttendanceMonth kind="student" data={data} />);
  fireEvent.press(screen.getByTestId(`attendanceMonth.day.${data.days[1]!.date}`));
  const sheet = screen.getByTestId('attendanceMonth.daySheet');
  expect(within(sheet).getByText('Period 1 — Late (arrived 08:40)')).toBeOnTheScreen();
});

test('R165: the DTO has no note and no teacher, so none is rendered', () => {
  const data = studentAttendance() as StudentAttendanceDto & Record<string, unknown>;
  // Even if a server sent more than the contract, the component renders only the fields it knows.
  (data.days[3] as unknown as Record<string, unknown>).note = 'Father 0300 1234567 called';
  (data.days[3] as unknown as Record<string, unknown>).markedByName = 'Nadia Teacher';
  render(<AttendanceMonth kind="student" data={data} />);
  fireEvent.press(screen.getByTestId(`attendanceMonth.day.${TODAY}`));
  expect(text()).not.toContain('0300');
  expect(text()).not.toContain('Nadia');
});

test('staff kind: working-day wording, amended days marked, no note or marker', () => {
  const data: MyStaffAttendanceDto = {
    absent: 1,
    dateFrom: '2026-10-01',
    dateTo: '2026-10-02',
    days: [
      { amended: true, date: '2026-10-01', employed: true, status: 'present', workingDay: true },
      { amended: false, date: '2026-10-02', employed: true, status: null, workingDay: false },
    ],
    late: 0,
    onLeave: 0,
    present: 1,
    staffId: '9',
    unrecorded: 0,
    workingDays: 1,
  };
  render(<AttendanceMonth kind="staff" data={data} />);
  expect(screen.getByTestId('attendanceMonth.day.2026-10-02').props.accessibilityLabel).toMatch(
    /Not a working day$/,
  );
  expect(summaryLine({ kind: 'staff', data })[0]).toBe('1 working day');
  fireEvent.press(screen.getByTestId('attendanceMonth.day.2026-10-01'));
  expect(
    within(screen.getByTestId('attendanceMonth.daySheet')).getByText('Amended'),
  ).toBeOnTheScreen();
});
