import { fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { MyStaffTimetableDto, MyTimetableDto } from '../api/contracts';
import { queryClient } from '../api/query-client';
import { MyClassesScreen } from '../classes/MyClassesScreen';
import { ChildrenScreen } from '../family/ChildrenScreen';
import { StudentIndexScreen } from '../family/StudentIndexScreen';
import { addDays, mondayOf } from '../platform/dates';
import { resetDevice } from '../test/fake-api';
import { assignment, guardianMe, teacherMe, TODAY } from '../test/fixtures';
import { renderSignedIn, setOnline } from '../test/screen';
import { defaultDay, FamilyTimetableScreen, StaffTimetableScreen } from './TimetableScreens';

// Phase 5 slice 37 (contracts/slice-37.md §7): the teacher's week and a section's week for
// families — a day at a time, substitutions marked, online only (no outbox, never cached).

const MONDAY = mondayOf(TODAY);
const week = <P,>(periodsOf: (date: string, i: number) => P[]) =>
  Array.from({ length: 7 }, (_, i) => {
    const date = addDays(MONDAY, i);
    // Sunday off, except that today is always a teaching day whatever the day the suite runs.
    return {
      date,
      weekday: (i + 1) % 7,
      teachingDay: i < 6 || date === TODAY,
      periods: periodsOf(date, i),
    };
  });

const staffWeek = (periodsOf: Parameters<typeof week>[0]): MyStaffTimetableDto => ({
  weekOf: MONDAY,
  periodsPerDay: 8,
  days: week(periodsOf) as MyStaffTimetableDto['days'],
});

const slot = (patch: Partial<MyStaffTimetableDto['days'][number]['periods'][number]> = {}) => ({
  period: 2,
  sectionId: '12',
  sectionName: 'A',
  classId: '20',
  className: 'Class 5',
  subjectName: 'English',
  room: '4',
  kind: 'slot' as const,
  substitutedByName: null,
  ...patch,
});

const familyWeek = (patch: Partial<MyTimetableDto> = {}): MyTimetableDto => ({
  studentId: '501',
  sectionName: 'A',
  className: 'Class 5',
  weekOf: MONDAY,
  periodsPerDay: 8,
  days: week(() => [
    { period: 1, subjectName: 'Mathematics', teacherName: 'Nadia Teacher', room: null },
  ]),
  ...patch,
});

const studentMe = () =>
  guardianMe({
    id: '81',
    fullName: 'Ali Raza',
    roles: ['student'],
    capacities: ['student'],
    children: [],
  });

beforeEach(async () => {
  await resetDevice();
  setOnline(true);
});
afterEach(() => queryClient.clear());

describe('the default day (pure)', () => {
  test('today in the week, else the first teaching day', () => {
    const days = week(() => []);
    expect(defaultDay(days, days[2]!.date)).toBe(days[2]!.date);
    expect(defaultDay(days, '1999-01-01')).toBe(days[0]!.date);
    expect(
      defaultDay(
        days.map((d, i) => ({ ...d, teachingDay: i === 3 })),
        '1999-01-01',
      ),
    ).toBe(days[3]!.date);
  });
});

describe("the teacher's week", () => {
  test('Classes offers Timetable', async () => {
    await renderSignedIn(<MyClassesScreen />, teacherMe());
    fireEvent.press(await screen.findByTestId('classes.timetable'));
    expect(router.push).toHaveBeenCalledWith('/classes/timetable');
  });

  test("today's periods with class, subject and room; a tap opens that period's register", async () => {
    const { fake } = await renderSignedIn(
      <StaffTimetableScreen />,
      teacherMe({ assignments: [assignment({ attendanceMode: 'period' })] }),
      {
        'GET /api/v1/me/staff/timetable': () => ({
          status: 200,
          body: staffWeek((date) => (date === TODAY ? [slot()] : [])),
        }),
      },
    );
    const row = await screen.findByTestId('timetable.period.2.12');
    expect(row).toHaveTextContent(/Period 2 · Class 5 A/);
    expect(row).toHaveTextContent(/English · Room 4/);
    expect(screen.getByTestId('timetable.week.month')).toHaveTextContent(/Week of/);
    expect(
      fake.calls.find((c) => c.path === '/api/v1/me/staff/timetable')?.query.get('weekOf'),
    ).toBe(TODAY);
    fireEvent.press(row);
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/classes/[sectionId]/register',
      params: { sectionId: '12', date: TODAY, period: '2' },
    });
  });

  test('a daily-register section opens its single register (period 1)', async () => {
    await renderSignedIn(<StaffTimetableScreen />, teacherMe(), {
      'GET /api/v1/me/staff/timetable': () => ({
        status: 200,
        body: staffWeek((date) => (date === TODAY ? [slot({ period: 5 })] : [])),
      }),
    });
    fireEvent.press(await screen.findByTestId('timetable.period.5.12'));
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/classes/[sectionId]/register',
      params: { sectionId: '12', date: TODAY, period: '1' },
    });
  });

  test('a substitution taken is marked; a slot another teacher takes says who and does not open', async () => {
    await renderSignedIn(<StaffTimetableScreen />, teacherMe(), {
      'GET /api/v1/me/staff/timetable': () => ({
        status: 200,
        body: staffWeek((date) =>
          date === TODAY
            ? [
                slot({ period: 3, substitutedByName: 'Bilal Ahmed' }),
                slot({ period: 1, sectionId: '13', sectionName: 'B', kind: 'substitution' }),
              ]
            : [],
        ),
      }),
    });
    expect(await screen.findByTestId('timetable.period.1.13')).toHaveTextContent(/Substitution/);
    const taken = screen.getByTestId('timetable.period.3.12');
    expect(taken).toHaveTextContent(/Taken by Bilal Ahmed/);
    fireEvent.press(taken);
    expect(router.push).not.toHaveBeenCalled();
  });

  test('another day and another week', async () => {
    // An off day that is neither today, Monday nor Tuesday.
    const off = [6, 5, 4].map((i) => addDays(MONDAY, i)).find((d) => d !== TODAY)!;
    const body = staffWeek((_, i) => (i === 0 ? [slot({ period: 6 })] : []));
    body.days = body.days.map((d) => (d.date === off ? { ...d, teachingDay: false } : d));
    const { fake } = await renderSignedIn(<StaffTimetableScreen />, teacherMe(), {
      'GET /api/v1/me/staff/timetable': () => ({ status: 200, body }),
    });
    fireEvent.press(await screen.findByTestId(`timetable.day.${MONDAY}`));
    expect(await screen.findByTestId('timetable.period.6.12')).toBeOnTheScreen();
    fireEvent.press(screen.getByTestId(`timetable.day.${addDays(MONDAY, 1)}`));
    expect(await screen.findByText('No periods on this day')).toBeOnTheScreen();
    fireEvent.press(screen.getByTestId(`timetable.day.${off}`));
    expect(await screen.findByText('No school on this day')).toBeOnTheScreen();
    fireEvent.press(screen.getByTestId('timetable.week.next'));
    await screen.findByTestId(`timetable.day.${MONDAY}`);
    const asked = fake.calls.filter((c) => c.path === '/api/v1/me/staff/timetable');
    expect(asked.map((c) => c.query.get('weekOf'))).toContain(addDays(TODAY, 7));
  });

  test('an error offers a retry', async () => {
    await renderSignedIn(<StaffTimetableScreen />, teacherMe(), {
      'GET /api/v1/me/staff/timetable': () => ({ status: 500, body: {} }),
    });
    expect(await screen.findByTestId('state.retry')).toBeOnTheScreen();
  });

  test('offline: needs a connection and asks nothing', async () => {
    setOnline(false);
    const { fake } = await renderSignedIn(<StaffTimetableScreen />, teacherMe());
    expect(await screen.findByText('Needs a connection')).toBeOnTheScreen();
    expect(fake.calls.some((c) => c.path.includes('timetable'))).toBe(false);
  });
});

describe("a family's week", () => {
  test("the child's card and the student's page offer Timetable", async () => {
    await renderSignedIn(<ChildrenScreen secure />, guardianMe(), {
      'GET /api/v1/me/children/501/attendance': () => ({ status: 404, body: {} }),
    });
    fireEvent.press(await screen.findByTestId('children.card.501.timetable'));
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/children/[studentId]/timetable',
      params: { studentId: '501' },
    });
    screen.unmount();
    await renderSignedIn(<StudentIndexScreen />, studentMe());
    fireEvent.press(await screen.findByTestId('student.timetable'));
    expect(router.push).toHaveBeenCalledWith('/student/timetable');
  });

  test("the child's section week: subject, teacher, room", async () => {
    const { fake } = await renderSignedIn(
      <FamilyTimetableScreen source={{ kind: 'child', studentId: '501' }} />,
      guardianMe(),
      {
        'GET /api/v1/me/children/501/timetable': () => ({
          status: 200,
          body: familyWeek({
            days: week(() => [
              { period: 2, subjectName: 'English', teacherName: 'Bilal Ahmed', room: '4' },
            ]),
          }),
        }),
      },
    );
    fireEvent.press(await screen.findByTestId(`timetable.day.${MONDAY}`));
    const row = await screen.findByTestId('familyTimetable.period.2');
    expect(row).toHaveTextContent(/Period 2 · English/);
    expect(row).toHaveTextContent(/Bilal Ahmed · Room 4/);
    expect(screen.getByTestId('familyTimetable.section')).toHaveTextContent('Class 5 A');
    expect(fake.calls.some((c) => c.path.includes('/me/student/'))).toBe(false);
  });

  test('the student: bound to /me/student', async () => {
    const { fake } = await renderSignedIn(
      <FamilyTimetableScreen source={{ kind: 'own' }} />,
      studentMe(),
      {
        'GET /api/v1/me/student/timetable': () => ({ status: 200, body: familyWeek() }),
      },
    );
    fireEvent.press(await screen.findByTestId(`timetable.day.${MONDAY}`));
    expect(await screen.findByTestId('familyTimetable.period.1')).toHaveTextContent(/Mathematics/);
    expect(
      fake.calls.find((c) => c.path === '/api/v1/me/student/timetable')?.query.get('date'),
    ).toBe(TODAY);
  });

  test('no section this week says so', async () => {
    await renderSignedIn(
      <FamilyTimetableScreen source={{ kind: 'child', studentId: '501' }} />,
      guardianMe(),
      {
        'GET /api/v1/me/children/501/timetable': () => ({
          status: 200,
          body: familyWeek({ sectionName: null, className: null, days: week(() => []) }),
        }),
      },
    );
    expect(await screen.findByText('Not in a class this week')).toBeOnTheScreen();
    expect(screen.queryByTestId(`timetable.day.${MONDAY}`)).toBeNull();
  });

  test('an untimetabled day says so; an error offers a retry', async () => {
    await renderSignedIn(
      <FamilyTimetableScreen source={{ kind: 'child', studentId: '501' }} />,
      guardianMe(),
      {
        'GET /api/v1/me/children/501/timetable': () => ({
          status: 200,
          body: familyWeek({ days: week(() => []) }),
        }),
      },
    );
    fireEvent.press(await screen.findByTestId(`timetable.day.${MONDAY}`));
    expect(await screen.findByText('No timetable for this day yet')).toBeOnTheScreen();
    screen.unmount();
    queryClient.clear();
    await renderSignedIn(<FamilyTimetableScreen source={{ kind: 'own' }} />, studentMe(), {
      'GET /api/v1/me/student/timetable': () => ({ status: 500, body: {} }),
    });
    expect(await screen.findByTestId('state.retry')).toBeOnTheScreen();
  });

  test('offline: needs a connection', async () => {
    setOnline(false);
    await renderSignedIn(<FamilyTimetableScreen source={{ kind: 'own' }} />, studentMe());
    expect(await screen.findByText('Needs a connection')).toBeOnTheScreen();
  });
});
