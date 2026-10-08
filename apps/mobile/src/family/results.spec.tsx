import { fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { preventScreenCaptureAsync } from 'expo-screen-capture';
import type { MyAssessmentMarkDto, MyChildResultsDto, MyResultDto } from '../api/contracts';
import { queryClient } from '../api/query-client';
import { resetDevice } from '../test/fake-api';
import { guardianMe } from '../test/fixtures';
import { renderSignedIn, setOnline } from '../test/screen';
import { ChildrenScreen } from './ChildrenScreen';
import { FamilyResultCardScreen, FamilyResultsScreen } from './FamilyResults';
import { StudentIndexScreen } from './StudentIndexScreen';

// Slice 33 (contracts/slice-33.md §5): a parent's child's results and the student's own — the
// year's published terms, the card (slice 32's ReportCardView, stubbed here: its own spec renders
// it), a withheld card with the amount for the parent and none for the student, class tests;
// online only, never cached; secure.

jest.mock('../results/ReportCardView', () => ({
  ReportCardView: ({ result }: { result: { id: string; percentBp: number | null } }) => {
    const { Text: T } = jest.requireActual<typeof import('react-native')>('react-native');
    return <T testID={`reportCard.${result.id}`}>{`card ${result.percentBp}`}</T>;
  },
}));

const SUMMARY = {
  id: '900',
  academicYearId: '3',
  academicYearName: '2026–27',
  termId: '41',
  termName: 'Mid-term',
  isFinal: false,
  className: 'Class 5',
  sectionName: 'A',
  percentBp: 7450,
  grade: 'B',
  revised: false,
  publishedAt: '2026-10-04T04:00:00.000Z',
};

const list = (patch: Partial<MyChildResultsDto> = {}): MyChildResultsDto => ({
  studentId: '501',
  academicYearId: '3',
  years: [{ id: '3', name: '2026–27' }],
  terms: [SUMMARY],
  final: null,
  withheld: false,
  outstanding: null,
  ...patch,
});

const TEST_MARK: MyAssessmentMarkDto = {
  markId: '70',
  assessmentId: '60',
  name: 'Weekly test',
  testType: 'weekly',
  heldOn: '2026-10-01',
  termId: '41',
  termName: 'Mid-term',
  subjectName: 'Mathematics',
  maxMarks: 20,
  obtained: 15,
  absent: false,
  excused: false,
};

const page = (data: unknown[]) => ({ status: 200, body: { data, page: 1, limit: 25, total: data.length } });

const studentMe = () =>
  guardianMe({ id: '81', fullName: 'Ali Raza', roles: ['student'], capacities: ['student'], children: [] });

beforeEach(async () => {
  await resetDevice();
  setOnline(true);
});
afterEach(() => queryClient.clear());

describe('family results (slice 33)', () => {
  test("a child's card row opens the Results screen", async () => {
    await renderSignedIn(<ChildrenScreen secure />, guardianMe(), {
      'GET /api/v1/me/children/501/attendance': () => ({ status: 404, body: {} }),
    });
    fireEvent.press(await screen.findByTestId('children.card.501.results'));
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/children/[studentId]/results',
      params: { studentId: '501' },
    });
  });

  test('the published term with its figures, class tests, the card on press; secure', async () => {
    const { fake } = await renderSignedIn(
      <FamilyResultsScreen source={{ kind: 'child', studentId: '501' }} secure />,
      guardianMe(),
      {
        'GET /api/v1/me/children/501/results': () => ({ status: 200, body: list() }),
        'GET /api/v1/me/children/501/assessments': () => page([TEST_MARK]),
      },
    );
    const row = await screen.findByTestId('results.summary.900');
    expect(row).toHaveTextContent(/Mid-term/);
    expect(row).toHaveTextContent(/74.50 % · B/);
    expect(await screen.findByTestId('results.test.60')).toHaveTextContent(/15 \/ 20/);
    expect(preventScreenCaptureAsync).toHaveBeenCalled();
    fireEvent.press(row);
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/children/[studentId]/results/[resultId]',
      params: { studentId: '501', resultId: '900' },
    });
    expect(fake.calls.some((c) => c.path.includes('/me/student/'))).toBe(false);
  });

  test('the card screen renders the stored card', async () => {
    const card = { withheld: false, outstanding: null, result: { id: '900', percentBp: 7450 } } as unknown as MyResultDto;
    await renderSignedIn(<FamilyResultCardScreen source={{ kind: 'child', studentId: '501' }} resultId="900" />, guardianMe(), {
      'GET /api/v1/me/children/501/results/900': () => ({ status: 200, body: card }),
    });
    expect(await screen.findByTestId('reportCard.900')).toHaveTextContent('card 7450');
  });

  test('withheld: the parent sees the amount and no card', async () => {
    await renderSignedIn(<FamilyResultCardScreen source={{ kind: 'child', studentId: '501' }} resultId="900" />, guardianMe(), {
      'GET /api/v1/me/children/501/results/900': () => ({
        status: 200,
        body: { withheld: true, outstanding: 4500, result: null },
      }),
    });
    expect(await screen.findByTestId('results.withheld')).toHaveTextContent(/4,500/);
    expect(screen.queryByTestId('reportCard.900')).toBeNull();
  });

  test('the student: bound to /me/student, withheld with no figure', async () => {
    const { fake } = await renderSignedIn(<FamilyResultsScreen source={{ kind: 'own' }} />, studentMe(), {
      'GET /api/v1/me/student/results': () => ({
        status: 200,
        body: list({ withheld: true, terms: [{ ...SUMMARY, percentBp: null, grade: null }] }),
      }),
      'GET /api/v1/me/student/assessments': () => page([]),
    });
    const withheld = await screen.findByTestId('results.withheld');
    expect(withheld).not.toHaveTextContent(/Rs/);
    // Security L3: the student is not told it is about fees.
    expect(withheld).toHaveTextContent(/Report card not available/);
    expect(withheld).toHaveTextContent(/ask your parent or the school office/);
    expect(withheld).not.toHaveTextContent(/fee/i);
    expect(screen.getByTestId('results.summary.900')).toHaveTextContent(/—/);
    expect(await screen.findByText('No class test has been marked yet.')).toBeOnTheScreen();
    expect(fake.calls.some((c) => c.path.includes('/me/children/'))).toBe(false);
  });

  test('class tests page: "Load older" appends the next page until the total', async () => {
    const mark = (n: number): MyAssessmentMarkDto => ({ ...TEST_MARK, markId: String(700 + n), assessmentId: String(600 + n) });
    const { fake } = await renderSignedIn(
      <FamilyResultsScreen source={{ kind: 'child', studentId: '501' }} />,
      guardianMe(),
      {
        'GET /api/v1/me/children/501/results': () => ({ status: 200, body: list() }),
        'GET /api/v1/me/children/501/assessments': ({ query }) => {
          const n = Number(query.get('page'));
          const data = n === 1 ? Array.from({ length: 25 }, (_, i) => mark(i)) : [mark(25), mark(26)];
          return { status: 200, body: { data, page: n, limit: 25, total: 27 } };
        },
      },
    );
    expect(await screen.findByTestId('results.test.624')).toBeOnTheScreen();
    expect(screen.queryByTestId('results.test.625')).toBeNull();
    fireEvent.press(screen.getByTestId('results.loadOlder'));
    expect(await screen.findByTestId('results.test.626')).toBeOnTheScreen();
    // The first page stays; nothing more to load.
    expect(screen.getByTestId('results.test.600')).toBeOnTheScreen();
    expect(screen.queryByTestId('results.loadOlder')).toBeNull();
    expect(fake.calls.filter((c) => c.path.includes('/assessments')).map((c) => c.query.get('page'))).toEqual(['1', '2']);
  });

  test('"My school" has a Results row', async () => {
    await renderSignedIn(<StudentIndexScreen secure />, studentMe());
    fireEvent.press(await screen.findByTestId('student.results'));
    expect(router.push).toHaveBeenCalledWith('/student/results');
  });

  test('offline: says it needs a connection and asks nothing', async () => {
    setOnline(false);
    const { fake } = await renderSignedIn(
      <FamilyResultsScreen source={{ kind: 'child', studentId: '501' }} />,
      guardianMe(),
    );
    expect(await screen.findByText('Needs a connection')).toBeOnTheScreen();
    expect(fake.calls.some((c) => c.path.includes('/results'))).toBe(false);
  });
});
