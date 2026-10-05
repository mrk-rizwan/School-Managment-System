import { Capability } from '@asms/shared';
import { fireEvent, screen, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import type {
  DailySummaryDto,
  MeDto,
  SectionDayDto,
  StaffDto,
  TeacherAssignmentDto,
} from '../api/contracts';
import { queryClient } from '../api/query-client';
import { getDb } from '../db/database';
import { errorBody, resetDevice, type Handler } from '../test/fake-api';
import { meFixture, TODAY } from '../test/fixtures';
import { eventually, renderSignedIn, setOnline } from '../test/screen';
import { coverOutcome, summaryLine } from './today-model';
import { TodayScreen } from './TodayScreen';

// slice-16 §7.1 (today/today.spec.tsx, today/cover.spec.tsx): the unrecorded rows and their
// actions by capability, Record now's route, the summary lines, and the cover sheet — online
// only, coversAssignmentId resolved from the class teacher's live row, every error's words.

const principal = (capabilities?: string[]): MeDto =>
  meFixture({
    roles: ['principal'],
    capabilities: (capabilities ?? [
      Capability.ATTENDANCE_STUDENT_VIEW_ALL,
      Capability.ATTENDANCE_STUDENT_MARK,
      Capability.CLASS_MANAGE,
      Capability.STAFF_VIEW,
    ]) as MeDto['capabilities'],
  });

function sectionDay(patch: Partial<SectionDayDto> = {}): SectionDayDto {
  return {
    academicYearId: '3',
    classId: '20',
    className: 'Class 5',
    classTeacherName: 'Nadia Teacher',
    classTeacherStaffId: '9',
    coverStaffIds: [],
    coverStaffName: null,
    date: TODAY,
    declaredHolidayAfter: false,
    mode: 'daily',
    recorded: false,
    registersExpected: 1,
    registersRecorded: 0,
    rosterCount: 30,
    sectionId: '13',
    sectionName: 'B',
    submittedAt: null,
    submittedBy: null,
    submittedByName: null,
    ...patch,
  };
}

function summaryRow(patch: Partial<DailySummaryDto> = {}): DailySummaryDto {
  return {
    absent: 2,
    classId: '20',
    className: 'Class 5',
    computedAt: '2026-10-04T04:00:00.000Z',
    date: TODAY,
    late: 1,
    mode: 'daily',
    onLeave: 0,
    partial: 1,
    present: 28,
    registersExpected: 1,
    registersRecorded: 1,
    rosterCount: 32,
    sectionId: '12',
    sectionName: 'A',
    stale: false,
    teachingDay: true,
    unrecorded: 0,
    ...patch,
  };
}

const staffMember = (id: string, fullName: string): StaffDto => ({
  cnicMasked: '35202-*****-**2',
  createdAt: '2026-09-01T00:00:00.000Z',
  customRoleNames: [],
  designation: 'Teacher',
  fullName,
  hasCnic: true,
  id,
  joinedOn: null,
  phone: '+923001234567',
  status: 'active',
  systemRoles: ['teacher'],
  updatedAt: '2026-09-01T00:00:00.000Z',
  userId: null,
});

const classTeacherRow: TeacherAssignmentDto = {
  academicYearId: '3',
  academicYearName: '2026–27',
  activeToday: true,
  classId: '20',
  className: 'Class 5',
  coversAssignmentId: null,
  coversStaffFullName: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  endsOn: null,
  id: '70',
  role: 'class_teacher',
  sectionId: '13',
  sectionName: 'B',
  staffFullName: 'Nadia Teacher',
  staffId: '9',
  startsOn: '2026-09-01',
  subjectId: null,
  subjectName: null,
  voidedAt: null,
};

const page = (data: unknown[], limit = 25) => ({
  status: 200,
  body: { data, page: 1, limit, total: data.length },
});

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/v1/attendance-registers': () => page([sectionDay()]),
    'GET /api/v1/attendance-reports/daily-summary': () => page([summaryRow()], 50),
    'GET /api/v1/staff': () =>
      page([staffMember('9', 'Nadia Teacher'), staffMember('11', 'Imran Shah')], 50),
    'GET /api/v1/staff/9/teacher-assignments': () => page([classTeacherRow], 50),
    ...over,
  };
}

beforeEach(async () => {
  await resetDevice();
  setOnline(true);
});
afterEach(() => queryClient.clear());

test('an unrecorded row: class, class teacher, roster and mode; both actions for a principal', async () => {
  const { fake } = await renderSignedIn(<TodayScreen />, principal(), routes());
  const row = await screen.findByTestId('today.unrecorded.13');
  expect(within(row).getByText('Class 5 B')).toBeOnTheScreen();
  expect(within(row).getByText('Nadia Teacher')).toBeOnTheScreen();
  expect(within(row).getByText('30 students · Daily register')).toBeOnTheScreen();
  const list = fake.calls.find((c) => c.path === '/api/v1/attendance-registers')!;
  expect(Object.fromEntries(list.query)).toEqual({
    date: TODAY,
    recorded: 'false',
    limit: '25',
    page: '1',
  });

  fireEvent.press(screen.getByTestId('today.recordNow.13'));
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/today/[sectionId]/register',
    params: { sectionId: '13', date: TODAY, period: '1' },
  });
  expect(screen.getByTestId('today.cover.13')).toBeOnTheScreen();
  // No phone and no identity number from StaffDto ever reaches Today.
  expect(screen.queryByText(/\+92|35202/)).toBeNull();
});

test('a cover name and a section with no class teacher', async () => {
  await renderSignedIn(
    <TodayScreen />,
    principal(),
    routes({
      'GET /api/v1/attendance-registers': () =>
        page([
          sectionDay({ coverStaffName: 'Imran Shah' }),
          sectionDay({
            sectionId: '14',
            sectionName: 'C',
            classTeacherName: null,
            classTeacherStaffId: null,
          }),
        ]),
    }),
  );
  expect(await screen.findByText('Cover: Imran Shah')).toBeOnTheScreen();
  expect(
    within(screen.getByTestId('today.unrecorded.14')).getByText('No class teacher'),
  ).toBeOnTheScreen();
});

test('actions follow the capabilities and their scope (MeDto.capabilityScopes)', async () => {
  // view_all only: no Record now, no cover.
  await renderSignedIn(
    <TodayScreen />,
    principal([Capability.ATTENDANCE_STUDENT_VIEW_ALL]),
    routes(),
  );
  await screen.findByTestId('today.unrecorded.13');
  expect(screen.queryByTestId('today.recordNow.13')).toBeNull();
  expect(screen.queryByTestId('today.cover.13')).toBeNull();
});

test('a mark key scoped to assignments does not offer Record now on another section', async () => {
  const me = principal();
  me.capabilityScopes = me.capabilityScopes.map((s) =>
    s.capability === Capability.ATTENDANCE_STUDENT_MARK ? { ...s, scope: 'assigned_sections' } : s,
  );
  await renderSignedIn(<TodayScreen />, me, routes());
  await screen.findByTestId('today.unrecorded.13');
  expect(screen.queryByTestId('today.recordNow.13')).toBeNull();
  expect(screen.getByTestId('today.cover.13')).toBeOnTheScreen();
});

test('every register recorded; not a teaching day', async () => {
  await renderSignedIn(
    <TodayScreen />,
    principal(),
    routes({ 'GET /api/v1/attendance-registers': () => page([]) }),
  );
  expect(await screen.findByText('Every register is recorded.')).toBeOnTheScreen();
  queryClient.clear();
  await resetDevice();
  setOnline(true);
  screen.unmount();
  await renderSignedIn(
    <TodayScreen />,
    principal(),
    routes({
      'GET /api/v1/attendance-reports/daily-summary': () =>
        page([summaryRow({ teachingDay: false })], 50),
    }),
  );
  expect(await screen.findByText('Not a teaching day.')).toBeOnTheScreen();
});

test('the summary line, its updating and not-yet-computed forms', async () => {
  expect(summaryLine(summaryRow())).toBe('A: 28 P · 2 A · 1 L · 0 O · 1 partly · 0 not recorded');
  expect(summaryLine(summaryRow({ stale: true }))).toMatch(/\(updating…\)$/);
  expect(summaryLine(summaryRow({ registersExpected: 0 }))).toBe('A: not yet computed');
  await renderSignedIn(<TodayScreen />, principal(), routes());
  expect(await screen.findByTestId('today.summary.12')).toHaveTextContent(
    'A: 28 P · 2 A · 1 L · 0 O · 1 partly · 0 not recorded',
  );
});

test('offline: the cached list with its "as of", and Assign cover disabled', async () => {
  await renderSignedIn(<TodayScreen />, principal(), routes());
  await screen.findByTestId('today.unrecorded.13');
  setOnline(false);
  expect(await screen.findByTestId('state.offline')).toBeOnTheScreen();
  expect(screen.getByTestId('today.cover.13')).toBeDisabled();
  expect(screen.getByText('Needs a connection')).toBeOnTheScreen();
  // Recording stays available: the register itself works offline.
  expect(screen.getByTestId('today.recordNow.13')).toBeEnabled();
});

describe('the cover sheet', () => {
  async function openCover(over: Record<string, Handler> = {}) {
    const rendered = await renderSignedIn(<TodayScreen />, principal(), routes(over));
    fireEvent.press(await screen.findByTestId('today.cover.13'));
    await screen.findByTestId('cover.staff.11');
    return rendered;
  }

  test('posts a cover row for the section with the class teacher’s live row, then says so', async () => {
    let posted: unknown = null;
    const { fake } = await openCover({
      'POST /api/v1/staff/11/teacher-assignments': (request) => {
        posted = request.body;
        return { status: 201, body: { ...classTeacherRow, id: '71', role: 'cover' } };
      },
    });
    // Names and designations only: never the phone or the masked identity number.
    expect(screen.queryByText(/\+92|35202/)).toBeNull();
    fireEvent.press(screen.getByTestId('cover.staff.11'));
    fireEvent.press(screen.getByTestId('cover.submit'));
    await eventually(() =>
      expect(screen.getByText('Cover arranged; Imran Shah has been told.')).toBeOnTheScreen(),
    );
    expect(posted).toEqual({
      role: 'cover',
      classId: '20',
      sectionId: '13',
      startsOn: TODAY,
      endsOn: TODAY,
      coversAssignmentId: '70',
    });
    // The list is read again; the row stays until a register exists.
    expect(
      fake.calls.filter((c) => c.path === '/api/v1/attendance-registers').length,
    ).toBeGreaterThan(1);
    expect(screen.getByTestId('today.unrecorded.13')).toBeOnTheScreen();
  });

  test('the staff page is cached as id, name and designation only (review M3)', async () => {
    await openCover();
    const db = await getDb();
    const rows = await db.getAllAsync<{ key: string; body: string }>(
      "SELECT key, body FROM cache WHERE key LIKE 'GET /api/v1/staff?%'",
    );
    expect(rows).toHaveLength(1);
    const cached = JSON.parse(rows[0]!.body) as { data: Record<string, unknown>[] };
    expect(cached.data[0]).toEqual({ id: '9', fullName: 'Nadia Teacher', designation: 'Teacher' });
    expect(rows[0]!.body).not.toMatch(/phone|cnicMasked|userId|\+92|35202/);
  });

  test("the class teacher's assignments could not be read: no submit, and Retry (review L4)", async () => {
    let fail = true;
    await renderSignedIn(
      <TodayScreen />,
      principal(),
      routes({
        'GET /api/v1/staff/9/teacher-assignments': () =>
          fail ? 'network' : page([classTeacherRow], 50),
      }),
    );
    fireEvent.press(await screen.findByTestId('today.cover.13'));
    await eventually(() => expect(screen.getByTestId('cover.assignmentsFailed')).toBeOnTheScreen());
    expect(screen.getByTestId('cover.submit')).toBeDisabled();
    fail = false;
    fireEvent.press(screen.getByTestId('cover.retry'));
    await eventually(() => expect(screen.queryByTestId('cover.assignmentsFailed')).toBeNull());
    expect(screen.getByTestId('cover.submit')).toBeEnabled();
  });

  test('a section with no class teacher: no coversAssignmentId', async () => {
    let posted: Record<string, unknown> = {};
    await renderSignedIn(
      <TodayScreen />,
      principal(),
      routes({
        'GET /api/v1/attendance-registers': () =>
          page([sectionDay({ classTeacherName: null, classTeacherStaffId: null })]),
        'POST /api/v1/staff/11/teacher-assignments': (request) => {
          posted = request.body as Record<string, unknown>;
          return { status: 201, body: classTeacherRow };
        },
      }),
    );
    fireEvent.press(await screen.findByTestId('today.cover.13'));
    expect(await screen.findByText('Covering a section with no class teacher.')).toBeOnTheScreen();
    fireEvent.press(await screen.findByTestId('cover.staff.11'));
    fireEvent.press(screen.getByTestId('cover.submit'));
    await eventually(() => expect(posted.role).toBe('cover'));
    expect(posted).not.toHaveProperty('coversAssignmentId');
  });

  test('13 digits in the search box: it searches names only', async () => {
    await openCover();
    fireEvent.changeText(screen.getByTestId('cover.search'), '3520212345671');
    expect(screen.getByText('Search by name')).toBeOnTheScreen();
    fireEvent.changeText(screen.getByTestId('cover.search'), 'imran');
    expect(screen.queryByTestId('cover.staff.9')).toBeNull();
    expect(screen.getByTestId('cover.staff.11')).toBeOnTheScreen();
  });

  test.each([
    ['CAPABILITY_NOT_HELD', 'Imran Shah cannot mark registers.'],
    ['SELF_ACTION_FORBIDDEN', 'You already hold every class.'],
    ['STAFF_NOT_ACTIVE', 'That staff member has left.'],
  ])('%s → its words', async (code, words) => {
    await openCover({
      'POST /api/v1/staff/11/teacher-assignments': () => ({
        status: 409,
        body: errorBody(code, 'That staff member has left.'),
      }),
    });
    fireEvent.press(screen.getByTestId('cover.staff.11'));
    fireEvent.press(screen.getByTestId('cover.submit'));
    await eventually(() => expect(screen.getByTestId('cover.message')).toHaveTextContent(words));
  });

  test('ASSIGNMENT_EXISTS is treated as done', async () => {
    await openCover({
      'POST /api/v1/staff/11/teacher-assignments': () => ({
        status: 409,
        body: errorBody('ASSIGNMENT_EXISTS', 'exists'),
      }),
    });
    fireEvent.press(screen.getByTestId('cover.staff.11'));
    fireEvent.press(screen.getByTestId('cover.submit'));
    await eventually(() =>
      expect(screen.getByText('Imran Shah already covers this section.')).toBeOnTheScreen(),
    );
  });

  test('nobody chosen, or the dates the wrong way round: refused before any request', async () => {
    const { fake } = await openCover();
    fireEvent.press(screen.getByTestId('cover.submit'));
    expect(await screen.findByText('Choose who covers.')).toBeOnTheScreen();
    fireEvent.press(screen.getByTestId('cover.staff.11'));
    fireEvent.changeText(screen.getByTestId('cover.endsOn'), '2000-01-01');
    fireEvent.press(screen.getByTestId('cover.submit'));
    expect(await screen.findByText('Ends before it starts.')).toBeOnTheScreen();
    expect(fake.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  test('a network failure is a message, never a queued write', () => {
    expect(coverOutcome(new TypeError('Network request failed'), 'Imran')).toEqual({
      done: false,
      message: 'No connection. Arranging cover needs a connection.',
    });
  });
});
