import { expect as baseExpect, test } from '@playwright/test';
import type { AssessmentDto, AssessmentMarksDto } from '../lib/api/school-assessments-contract';
import type {
  MarkCorrectionDto,
  ResultDto,
  ResultSheetDetailDto,
} from '../lib/api/school-results-contract';
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
} from './support/wave-e';

// Phase 4 slice 32 (contracts/slice-32.md §8): a published sheet prints its report cards (one tab
// per print, the HTML never held by the page); a teacher asks for a correction of a locked mark
// (one key per opened dialog, the published-only refusal explained); the principal approves or
// rejects corrections with a reason.

const expect = baseExpect.configure({ timeout: 15_000 });
const KEY = /^[A-Za-z0-9_-]{16,64}$/;

const previewRow = (enrolmentId: string, resultId: string, fullName: string) => ({
  resultId,
  enrolmentId,
  studentId: `st-${enrolmentId}`,
  fullName,
  admissionNo: `10${enrolmentId}`,
  rollNo: 1,
  totalObtained: 149,
  totalMax: 200,
  percentBp: 7450,
  grade: 'B',
  passed: true,
  failedSubjects: 0,
  position: 1,
  positionOf: 1,
  attendanceBp: 9230,
  remark: null,
  ownChildFlags: [],
  missing: 0,
  subjects: [],
});

const PUBLISHED: ResultSheetDetailDto = {
  id: 'rs1',
  academicYearId: 'y1',
  termId: 't1',
  termName: 'Mid-term',
  isFinal: false,
  classId: 'c5',
  className: 'Class 5',
  sectionId: 'sec-a',
  sectionName: 'A',
  version: 1,
  status: 'published',
  submittedAt: STAMP,
  submittedByName: 'Ayesha Malik',
  submittedByMe: false,
  cover: false,
  decidedAt: STAMP,
  decidedByName: 'Amina Principal',
  selfApproved: false,
  returnReason: null,
  publishedAt: STAMP,
  publishedByName: 'Amina Principal',
  ownChildFlags: [],
  createdAt: STAMP,
  updatedAt: STAMP,
  source: 'stored',
  settings: { testWeight: 20, examWeight: 80, passPercent: 40, passRule: 'all_subjects', snapshot: true },
  subjects: [],
  preview: [previewRow('e1', 'r1', 'Zara Khan')],
  flags: { ownChild: [], cover: false, selfApproved: false, missing: [], missingCount: 0, examsNotSetUp: [] },
  canRemark: false,
  canSubmit: false,
  canDecide: false,
  canPublish: false,
};

test('a published sheet prints every card, and one card, each in a new tab', async ({ page }) => {
  await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: ({ method, path }) =>
      method === 'GET' && path === '/result-sheets/rs1' ? { status: 200, body: PUBLISHED } : undefined,
  });
  await open(page, '/results/sheets/rs1');
  let opened = page.context().waitForEvent('page');
  await page.getByRole('button', { name: 'Print report cards' }).click();
  let tab = await opened;
  await tab.waitForLoadState();
  expect(new URL(tab.url()).pathname).toBe('/api/v1/result-sheets/rs1/print');
  await tab.close();
  opened = page.context().waitForEvent('page');
  await page.getByRole('button', { name: 'Print card' }).click();
  tab = await opened;
  await tab.waitForLoadState();
  expect(new URL(tab.url()).pathname).toBe('/api/v1/results/r1/print');
  await tab.close();
});

const LOCKED: AssessmentDto = {
  id: 'ex1',
  academicYearId: 'y1',
  termId: 't1',
  termName: 'Mid-term',
  classId: 'c5',
  className: 'Class 5',
  sectionId: 'sec-a',
  sectionName: 'A',
  classSubjectId: 'cs-m',
  subjectId: 'sub-m',
  subjectName: 'Mathematics',
  kind: 'exam',
  testType: null,
  name: 'Mid-term exam',
  maxMarks: 100,
  heldOn: TODAY,
  createdByMe: false,
  markedCount: 1,
  canEnterMarks: false,
  lockedAt: null,
  locked: true,
  voidedAt: null,
  voidReason: null,
  createdAt: STAMP,
  updatedAt: STAMP,
};

const LOCKED_GRID: AssessmentMarksDto = {
  assessment: LOCKED,
  rows: [
    {
      enrolmentId: 'e1',
      student: { id: 'st-e1', fullName: 'Zara Khan', admissionNo: '101', rollNo: 1 },
      markId: 'm1',
      obtained: 55,
      absent: false,
      excused: false,
      status: 'live',
      enteredAt: STAMP,
      ownChildOf: null,
      pendingCorrectionId: null,
      pendingCorrectionMine: false,
    },
  ],
};

const correction = (extra: Partial<MarkCorrectionDto> = {}): MarkCorrectionDto => ({
  id: 'mc1',
  status: 'pending',
  assessmentId: 'ex1',
  assessmentName: 'Mid-term exam',
  kind: 'exam',
  subjectName: 'Mathematics',
  heldOn: TODAY,
  classId: 'c5',
  className: 'Class 5',
  sectionId: 'sec-a',
  sectionName: 'A',
  termId: 't1',
  termName: 'Mid-term',
  enrolmentId: 'e1',
  studentId: 'st-e1',
  studentName: 'Zara Khan',
  admissionNo: '101',
  maxMarks: 100,
  from: { obtained: 55, absent: false, excused: false },
  to: { obtained: 95, absent: false, excused: false },
  reason: 'Paper re-totalled',
  requestedByName: 'Bilal Maths',
  requestedByMe: false,
  requestedAt: STAMP,
  decidedByName: null,
  decidedAt: null,
  withdrawn: false,
  ...extra,
});

test('a teacher asks for a correction of a locked mark: refused until published, then sent with the same key', async ({ page }) => {
  const me = {
    ...TEACHER_ME,
    assignments: [assignment({ id: 'ta2', role: 'subject_teacher', subjectId: 'sub-m', subjectName: 'Mathematics' })],
  };
  const { requests } = await mockSchoolApi(page, {
    me,
    handler: ({ method, path }) =>
      method === 'GET' && path === '/assessments/ex1/marks' ? { status: 200, body: LOCKED_GRID } : undefined,
    replies: {
      'POST /marks/m1/correct': [
        {
          status: 409,
          body: errorBody('MARK_CORRECTION_SHEET_NOT_PUBLISHED', 'Not published', { markId: 'm1' }),
        },
        { status: 201, body: correction({ requestedByMe: true }) },
      ],
    },
  });
  await open(page, '/marks/ex1');
  await expect(page.getByTestId('marks-read-only')).toContainText('Locked');
  await page.getByRole('button', { name: 'Request correction' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/Corrected mark/).fill('101');
  await dialog.getByRole('textbox', { name: 'Reason' }).fill('Paper re-totalled');
  await expect(dialog.getByRole('button', { name: 'Send correction' })).toBeDisabled();
  await dialog.getByLabel(/Corrected mark/).fill('95');
  await dialog.getByRole('button', { name: 'Send correction' }).click();
  await expect(page.getByText("The student's result is not published yet")).toBeVisible();
  await dialog.getByRole('button', { name: 'Send correction' }).click();
  await expect(page.getByText('Correction sent.')).toBeVisible();
  const sent = calls(requests, 'POST', '/marks/m1/correct');
  expect(sent).toHaveLength(2);
  expect(sent[0]!.postDataJSON()).toEqual({ obtained: 95, reason: 'Paper re-totalled' });
  expect(sent[0]!.headers()['idempotency-key']).toMatch(KEY);
  expect(sent[1]!.headers()['idempotency-key']).toBe(sent[0]!.headers()['idempotency-key']);
});

test('the principal approves one correction and rejects another with a reason', async ({ page }) => {
  const revised = { id: 'r9', revised: true } as Partial<ResultDto>;
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: ({ method, path, url }) => {
      if (method === 'GET' && path === '/mark-corrections') {
        return url.searchParams.get('status') === 'pending'
          ? { status: 200, body: page1([correction(), correction({ id: 'mc2', studentName: 'Ali Raza' })]) }
          : { status: 200, body: page1([]) };
      }
      return undefined;
    },
    replies: {
      'POST /mark-corrections/mc1/approve': {
        status: 200,
        body: { mark: correction({ status: 'approved', decidedByName: 'Amina Principal' }), revisedResult: revised },
      },
      'POST /mark-corrections/mc2/reject': { status: 200, body: correction({ id: 'mc2', status: 'rejected' }) },
    },
  });
  await open(page, '/results/corrections');
  await expect(page.getByTestId('correction.mc1')).toContainText('Zara Khan');
  await expect(page.getByTestId('correction.mc1')).toContainText('95 / 100');
  await page.getByTestId('correction.mc1').getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText(/revised result is published/)).toBeVisible();
  await page.getByTestId('correction.mc2').getByRole('button', { name: 'Reject' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill('Ask the examiner first');
  await dialog.getByRole('button', { name: 'Reject correction' }).click();
  await expect(page.getByText('Correction rejected.')).toBeVisible();
  expect(calls(requests, 'POST', '/mark-corrections/mc1/approve')).toHaveLength(1);
  expect(calls(requests, 'POST', '/mark-corrections/mc2/reject')[0]!.postDataJSON()).toEqual({
    reason: 'Ask the examiner first',
  });
  await page.getByRole('tab', { name: 'Rejected' }).click();
  await expect(page.getByText('None yet')).toBeVisible();
});

test('the requester withdraws their own waiting correction from the marks grid, with a reason', async ({ page }) => {
  const me = {
    ...TEACHER_ME,
    assignments: [assignment({ id: 'ta2', role: 'subject_teacher', subjectId: 'sub-m', subjectName: 'Mathematics' })],
  };
  const waiting: AssessmentMarksDto = {
    ...LOCKED_GRID,
    rows: [{ ...LOCKED_GRID.rows[0]!, pendingCorrectionId: 'mc1', pendingCorrectionMine: true }],
  };
  const { requests } = await mockSchoolApi(page, {
    me,
    handler: ({ method, path }) =>
      method === 'GET' && path === '/assessments/ex1/marks' ? { status: 200, body: waiting } : undefined,
    replies: {
      'POST /mark-corrections/mc1/withdraw': {
        status: 200,
        body: correction({ status: 'rejected', requestedByMe: true, withdrawn: true, decidedByName: 'Ayesha Malik' }),
      },
    },
  });
  await open(page, '/marks/ex1');
  const row = page.locator('[data-enrolment="e1"]');
  await expect(row).toContainText('Correction waiting');
  // One waiting correction per mark: no second request is offered.
  await expect(row.getByRole('button', { name: 'Request correction' })).toHaveCount(0);
  await row.getByRole('button', { name: 'Withdraw correction' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Reason' }).fill('Checked again: the total was right');
  await dialog.getByRole('button', { name: 'Withdraw correction' }).click();
  await expect(page.getByText('Correction withdrawn.')).toBeVisible();
  expect(calls(requests, 'POST', '/mark-corrections/mc1/withdraw')[0]!.postDataJSON()).toEqual({
    reason: 'Checked again: the total was right',
  });
});

test('a correction asked by someone else shows as waiting, with no withdraw', async ({ page }) => {
  const me = {
    ...TEACHER_ME,
    assignments: [assignment({ id: 'ta2', role: 'subject_teacher', subjectId: 'sub-m', subjectName: 'Mathematics' })],
  };
  const waiting: AssessmentMarksDto = {
    ...LOCKED_GRID,
    rows: [{ ...LOCKED_GRID.rows[0]!, pendingCorrectionId: 'mc1', pendingCorrectionMine: false }],
  };
  await mockSchoolApi(page, {
    me,
    handler: ({ method, path }) =>
      method === 'GET' && path === '/assessments/ex1/marks' ? { status: 200, body: waiting } : undefined,
  });
  await open(page, '/marks/ex1');
  const row = page.locator('[data-enrolment="e1"]');
  await expect(row).toContainText('Correction waiting');
  await expect(row.getByRole('button', { name: 'Withdraw correction' })).toHaveCount(0);
});

test('on Corrections the requester sees Withdraw on their own waiting request; a withdrawn one says so', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: ({ method, path, url }) => {
      if (method === 'GET' && path === '/mark-corrections') {
        return url.searchParams.get('status') === 'pending'
          ? { status: 200, body: page1([correction({ requestedByMe: true, requestedByName: 'Amina Principal' })]) }
          : { status: 200, body: page1([correction({ id: 'mc3', status: 'rejected', withdrawn: true, decidedByName: 'Bilal Maths' })]) };
      }
      return undefined;
    },
    replies: {
      'POST /mark-corrections/mc1/withdraw': { status: 200, body: correction({ status: 'rejected', withdrawn: true }) },
    },
  });
  await open(page, '/results/corrections');
  await page.getByTestId('correction.mc1').getByRole('button', { name: 'Withdraw' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill('Asked by mistake');
  await dialog.getByRole('button', { name: 'Withdraw correction' }).click();
  await expect(page.getByText('Correction withdrawn.')).toBeVisible();
  expect(calls(requests, 'POST', '/mark-corrections/mc1/withdraw')).toHaveLength(1);
  await page.getByRole('tab', { name: 'Rejected' }).click();
  await expect(page.getByTestId('correction.mc3')).toContainText('Withdrawn');
});
