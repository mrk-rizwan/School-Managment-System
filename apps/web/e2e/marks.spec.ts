import { expect as baseExpect, test } from '@playwright/test';
import type {
  AssessmentDto,
  AssessmentMarkRowDto,
  AssessmentMarksDto,
  AssessmentSubmitMarksResultDto,
  MarkEntryBody,
} from '../lib/api/school-assessments-contract';
import type { ClassSubjectDto } from '../lib/api/school-academics-contract';
import {
  PRINCIPAL_ME,
  STAMP,
  TEACHER_ME,
  TODAY,
  assignment,
  calls,
  errorBody,
  mockSchoolApi,
  open,
  page1,
  type Handler,
} from './support/wave-e';

// Phase 4 slice 30 (contracts/slice-30.md §8): the Marks list, "New test" with its
// Idempotency-Key, and the marks grid — keyboard entry, the absent toggle, a save of only the
// changed rows with per-row keys and the mark each was based on, the per-row "changed elsewhere"
// banner, refusals, the read-only grid, and the principal's excusal.

const expect = baseExpect.configure({ timeout: 15_000 });
const KEY = /^[A-Za-z0-9_-]{16,64}$/;

const MATHS_TEACHER_ME = {
  ...TEACHER_ME,
  assignments: [
    assignment({
      id: 'ta2',
      role: 'subject_teacher',
      subjectId: 'sub-m',
      subjectName: 'Mathematics',
    }),
  ],
};

const test1: AssessmentDto = {
  id: 'as1',
  academicYearId: 'y1',
  termId: 't1',
  termName: 'Annual',
  classId: 'c5',
  className: 'Class 5',
  sectionId: 'sec-a',
  sectionName: 'A',
  classSubjectId: 'cs-m',
  subjectId: 'sub-m',
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
  createdAt: STAMP,
  updatedAt: STAMP,
};

const row = (
  enrolmentId: string,
  fullName: string,
  rollNo: number,
  extra: Partial<AssessmentMarkRowDto> = {},
): AssessmentMarkRowDto => ({
  enrolmentId,
  student: { id: `st-${enrolmentId}`, fullName, admissionNo: `10${rollNo}`, rollNo },
  markId: null,
  obtained: null,
  absent: false,
  excused: false,
  status: null,
  enteredAt: null,
  ownChildOf: null,
  pendingCorrectionId: null,
  pendingCorrectionMine: false,
  ...extra,
});

const GRID: AssessmentMarksDto = {
  assessment: test1,
  rows: [
    row('e1', 'Zara Khan', 1, { markId: 'm1', obtained: 15, status: 'live', enteredAt: STAMP }),
    row('e2', 'Ali Raza', 2),
    row('e3', 'Sara Malik', 3, { markId: 'm3', absent: true, status: 'live', enteredAt: STAMP }),
  ],
};

const classSubject = (id: string, subjectId: string, subjectName: string): ClassSubjectDto => ({
  id,
  classId: 'c5',
  subjectId,
  subjectName,
  subjectCode: null,
  sortOrder: 1,
  examMaxMarks: 100,
});

function marksHandler(
  grid: AssessmentMarksDto,
  submit?: (entries: MarkEntryBody[]) => AssessmentSubmitMarksResultDto,
): Handler {
  return ({ method, path, request }) => {
    if (method === 'GET' && path === '/assessments')
      return { status: 200, body: page1([grid.assessment]) };
    if (method === 'GET' && path === `/assessments/${grid.assessment.id}/marks`)
      return { status: 200, body: grid };
    if (method === 'POST' && path === `/assessments/${grid.assessment.id}/submit-marks`) {
      const { entries } = request.postDataJSON() as { entries: MarkEntryBody[] };
      return {
        status: 200,
        body:
          submit?.(entries) ??
          ({
            assessment: grid.assessment,
            entries: entries.map((e) => ({
              clientEntryKey: e.clientEntryKey,
              enrolmentId: e.enrolmentId,
              markId: 'new',
              outcome: 'created',
            })),
          } satisfies AssessmentSubmitMarksResultDto),
      };
    }
    if (method === 'GET' && path === '/classes/c5/subjects') {
      return {
        status: 200,
        body: page1([
          classSubject('cs-m', 'sub-m', 'Mathematics'),
          classSubject('cs-e', 'sub-e', 'English'),
        ]),
      };
    }
    return undefined;
  };
}

test('the list opens the grid; a teacher creates a test with a key, only in a subject they teach', async ({
  page,
}) => {
  const created: AssessmentDto = { ...test1, id: 'as9', name: 'Decimals quiz', markedCount: 0 };
  const { requests } = await mockSchoolApi(page, {
    me: MATHS_TEACHER_ME,
    handler: marksHandler(GRID),
    replies: {
      'POST /assessments': { status: 201, body: created },
      'GET /assessments/as9/marks': { status: 200, body: { assessment: created, rows: GRID.rows } },
    },
  });
  await open(page, '/marks');
  await expect(page.getByRole('link', { name: 'Fractions weekly test' })).toBeVisible();
  await expect(page.getByRole('row', { name: /Fractions weekly test/ })).toContainText(
    'Mathematics',
  );

  await page.getByRole('button', { name: 'New test' }).click();
  const dialog = page.getByRole('dialog', { name: 'New test' });
  await expect(dialog.getByLabel('Subject').locator('option')).toHaveText([
    'Choose…',
    'Mathematics',
  ]);
  await dialog.getByLabel('Subject').selectOption('cs-m');
  await dialog.getByLabel('Name').fill('Decimals quiz');
  await dialog.getByLabel('Maximum marks').fill('25');
  await dialog.getByRole('button', { name: 'Create test' }).click();
  await expect(page).toHaveURL(/\/marks\/as9$/);
  const [post] = calls(requests, 'POST', '/assessments');
  expect(post!.headers()['idempotency-key']).toMatch(KEY);
  expect(post!.postDataJSON()).toEqual({
    sectionId: 'sec-a',
    classSubjectId: 'cs-m',
    testType: 'weekly',
    name: 'Decimals quiz',
    maxMarks: 25,
    heldOn: TODAY,
  });
});

test('the grid saves only changed rows, each with its key and the mark it was based on', async ({
  page,
}) => {
  const { requests } = await mockSchoolApi(page, {
    me: MATHS_TEACHER_ME,
    handler: marksHandler(GRID),
  });
  await open(page, '/marks/as1');
  await expect(page.getByTestId('marks-count')).toHaveText('2 of 3 marked');
  await expect(page.getByRole('button', { name: 'Save marks' })).toBeDisabled();

  // Keyboard: type a mark and Enter moves to the next row.
  await page.getByLabel('Mark of Zara Khan').fill('18');
  await page.getByLabel('Mark of Zara Khan').press('Enter');
  await expect(page.getByLabel('Mark of Ali Raza')).toBeFocused();
  await page.keyboard.type('12');
  await page.getByLabel('Sara Malik absent').uncheck();
  await page.getByLabel('Mark of Sara Malik').fill('9');
  await expect(page.getByTestId('marks-count')).toContainText('3 unsaved');
  await page.getByRole('button', { name: 'Save marks (3)' }).click();
  await expect(page.getByText('3 marks saved.')).toBeVisible();

  const [submit] = calls(requests, 'POST', '/assessments/as1/submit-marks');
  const { entries } = submit!.postDataJSON() as { entries: MarkEntryBody[] };
  expect(
    entries.map((e) => ({
      enrolmentId: e.enrolmentId,
      obtained: e.obtained,
      basedOnMarkId: e.basedOnMarkId,
    })),
  ).toEqual([
    { enrolmentId: 'e1', obtained: 18, basedOnMarkId: 'm1' },
    { enrolmentId: 'e2', obtained: 12, basedOnMarkId: null },
    { enrolmentId: 'e3', obtained: 9, basedOnMarkId: 'm3' },
  ]);
  for (const e of entries) expect(e.clientEntryKey).toMatch(KEY);
  expect(new Set(entries.map((e) => e.clientEntryKey)).size).toBe(3);
});

test('a mark above the maximum is caught before sending; the server’s refusal keeps the keys for a retry', async ({
  page,
}) => {
  const { requests } = await mockSchoolApi(page, {
    me: MATHS_TEACHER_ME,
    handler: marksHandler(GRID),
    replies: {
      'POST /assessments/as1/submit-marks': [
        { status: 409, body: errorBody('ASSESSMENT_LOCKED', 'Locked.', { assessmentId: 'as1' }) },
      ],
    },
  });
  await open(page, '/marks/as1');
  await page.getByLabel('Mark of Ali Raza').fill('25');
  await expect(page.getByText('Enter a whole number from 0 to 20 for Ali Raza.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Save marks/ })).toBeDisabled();
  await page.getByLabel('Mark of Ali Raza').fill('11');
  await page.getByRole('button', { name: 'Save marks (1)' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'locked' })).toHaveText(
    'This test is locked: its result sheet has been submitted.',
  );
  // A retry of the same value carries the same entry key (R262).
  await page.getByRole('button', { name: 'Save marks (1)' }).click();
  const sent = calls(requests, 'POST', '/assessments/as1/submit-marks').map(
    (r) => (r.postDataJSON() as { entries: MarkEntryBody[] }).entries[0]!.clientEntryKey,
  );
  expect(sent).toHaveLength(2);
  expect(sent[0]).toBe(sent[1]);
});

test('a row changed elsewhere is reported by name and not saved', async ({ page }) => {
  await mockSchoolApi(page, {
    me: MATHS_TEACHER_ME,
    handler: marksHandler(GRID, (entries) => ({
      assessment: test1,
      entries: entries.map((e) => ({
        clientEntryKey: e.clientEntryKey,
        enrolmentId: e.enrolmentId,
        markId: e.enrolmentId === 'e1' ? 'm1b' : 'm2',
        outcome: e.enrolmentId === 'e1' ? 'changed_elsewhere' : 'created',
      })),
    })),
  });
  await open(page, '/marks/as1');
  await page.getByLabel('Mark of Zara Khan').fill('3');
  await page.getByLabel('Mark of Ali Raza').fill('4');
  await page.getByRole('button', { name: 'Save marks (2)' }).click();
  await expect(page.getByTestId('marks-conflicts')).toContainText(
    'Someone else saved a mark for Zara Khan',
  );
  await expect(page.getByText('1 mark saved.')).toBeVisible();
});

test('read only: a class teacher reads another teacher’s subject, with no save and no excuse', async ({
  page,
}) => {
  const readOnly = { ...GRID, assessment: { ...test1, canEnterMarks: false, createdByMe: false } };
  await mockSchoolApi(page, { me: TEACHER_ME, handler: marksHandler(readOnly) });
  await open(page, '/marks/as1');
  await expect(page.getByTestId('marks-read-only')).toContainText(
    'you do not teach this subject in this section',
  );
  await expect(page.getByLabel('Mark of Zara Khan')).toBeDisabled();
  await expect(page.getByRole('button', { name: /Save marks/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Excuse' })).toHaveCount(0);
});

test('the principal excuses an absence with a reason', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: marksHandler(GRID),
    replies: { 'POST /marks/m3/excuse': { status: 200, body: { id: 'm4' } } },
  });
  await open(page, '/marks/as1');
  await page
    .getByRole('row', { name: /Sara Malik/ })
    .getByRole('button', { name: 'Excuse' })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/Reason/).fill('Medical certificate');
  await dialog.getByRole('button', { name: 'Excuse absence' }).click();
  await expect(page.getByText('Absence excused.')).toBeVisible();
  expect(
    calls(requests, 'POST', '/marks/m3/excuse').map((r) => r.postDataJSON() as unknown),
  ).toEqual([{ reason: 'Medical certificate' }]);
});
