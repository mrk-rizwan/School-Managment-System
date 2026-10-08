import { fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import type {
  AssessmentDto,
  AssessmentMarksDto,
  AssessmentSubmitMarksDto,
  MeDto,
} from '../api/contracts';
import { queryClient } from '../api/query-client';
import { discardItem } from '../db/local.repository';
import {
  listLocalAssessments,
  markMarksSaved,
  readLocalMarks,
  saveLocalAssessment,
  saveMarks,
} from '../db/local-marks.repository';
import { findItem, listByState, saveItem } from '../db/outbox.repository';
import { mergeBodies } from '../outbox/coalesce';
import { transition } from '../outbox/machine';
import { resetDevice, type FakeRequest } from '../test/fake-api';
import { assignment, teacherMe, TODAY } from '../test/fixtures';
import { eventually, renderSignedIn, setOnline, settleOutbox } from '../test/screen';
import { applyMarkResults, marksToSave, rebaseEntries } from './marks-model';
import { MarksGridScreen } from './MarksGridScreen';
import { NewTestScreen } from './NewTestScreen';
import { markSubjects } from './SectionAssessmentsScreen';

// Phase 4 slice 30 (plan §3.8, contracts/slice-30.md §9): the marks grid offline, the two lanes
// (assessment_create, marks_enter), coalescing, the re-target of marks typed on a test still on
// the phone, per-row outcomes and changed_elsewhere.

const KEY = /^[A-Za-z0-9_-]{16,64}$/;

const mathsTeacher = (): MeDto =>
  teacherMe({
    capabilities: [
      'attendance.student.mark',
      'diary.write',
      'marks.enter',
    ] as MeDto['capabilities'],
    capabilityScopes: [
      { capability: 'attendance.student.mark', scope: 'assigned_sections' },
      { capability: 'diary.write', scope: 'assigned_sections' },
      { capability: 'marks.enter', scope: 'assigned_sections' },
    ],
    assignments: [
      assignment({ role: 'subject_teacher', subjectId: '7', subjectName: 'Mathematics' }),
    ],
  });

const ASSESSMENT: AssessmentDto = {
  id: '500',
  academicYearId: '3',
  termId: '4',
  termName: 'Annual',
  classId: '20',
  className: 'Class 5',
  sectionId: '12',
  sectionName: 'A',
  classSubjectId: '60',
  subjectId: '7',
  subjectName: 'Mathematics',
  kind: 'test',
  testType: 'weekly',
  name: 'Fractions weekly test',
  maxMarks: 20,
  heldOn: TODAY,
  createdByMe: true,
  markedCount: 1,
  canEnterMarks: true,
  lockedAt: null,
  locked: false,
  voidedAt: null,
  voidReason: null,
  createdAt: '2026-10-04T04:00:00.000Z',
  updatedAt: '2026-10-04T04:00:00.000Z',
};

const row = (
  n: number,
  patch: Partial<AssessmentMarksDto['rows'][number]> = {},
): AssessmentMarksDto['rows'][number] => ({
  enrolmentId: `e${n}`,
  student: {
    id: `s${n}`,
    fullName: ['Ali Raza', 'Sara Khan', 'Bilal Ahmed'][n - 1]!,
    admissionNo: `10${n}`,
    rollNo: n,
  },
  markId: null,
  obtained: null,
  absent: false,
  excused: false,
  status: null,
  enteredAt: null,
  ownChildOf: null,
  pendingCorrectionId: null,
  pendingCorrectionMine: false,
  ...patch,
});

const GRID: AssessmentMarksDto = {
  assessment: ASSESSMENT,
  rows: [row(1, { markId: 'm1', obtained: 12, status: 'live' }), row(2), row(3)],
};

/** submit-marks answering every entry `created` (or as `outcomeOf` says), minimal when asked. */
const submitRoute =
  (outcomeOf: (enrolmentId: string) => string = () => 'created') =>
  (request: FakeRequest) => {
    const body = request.body as AssessmentSubmitMarksDto;
    return {
      status: 200,
      headers: { 'Preference-Applied': 'return=minimal' },
      body: {
        assessmentId: '500',
        entries: body.entries.map((e) => ({
          clientEntryKey: e.clientEntryKey,
          enrolmentId: e.enrolmentId,
          markId:
            outcomeOf(e.enrolmentId) === 'changed_elsewhere' ? 'm-theirs' : `m-${e.enrolmentId}`,
          outcome: outcomeOf(e.enrolmentId),
        })),
      },
    };
  };

beforeEach(async () => {
  await resetDevice();
  setOnline(true);
});
afterEach(() => queryClient.clear());

// ------------------------------------------------------------------------------------- pure

describe('the grid model', () => {
  test('only typed rows that differ are sent, each based on the server’s live mark; a bad mark is held back', () => {
    const { marks, errors } = marksToSave(
      GRID.rows,
      {
        e1: { text: '12', absent: false },
        e2: { text: '15', absent: false },
        e3: { text: '25', absent: false },
      },
      new Map(),
      20,
    );
    expect(marks).toEqual([
      { enrolmentId: 'e2', obtained: 15, absent: false, basedOnMarkId: null },
    ]);
    expect(errors).toEqual({ e3: 'At most 20' });
    const absent = marksToSave(GRID.rows, { e1: { text: '', absent: true } }, new Map(), 20);
    expect(absent.marks).toEqual([
      { enrolmentId: 'e1', obtained: null, absent: true, basedOnMarkId: 'm1' },
    ]);
  });

  test('the answer is laid over the grid; a changed-elsewhere row is left for the refetch', () => {
    const sent: AssessmentSubmitMarksDto = {
      entries: [
        {
          enrolmentId: 'e1',
          obtained: 18,
          clientEntryKey: 'k1-aaaaaaaaaaaaaaa',
          basedOnMarkId: 'm1',
        },
        {
          enrolmentId: 'e2',
          absent: true,
          clientEntryKey: 'k2-aaaaaaaaaaaaaaa',
          basedOnMarkId: null,
        },
      ],
    };
    const next = applyMarkResults(GRID, sent, [
      {
        clientEntryKey: 'k1-aaaaaaaaaaaaaaa',
        enrolmentId: 'e1',
        markId: 'm9',
        outcome: 'superseded',
      },
      {
        clientEntryKey: 'k2-aaaaaaaaaaaaaaa',
        enrolmentId: 'e2',
        markId: 'm-x',
        outcome: 'changed_elsewhere',
      },
    ]);
    expect(next.rows[0]).toMatchObject({ markId: 'm9', obtained: 18, status: 'live' });
    expect(next.rows[1]).toEqual(GRID.rows[1]);
    expect(next.assessment.markedCount).toBe(1);
  });

  test('coalescing merges entries by student, latest wins; a landed entry re-bases the one queued behind it', () => {
    const older = {
      entries: [
        { enrolmentId: 'e1', obtained: 1, clientEntryKey: 'a'.repeat(20), basedOnMarkId: null },
      ],
    };
    const newer = {
      entries: [
        { enrolmentId: 'e1', obtained: 2, clientEntryKey: 'b'.repeat(20), basedOnMarkId: null },
      ],
    };
    expect(JSON.parse(mergeBodies(JSON.stringify(older), JSON.stringify(newer)))).toEqual(newer);
    expect(
      rebaseEntries(newer, [{ enrolmentId: 'e1', from: null, to: 'm5' }]).entries[0]!.basedOnMarkId,
    ).toBe('m5');
    expect(rebaseEntries(newer, [{ enrolmentId: 'e1', from: 'm4', to: 'm5' }])).toEqual(newer);
  });

  test('the subjects a teacher enters marks for: their own on the section; a class teacher none of their own', () => {
    expect(markSubjects(mathsTeacher(), '12', '20')).toEqual(['7']);
    expect(markSubjects(teacherMe(), '12', '20')).toEqual([]);
  });
});

// ------------------------------------------------------------------------------ the grid

test('offline: marks typed and saved on the device, then sent with per-row keys and Prefer: return=minimal', async () => {
  const { fake } = await renderSignedIn(
    <MarksGridScreen id="500" local={false} secure />,
    mathsTeacher(),
    {
      'GET /api/v1/assessments/500/marks': () => ({ status: 200, body: GRID }),
      'POST /api/v1/assessments/500/submit-marks': submitRoute(),
    },
  );
  expect(await screen.findByText('Sara Khan')).toBeOnTheScreen();
  setOnline(false);
  fireEvent.changeText(screen.getByTestId('marks.input.e2'), '15');
  fireEvent.press(screen.getByTestId('marks.absent.e3'));
  fireEvent.press(screen.getByTestId('marks.save'));
  await eventually(async () => expect(await listByState('pending')).toHaveLength(1));
  const [item] = await listByState('pending');
  expect(item).toMatchObject({
    lane: 'marks_enter',
    path: '/api/v1/assessments/500/submit-marks',
    naturalKey: 'assessment:500',
  });
  const body = JSON.parse(item!.body) as AssessmentSubmitMarksDto;
  expect(body.entries.map(({ clientEntryKey: _k, ...rest }) => rest)).toEqual([
    { enrolmentId: 'e2', obtained: 15, basedOnMarkId: null },
    { enrolmentId: 'e3', absent: true, basedOnMarkId: null },
  ]);
  for (const entry of body.entries) expect(entry.clientEntryKey).toMatch(KEY);
  expect(await screen.findByText(/Saved on device/)).toBeOnTheScreen();

  // A second change offline coalesces into the same pending row.
  fireEvent.changeText(screen.getByTestId('marks.input.e2'), '16');
  fireEvent.press(screen.getByTestId('marks.save'));
  await eventually(async () => {
    const [merged] = await listByState('pending');
    expect(
      (JSON.parse(merged!.body) as AssessmentSubmitMarksDto).entries.find(
        (e) => e.enrolmentId === 'e2',
      )!.obtained,
    ).toBe(16);
  });
  expect(await listByState('pending')).toHaveLength(1);

  setOnline(true);
  await settleOutbox();
  const post = fake.calls.find((c) => c.method === 'POST')!;
  expect(post.headers.get('Prefer')).toBe('return=minimal');
  expect(post.headers.get('Idempotency-Key')).toBeNull();
  expect(await screen.findByText(/Saved on server at/)).toBeOnTheScreen();
  const local = await readLocalMarks({ serverId: '500' });
  expect(local.map((m) => [m.enrolmentId, m.state, m.serverMarkId])).toEqual([
    ['e3', 'done', 'm-e3'],
    ['e2', 'done', 'm-e2'],
  ]);
});

test('changed elsewhere: the row is not saved, the grid says so and reloads', async () => {
  await renderSignedIn(<MarksGridScreen id="500" local={false} secure />, mathsTeacher(), {
    'GET /api/v1/assessments/500/marks': () => ({ status: 200, body: GRID }),
    'POST /api/v1/assessments/500/submit-marks': submitRoute((e) =>
      e === 'e1' ? 'changed_elsewhere' : 'created',
    ),
  });
  expect(await screen.findByText('Ali Raza')).toBeOnTheScreen();
  fireEvent.changeText(screen.getByTestId('marks.input.e1'), '3');
  fireEvent.press(screen.getByTestId('marks.save'));
  await settleOutbox();
  expect(await screen.findByTestId('marks.changedElsewhere')).toBeOnTheScreen();
  const [mine] = await readLocalMarks({ serverId: '500' });
  expect(mine).toMatchObject({
    enrolmentId: 'e1',
    state: 'changed_elsewhere',
    serverMarkId: 'm-theirs',
  });
});

// ------------------------------------------------------------- a test made on the phone

test('a test created offline: its key, then the marks typed on it re-targeted to its server id', async () => {
  const { fake } = await renderSignedIn(
    <NewTestScreen sectionId="12" classId="20" />,
    mathsTeacher(),
    {
      'GET /api/v1/classes/20/subjects': () => ({
        status: 200,
        body: {
          data: [
            {
              id: '60',
              classId: '20',
              subjectId: '7',
              subjectName: 'Mathematics',
              subjectCode: null,
              sortOrder: 1,
              examMaxMarks: 100,
            },
            {
              id: '61',
              classId: '20',
              subjectId: '8',
              subjectName: 'English',
              subjectCode: null,
              sortOrder: 2,
              examMaxMarks: 100,
            },
          ],
          page: 1,
          limit: 50,
          total: 2,
        },
      }),
      'POST /api/v1/assessments': () => ({ status: 201, body: { ...ASSESSMENT, id: '900' } }),
      'POST /api/v1/assessments/900/submit-marks': submitRoute(),
    },
  );
  setOnline(false);
  expect(await screen.findByTestId('newTest.subject.60')).toBeOnTheScreen();
  expect(screen.queryByTestId('newTest.subject.61')).toBeNull();
  fireEvent.press(screen.getByTestId('newTest.subject.60'));
  fireEvent.changeText(screen.getByTestId('newTest.name'), 'Decimals quiz');
  fireEvent.changeText(screen.getByTestId('newTest.maxMarks'), '25');
  fireEvent.press(screen.getByTestId('newTest.save'));
  await eventually(() => expect(router.back).toHaveBeenCalled());
  const [test] = await listLocalAssessments('12');
  expect(test).toMatchObject({ name: 'Decimals quiz', maxMarks: 25, state: 'queued' });
  const [created] = await listByState('pending');
  expect(JSON.parse(created!.body)).toEqual({
    classSubjectId: '60',
    sectionId: '12',
    testType: 'weekly',
    name: 'Decimals quiz',
    maxMarks: 25,
    heldOn: TODAY,
  });

  // Marks typed on it wait: no outbox row until the test has its server id.
  await saveMarks({ localId: test!.id }, [
    { enrolmentId: 'e1', obtained: 20, absent: false, basedOnMarkId: null },
  ]);
  expect(await listByState('pending')).toHaveLength(1);
  expect((await readLocalMarks({ localId: test!.id }))[0]).toMatchObject({
    state: 'waiting',
    outbox: null,
  });

  setOnline(true);
  await settleOutbox();
  await settleOutbox();
  const posts = fake.calls.filter((c) => c.method === 'POST');
  expect(posts.map((c) => c.path)).toEqual([
    '/api/v1/assessments',
    '/api/v1/assessments/900/submit-marks',
  ]);
  expect(posts[0]!.headers.get('Idempotency-Key')).toBe(created!.id);
  expect((posts[1]!.body as AssessmentSubmitMarksDto).entries).toEqual([
    expect.objectContaining({ enrolmentId: 'e1', obtained: 20, basedOnMarkId: null }),
  ]);
  expect((await readLocalMarks({ serverId: '900' }))[0]).toMatchObject({
    state: 'done',
    serverMarkId: 'm-e1',
  });
});

test('discarding a refused test takes the marks waiting for it', async () => {
  await renderSignedIn(<></>, mathsTeacher());
  const { localId, outboxId } = await saveLocalAssessment({
    classSubjectId: '60',
    subjectId: '7',
    sectionId: '12',
    testType: 'daily',
    name: 'Spelling',
    maxMarks: 10,
    heldOn: TODAY,
  });
  await saveMarks({ localId }, [
    { enrolmentId: 'e1', obtained: 5, absent: false, basedOnMarkId: null },
  ]);
  await discardItem(outboxId);
  expect(await listLocalAssessments('12')).toEqual([]);
  expect(await readLocalMarks({ localId })).toEqual([]);
});

test('an entry queued behind one being sent is re-based on the mark the first one made', async () => {
  await renderSignedIn(<></>, mathsTeacher());
  await saveMarks({ serverId: '500' }, [
    { enrolmentId: 'e2', obtained: 5, absent: false, basedOnMarkId: null },
  ]);
  const [first] = await listByState('pending');
  await saveItem(transition(first!, { type: 'send', now: new Date() }).item);
  await saveMarks({ serverId: '500' }, [
    { enrolmentId: 'e2', obtained: 6, absent: false, basedOnMarkId: null },
  ]);
  const [second] = await listByState('pending');
  expect(second!.id).not.toBe(first!.id);
  const sent = JSON.parse(first!.body) as AssessmentSubmitMarksDto;
  await markMarksSaved(first!.id, '500', sent, [
    {
      clientEntryKey: sent.entries[0]!.clientEntryKey,
      enrolmentId: 'e2',
      markId: 'm77',
      outcome: 'created',
    },
  ]);
  const rebased = JSON.parse((await findItem(second!.id))!.body) as AssessmentSubmitMarksDto;
  expect(rebased.entries[0]).toMatchObject({
    enrolmentId: 'e2',
    obtained: 6,
    basedOnMarkId: 'm77',
  });
  expect((await readLocalMarks({ serverId: '500' }))[0]).toMatchObject({
    obtained: 6,
    basedOnMarkId: 'm77',
    state: 'queued',
  });
});
