import type { ReactElement } from 'react';
import { fireEvent, screen, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { preventScreenCaptureAsync } from 'expo-screen-capture';
import { shareAsync } from 'expo-sharing';
import type { MyChildDto, MyDiaryEntryDto, MyRemarkDto } from '../api/contracts';
import { queryClient } from '../api/query-client';
import { resetDevice, type Handler } from '../test/fake-api';
import { downloadCalls, filesUnder, CACHE } from '../test/file-system';
import { guardianMe, studentAttendance, TODAY } from '../test/fixtures';
import { IDENTITY_PATTERN, PHONE_PATTERN } from '../test/patterns';
import { eventually, renderSignedIn, setOnline } from '../test/screen';
import { monthToDate } from '../diary/dates';
import { ChildrenScreen } from './ChildrenScreen';
import { FamilyAttendanceScreen, FamilyDiaryScreen, FamilyRemarksScreen } from './FamilyScreens';
import { StudentIndexScreen } from './StudentIndexScreen';

// slice-16 §5.1–5.5 (children/children.spec.tsx, children/diary.spec.tsx,
// children/remarks.spec.tsx, student/student.spec.tsx): the parent's and the student's screens.

const CHILD_ATTENDANCE = 'GET /api/v1/me/children/501/attendance';

function myDiary(patch: Partial<MyDiaryEntryDto> = {}): MyDiaryEntryDto {
  return {
    assignment: 'Exercise 4',
    attachmentMime: null,
    attachmentSizeBytes: null,
    authorName: 'Nadia Teacher',
    classId: '20',
    className: 'Class 5',
    createdAt: '2026-10-04T04:00:00.000Z',
    date: TODAY,
    dueOn: null,
    hasAttachment: false,
    id: '300',
    learningOutcome: null,
    sectionId: '12',
    sectionName: 'A',
    subjectId: '7',
    subjectName: 'English',
    topic: 'Reading: chapter 3',
    updatedAt: '2026-10-04T04:00:00.000Z',
    ...patch,
  };
}

function myRemark(patch: Partial<MyRemarkDto> = {}): MyRemarkDto {
  return {
    authorName: 'Nadia Teacher',
    category: 'homework',
    createdAt: '2026-10-04T04:00:00.000Z',
    date: TODAY,
    id: '77',
    studentId: '501',
    subjectId: null,
    subjectName: null,
    supersededAt: null,
    supersededById: null,
    supersedesId: null,
    text: 'Homework done well',
    ...patch,
  };
}

const page = (data: unknown[]) => ({
  status: 200,
  body: { data, page: 1, limit: 25, total: data.length },
});
/** Every piece of text on the screen. */
const text = () =>
  screen
    .queryAllByText(/[\s\S]*/)
    .map((node) => [node.props.children as unknown].flat().join(''))
    .join('\n');

beforeEach(async () => {
  await resetDevice();
  setOnline(true);
});
afterEach(() => queryClient.clear());

describe('Children (§5.1)', () => {
  test("one card per child: class and roll, today's status, this month; one request per child; secure", async () => {
    const second: MyChildDto = {
      ...guardianMe().children[0]!,
      fullName: 'Sara Raza',
      studentId: '502',
      status: 'withdrawn',
      current: null,
    };
    const me = guardianMe({ children: [guardianMe().children[0]!, second] });
    const { fake } = await renderSignedIn(<ChildrenScreen secure />, me, {
      [CHILD_ATTENDANCE]: () => ({ status: 200, body: studentAttendance() }),
      'GET /api/v1/me/children/502/attendance': () => ({
        status: 200,
        body: studentAttendance({ percentage: null, studentId: '502' }),
      }),
    });
    const card = await screen.findByTestId('children.card.501');
    expect(card).toHaveTextContent(/Ali Raza/);
    expect(card).toHaveTextContent(/Class 5 A · Roll 1/);
    await eventually(() =>
      expect(screen.getByTestId('children.card.501.today')).toHaveTextContent('Absent'),
    );
    expect(card).toHaveTextContent(/This month: 66.7% — 2 of 3 days/);
    const left = screen.getByTestId('children.card.502');
    expect(left).toHaveTextContent(/No current class/);
    expect(left).toHaveTextContent(/Left/);
    await eventually(() => expect(left).toHaveTextContent(/No recorded days yet/));
    const reads = fake.calls.filter((c) => /\/me\/children\/\d+\/attendance$/.test(c.path));
    expect(reads.map((c) => c.path).sort()).toEqual([
      '/api/v1/me/children/501/attendance',
      '/api/v1/me/children/502/attendance',
    ]);
    const range = monthToDate(TODAY);
    expect(reads[0]!.query.get('dateFrom')).toBe(range.dateFrom);
    expect(reads[0]!.query.get('dateTo')).toBe(range.dateTo);
    expect(preventScreenCaptureAsync).toHaveBeenCalled();
    fireEvent.press(within(card).getByTestId('children.card.501.open'));
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/children/[studentId]/attendance',
      params: { studentId: '501' },
    });
  });

  test('no school today and not recorded yet are said in words', async () => {
    const notToday = studentAttendance();
    notToday.days[3] = { ...notToday.days[3]!, teachingDay: false, status: null };
    await renderSignedIn(<ChildrenScreen secure />, guardianMe(), {
      [CHILD_ATTENDANCE]: () => ({ status: 200, body: notToday }),
    });
    await eventually(() =>
      expect(screen.getByTestId('children.card.501.today')).toHaveTextContent('No school today'),
    );
  });

  test('no children: "No children are linked to your account. Ask the school office."', async () => {
    await renderSignedIn(<ChildrenScreen secure />, guardianMe({ children: [] }));
    expect(
      await screen.findByText('No children are linked to your account. Ask the school office.'),
    ).toBeOnTheScreen();
  });
});

describe('a child’s month (§5.2)', () => {
  test('this month reads the same key the card used; Next is off at the current month', async () => {
    const { fake } = await renderSignedIn(
      <FamilyAttendanceScreen source={{ kind: 'child', studentId: '501' }} secure />,
      guardianMe(),
      { [CHILD_ATTENDANCE]: () => ({ status: 200, body: studentAttendance() }) },
    );
    expect(await screen.findByTestId('attendanceMonth.grid')).toBeOnTheScreen();
    expect(screen.getByText('Ali Raza')).toBeOnTheScreen();
    expect(screen.getByTestId('attendanceMonth.next')).toBeDisabled();
    const read = fake.calls.find((c) => c.path === '/api/v1/me/children/501/attendance')!;
    expect(read.query.get('dateTo')).toBe(TODAY);
    // Only the two dates: the month's title is no query parameter (the server refuses unknowns).
    expect([...read.query.keys()].sort()).toEqual(['dateFrom', 'dateTo']);
    expect(preventScreenCaptureAsync).toHaveBeenCalled();
  });
});

describe('a child’s diary (§5.3)', () => {
  test('rows carry no image; the photo loads on a tap, thumbnail first, with the bearer in a header', async () => {
    const { fake } = await renderSignedIn(
      <FamilyDiaryScreen source={{ kind: 'child', studentId: '501' }} secure />,
      guardianMe(),
      {
        'GET /api/v1/me/children/501/diary-entries': () =>
          page([
            myDiary({
              attachmentMime: 'image/png',
              hasAttachment: true,
              attachmentSizeBytes: 64_000,
            }),
          ]),
      },
    );
    const row = await screen.findByTestId('familyDiary.entry.300');
    expect(row).toHaveTextContent(/Class 5 A · English/);
    expect(row).toHaveTextContent(/Photo/);
    fireEvent.press(row);
    const sheet = await screen.findByTestId('diary.entrySheet');
    expect(within(sheet).getByText('Nadia Teacher')).toBeOnTheScreen();
    expect(within(sheet).queryByTestId('attachment.thumbnail')).toBeNull();
    fireEvent.press(within(sheet).getByTestId('attachment.show'));
    expect(within(sheet).getByTestId('attachment.thumbnail').props.source).toEqual({
      uri: 'http://api.test/api/v1/me/children/501/diary-entries/300/thumbnail',
      headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Bearer /) }),
    });
    fireEvent.press(within(sheet).getByTestId('attachment.showFull'));
    expect(within(sheet).getByTestId('attachment.full').props.source.uri).toBe(
      'http://api.test/api/v1/me/children/501/diary-entries/300/attachment',
    );
    // The client itself never fetched an image: expo-image did, on the taps.
    expect(fake.calls.some((c) => /\/(thumbnail|attachment)$/.test(c.path))).toBe(false);
    expect(fake.calls.find((c) => c.path.endsWith('/diary-entries'))!.query.get('limit')).toBe(
      '25',
    );
  });

  test('a PDF is downloaded with the bearer header, shared, and deleted', async () => {
    await renderSignedIn(
      <FamilyDiaryScreen source={{ kind: 'child', studentId: '501' }} secure />,
      guardianMe(),
      {
        'GET /api/v1/me/children/501/diary-entries': () =>
          page([
            myDiary({
              attachmentMime: 'application/pdf',
              hasAttachment: true,
              attachmentSizeBytes: 2_000_000,
            }),
          ]),
      },
    );
    fireEvent.press(await screen.findByTestId('familyDiary.entry.300'));
    const sheet = await screen.findByTestId('diary.entrySheet');
    expect(within(sheet).getByTestId('attachment.openPdf')).toHaveTextContent('Open PDF (1.9 MB)');
    fireEvent.press(within(sheet).getByTestId('attachment.openPdf'));
    await eventually(() => expect(shareAsync).toHaveBeenCalled());
    const [download] = downloadCalls();
    expect(download!.url).toBe(
      'http://api.test/api/v1/me/children/501/diary-entries/300/attachment',
    );
    expect(download!.url).not.toContain('Bearer');
    expect(download!.headers.Authorization).toMatch(/^Bearer /);
    await eventually(() => expect(filesUnder(CACHE)).toEqual([]));
  });
});

describe('a child’s remarks (§5.4)', () => {
  test('a corrected remark is muted with "Corrected — see the newer remark", still readable', async () => {
    await renderSignedIn(
      <FamilyRemarksScreen source={{ kind: 'child', studentId: '501' }} secure />,
      guardianMe(),
      {
        'GET /api/v1/me/children/501/remarks': () =>
          page([
            myRemark({ id: '78', text: 'Much better now' }),
            myRemark({ supersededAt: '2026-10-04T05:00:00.000Z' }),
          ]),
      },
    );
    const old = await screen.findByTestId('familyRemarks.remark.77');
    expect(old).toHaveTextContent(/Homework done well/);
    expect(old).toHaveTextContent(/Corrected — see the newer remark/);
    expect(screen.getByTestId('familyRemarks.remark.78')).not.toHaveTextContent(/Corrected/);
  });

  test('empty: "No remarks."', async () => {
    await renderSignedIn(
      <FamilyRemarksScreen source={{ kind: 'child', studentId: '501' }} secure />,
      guardianMe(),
      {
        'GET /api/v1/me/children/501/remarks': () => page([]),
      },
    );
    expect(await screen.findByText('No remarks.')).toBeOnTheScreen();
  });
});

describe('R165: a parent screen renders nothing the /me DTOs do not carry', () => {
  test('a note and a phone in an unrelated staff DTO never reach the screen', async () => {
    // The fake server also answers a staff read with a note and a phone; no parent screen asks for it.
    const staffRead = {
      'GET /api/v1/sections/12/register': () => ({
        status: 200,
        body: { roster: [{ mark: { note: 'Father 0300 1234567 said ill' } }] },
      }),
    };
    await renderSignedIn(<ChildrenScreen secure />, guardianMe(), {
      [CHILD_ATTENDANCE]: () => ({ status: 200, body: studentAttendance() }),
      ...staffRead,
    });
    await eventually(() =>
      expect(screen.getByTestId('children.card.501.today')).toHaveTextContent('Absent'),
    );
    expect(text()).toContain('Ali Raza'); // the screen's text is really being read
    expect(text()).not.toMatch(PHONE_PATTERN);
    expect(text()).not.toMatch(IDENTITY_PATTERN);
    expect(text()).not.toContain('said ill');
    expect(text()).not.toContain('Nadia');
  });
});

describe('the student (§5.5)', () => {
  const studentMe = () =>
    guardianMe({
      id: '81',
      fullName: 'Ali Raza',
      roles: ['student'],
      capacities: ['student'],
      children: [],
    });

  test('"My school" is three rows into the same components, secure', async () => {
    await renderSignedIn(<StudentIndexScreen secure />, studentMe());
    fireEvent.press(await screen.findByTestId('student.diary'));
    expect(router.push).toHaveBeenCalledWith('/student/diary');
    expect(preventScreenCaptureAsync).toHaveBeenCalled();
  });

  test.each([
    [
      'attendance',
      <FamilyAttendanceScreen key="a" source={{ kind: 'own' }} secure />,
      '/api/v1/me/student/attendance',
      () => ({ status: 200, body: studentAttendance() }),
      'attendanceMonth.grid',
    ],
    [
      'diary',
      <FamilyDiaryScreen key="d" source={{ kind: 'own' }} secure />,
      '/api/v1/me/student/diary-entries',
      () => page([myDiary()]),
      'familyDiary.entry.300',
    ],
    [
      'remarks',
      <FamilyRemarksScreen key="r" source={{ kind: 'own' }} secure />,
      '/api/v1/me/student/remarks',
      () => page([myRemark()]),
      'familyRemarks.remark.77',
    ],
  ] as [string, ReactElement, string, Handler, string][])(
    '%s is bound to /me/student',
    async (_n, ui, path, reply, id) => {
      const { fake } = await renderSignedIn(ui, studentMe(), { [`GET ${path}`]: reply });
      expect(await screen.findByTestId(id)).toBeOnTheScreen();
      expect(fake.calls.some((c) => c.path === path)).toBe(true);
      expect(fake.calls.some((c) => c.path.includes('/me/children/'))).toBe(false);
      expect(screen.getByText('Ali Raza')).toBeOnTheScreen();
    },
  );
});
