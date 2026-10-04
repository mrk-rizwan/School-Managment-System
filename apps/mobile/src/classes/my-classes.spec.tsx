import { fireEvent, screen, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { SectionDto } from '../api/contracts';
import { queryClient } from '../api/query-client';
import { composeTabs } from '../auth/tabs';
import { meFixture, resetDevice } from '../test/fake-api';
import { assignment, teacherMe, TODAY } from '../test/fixtures';
import { eventually, renderSignedIn, setOnline } from '../test/screen';
import { actionsFor, groupAssignments } from './my-classes';
import { MyClassesScreen } from './MyClassesScreen';

// slice-16 §4.1 (classes/my-classes.spec.tsx).

const section = (id: string, name: string): SectionDto => ({
  archivedAt: null,
  capacity: null,
  classId: '20',
  createdAt: '2026-09-01T00:00:00.000Z',
  id,
  name,
  updatedAt: '2026-09-01T00:00:00.000Z',
});

beforeEach(async () => {
  await resetDevice();
  setOnline(true);
});
afterEach(() => queryClient.clear());

describe('grouping (pure)', () => {
  test('class teacher, cover and subject rows on one section merge into one row with every role', () => {
    const rows = groupAssignments(
      [
        assignment(),
        assignment({ id: '71', role: 'subject_teacher', subjectId: '7', subjectName: 'English' }),
        assignment({ id: '72', role: 'subject_teacher', subjectId: '8', subjectName: 'Urdu' }),
        assignment({
          id: '73',
          role: 'cover',
          sectionId: '13',
          sectionName: 'B',
          endsOn: '2026-10-10',
        }),
      ],
      () => undefined,
    );
    expect(rows.map((r) => [r.sectionId, r.roles])).toEqual([
      ['12', ['Class teacher', 'English, Urdu']],
      ['13', ['Covering until 10 Oct 2026']],
    ]);
  });

  test("a whole-class subject row stands for each of the class's sections", () => {
    const rows = groupAssignments(
      [
        assignment({
          role: 'subject_teacher',
          sectionId: null,
          sectionName: null,
          subjectId: '7',
          subjectName: 'English',
        }),
      ],
      () => [
        section('12', 'A'),
        section('13', 'B'),
        { ...section('14', 'C'), archivedAt: '2026-09-02T00:00:00.000Z' },
      ],
    );
    expect(rows.map((r) => `${r.className} ${r.sectionName}: ${r.roles.join(', ')}`)).toEqual([
      'Class 5 A: English',
      'Class 5 B: English',
    ]);
  });

  test('a subject teacher in a daily-mode class cannot open the register', () => {
    const [row] = groupAssignments(
      [assignment({ role: 'subject_teacher', subjectId: '7', subjectName: 'English' })],
      () => undefined,
    );
    expect(actionsFor(teacherMe(), row!).register).toEqual({
      shown: true,
      enabled: false,
      reason: 'Daily register is the class teacher’s',
    });
    const [periodRow] = groupAssignments(
      [
        assignment({
          role: 'subject_teacher',
          attendanceMode: 'period',
          subjectId: '7',
          subjectName: 'English',
        }),
      ],
      () => undefined,
    );
    expect(actionsFor(teacherMe(), periodRow!).register.enabled).toBe(true);
  });

  test('the mark key held school-wide opens any register (MeDto.capabilityScopes)', () => {
    const [row] = groupAssignments(
      [assignment({ role: 'subject_teacher', subjectId: '7', subjectName: 'English' })],
      () => undefined,
    );
    const me = teacherMe();
    const granted = {
      ...me,
      capabilityScopes: me.capabilityScopes.map((s) => ({ ...s, scope: 'all' as const })),
    };
    expect(actionsFor(granted, row!).register).toEqual({ shown: true, enabled: true, reason: null });
  });

  test('a principal has no assignments and no Classes tab', () => {
    expect(composeTabs(meFixture())).not.toContain('classes');
  });
});

describe('the screen', () => {
  test('rows with their actions; Register opens today, period 1', async () => {
    await renderSignedIn(<MyClassesScreen />, teacherMe());
    const card = await screen.findByTestId('classes.section.12');
    expect(card).toHaveTextContent(/Class 5 A/);
    expect(card).toHaveTextContent(/Class teacher · Daily register/);
    fireEvent.press(within(card).getByTestId('classes.section.12.register'));
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/classes/[sectionId]/register',
      params: { sectionId: '12', date: TODAY, period: '1' },
    });
    expect(within(card).getByTestId('classes.section.12.diary')).toBeOnTheScreen();
    expect(within(card).getByTestId('classes.section.12.students')).toBeOnTheScreen();
  });

  test('whole-class rows are expanded from the class sections (cached, 50 a page)', async () => {
    const me = teacherMe({
      assignments: [
        assignment({
          role: 'subject_teacher',
          sectionId: null,
          sectionName: null,
          subjectId: '7',
          subjectName: 'English',
        }),
      ],
    });
    const { fake } = await renderSignedIn(<MyClassesScreen />, me, {
      'GET /api/v1/classes/20/sections': () => ({
        status: 200,
        body: { data: [section('12', 'A'), section('13', 'B')], page: 1, limit: 50, total: 2 },
      }),
    });
    await screen.findByTestId('classes.section.13');
    const call = fake.calls.find((c) => c.path === '/api/v1/classes/20/sections')!;
    expect(call.query.get('limit')).toBe('50');
    // The daily register is not a subject teacher's.
    expect(screen.getByTestId('classes.section.12')).toHaveTextContent(
      /Daily register is the class teacher’s/,
    );
  });

  test('no assignments: "No classes assigned to you today. Ask the office."', async () => {
    await renderSignedIn(<MyClassesScreen />, teacherMe({ assignments: [] }));
    await eventually(() =>
      expect(
        screen.getByText('No classes assigned to you today. Ask the office.'),
      ).toBeOnTheScreen(),
    );
  });
});
