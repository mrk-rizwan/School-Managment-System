import { expect as baseExpect, test } from '@playwright/test';
import type { ApprovalsDto } from '../lib/api/school-approvals-contract';
import type { TermDto } from '../lib/api/school-academics-contract';
import type { ResultPreviewRowDto, ResultSheetDetailDto } from '../lib/api/school-results-contract';
import {
  PRINCIPAL_ME,
  STAMP,
  TEACHER_ME,
  calls,
  errorBody,
  mockSchoolApi,
  open,
  page1,
  type Handler,
} from './support/wave-e';

// Phase 4 slice 31 (contracts/slice-31.md §9): Results → Sheets. The list, opening a sheet (201
// or the open one), the preview with its gaps, remarks saved by the class teacher (only the
// changed rows; an empty one clears), submit and its MARKS_INCOMPLETE refusal, the principal's
// return with a reason, approve and publish, the own-child flag, and the Approvals section.

const expect = baseExpect.configure({ timeout: 15_000 });

const TERMS: TermDto[] = [
  {
    id: 't1',
    academicYearId: 'y1',
    name: 'Mid-term',
    sortOrder: 1,
    startsOn: '2026-04-01',
    endsOn: '2026-10-06',
    weight: 50,
    createdByUser: false,
    skippedClasses: [],
    createdAt: STAMP,
    updatedAt: STAMP,
  },
];

const subject = (
  classSubjectId: string,
  subjectName: string,
  obtained: number | null,
  grade: string | null,
) => ({
  classSubjectId,
  subjectName,
  testBp: null,
  examBp: obtained === null ? null : obtained * 100,
  examObtained: obtained,
  examMax: 100,
  examAbsent: obtained === null,
  examExcused: false,
  percentBp: obtained === null ? null : obtained * 100,
  obtained,
  max: 100,
  grade,
  status: obtained === null ? ('not_assessed' as const) : ('assessed' as const),
  ownChildOf: null,
});

const row = (
  enrolmentId: string,
  fullName: string,
  extra: Partial<ResultPreviewRowDto> = {},
): ResultPreviewRowDto => ({
  resultId: null,
  enrolmentId,
  studentId: `st-${enrolmentId}`,
  fullName,
  admissionNo: `10${enrolmentId}`,
  rollNo: Number(enrolmentId.replace(/\D/g, '')),
  totalObtained: 149,
  totalMax: 200,
  percentBp: 7450,
  grade: 'B',
  passed: true,
  failedSubjects: 0,
  position: 1,
  positionOf: 2,
  attendanceBp: 9230,
  remark: null,
  ownChildFlags: [],
  missing: 0,
  subjects: [subject('cs-m', 'Mathematics', 79, 'B'), subject('cs-e', 'English', 70, 'B')],
  ...extra,
});

const SHEET: ResultSheetDetailDto = {
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
  status: 'draft',
  submittedAt: null,
  submittedByName: null,
  submittedByMe: false,
  cover: false,
  decidedAt: null,
  decidedByName: null,
  selfApproved: false,
  returnReason: null,
  publishedAt: null,
  publishedByName: null,
  ownChildFlags: [],
  createdAt: STAMP,
  updatedAt: STAMP,
  source: 'preview',
  settings: {
    testWeight: 20,
    examWeight: 80,
    passPercent: 40,
    passRule: 'all_subjects',
    snapshot: false,
  },
  subjects: [
    { classSubjectId: 'cs-m', subjectName: 'Mathematics', sortOrder: 1 },
    { classSubjectId: 'cs-e', subjectName: 'English', sortOrder: 2 },
  ],
  preview: [
    row('e1', 'Zara Khan', { remark: 'A careful worker.' }),
    row('e2', 'Ali Raza', {
      percentBp: 2700,
      grade: 'F',
      passed: false,
      failedSubjects: 1,
      position: 2,
      missing: 1,
    }),
  ],
  flags: {
    cover: false,
    selfApproved: false,
    missing: [{ enrolmentId: 'e2', assessmentId: 'as3' }],
    missingCount: 1,
    examsNotSetUp: [],
  },
  canRemark: true,
  canSubmit: true,
  canDecide: false,
  canPublish: false,
};

const SUBMITTED: ResultSheetDetailDto = {
  ...SHEET,
  status: 'submitted',
  submittedAt: STAMP,
  submittedByName: 'Ayesha Malik',
  canRemark: false,
  canSubmit: false,
  canDecide: true,
  flags: { ...SHEET.flags, missing: [], missingCount: 0 },
  preview: SHEET.preview.map((r) => ({ ...r, missing: 0 })),
};

const handler: Handler = ({ method, path }) => {
  if (method === 'GET' && path === '/academic-years/y1/terms')
    return { status: 200, body: page1(TERMS) };
  if (method === 'GET' && path === '/result-sheets') return { status: 200, body: page1([SHEET]) };
  return undefined;
};

test('the class teacher opens a sheet, sees the gap, saves only changed remarks and is refused while marks are missing', async ({
  page,
}) => {
  const { requests } = await mockSchoolApi(page, {
    me: TEACHER_ME,
    handler: (call) =>
      handler(call) ??
      (call.method === 'GET' && call.path === '/result-sheets/rs1'
        ? { status: 200, body: SHEET }
        : undefined),
    replies: {
      'POST /sections/sec-a/result-sheets': { status: 201, body: SHEET },
      'PATCH /result-sheets/rs1': {
        status: 200,
        body: { ...SHEET, updatedAt: '2026-09-21T05:00:00.000Z' },
      },
      'POST /result-sheets/rs1/submit': {
        status: 409,
        body: errorBody('MARKS_INCOMPLETE', 'Missing.', {
          missing: [{ enrolmentId: 'e2', assessmentId: 'as3' }],
        }),
      },
    },
  });
  await open(page, '/results/sheets');
  await expect(page.getByRole('link', { name: 'Class 5 A' })).toBeVisible();
  await page.getByRole('button', { name: 'Open a sheet' }).click();
  const dialog = page.getByRole('dialog', { name: 'Open a result sheet' });
  await dialog.getByLabel('Section').selectOption('sec-a');
  await dialog.getByLabel('Term').selectOption('t1');
  await dialog.getByRole('button', { name: 'Open sheet' }).click();
  await expect(page).toHaveURL(/\/results\/sheets\/rs1$/);
  expect(calls(requests, 'POST', '/sections/sec-a/result-sheets')[0]!.postDataJSON()).toEqual({
    termId: 't1',
  });

  await expect(page.getByTestId('sheet.status')).toHaveText('Draft');
  await expect(page.getByTestId('sheet.missing')).toContainText('1 mark is missing');
  await expect(page.getByTestId('sheet.row.e1')).toContainText('74.50 %');
  await expect(page.getByTestId('sheet.row.e2')).toContainText('1 missing');
  await expect(page.getByTestId('sheet.row.e2')).toContainText('Fail');

  await page.getByLabel('Remark for Ali Raza').fill('Must revise English.');
  await page.getByLabel('Remark for Zara Khan').fill('');
  await expect(page.getByRole('button', { name: 'Submit for approval' })).toBeDisabled();
  await page.getByRole('button', { name: 'Save remarks (2)' }).click();
  await expect(page.getByText('Remarks saved.')).toBeVisible();
  expect(calls(requests, 'PATCH', '/result-sheets/rs1')[0]!.postDataJSON()).toEqual({
    remarks: [
      { enrolmentId: 'e2', remark: 'Must revise English.' },
      { enrolmentId: 'e1', remark: null },
    ],
  });

  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText(/Some marks are missing \(1\)/)).toBeVisible();
});

test('the final sheet: the class teacher writes remarks; there is no Submit', async ({ page }) => {
  const FINAL: ResultSheetDetailDto = {
    ...SHEET,
    termId: null,
    termName: null,
    canRemark: true,
    canSubmit: false,
  };
  const { requests } = await mockSchoolApi(page, {
    me: TEACHER_ME,
    handler: (call) =>
      handler(call) ??
      (call.method === 'GET' && call.path === '/result-sheets/rs1'
        ? { status: 200, body: FINAL }
        : undefined),
    replies: {
      'PATCH /result-sheets/rs1': {
        status: 200,
        body: { ...FINAL, updatedAt: '2026-09-21T05:00:00.000Z' },
      },
    },
  });
  await open(page, '/results/sheets/rs1');
  await page.getByLabel('Remark for Ali Raza').fill('A good year.');
  await expect(page.getByRole('button', { name: 'Submit for approval' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save remarks (1)' }).click();
  await expect(page.getByText('Remarks saved.')).toBeVisible();
  expect(calls(requests, 'PATCH', '/result-sheets/rs1')[0]!.postDataJSON()).toEqual({
    remarks: [{ enrolmentId: 'e2', remark: 'A good year.' }],
  });
});

test('the principal returns a sheet with a reason; an own-child flag shows', async ({ page }) => {
  const flagged: ResultSheetDetailDto = {
    ...SUBMITTED,
    ownChildFlags: [{ userId: 'u9', role: 'mark_author', userName: 'Kamran Parent' }],
  };
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: (call) =>
      handler(call) ??
      (call.method === 'GET' && call.path === '/result-sheets/rs1'
        ? { status: 200, body: flagged }
        : undefined),
    replies: {
      'POST /result-sheets/rs1/return': {
        status: 200,
        body: {
          ...SHEET,
          status: 'returned',
          returnReason: 'Recheck English',
          decidedByName: 'Amina Principal',
          canSubmit: false,
          updatedAt: '2026-09-22T05:00:00.000Z',
        },
      },
    },
  });
  await open(page, '/results/sheets/rs1');
  await expect(page.getByTestId('sheet.ownChild')).toContainText('Kamran Parent entered marks');
  await page.getByRole('button', { name: 'Return' }).click();
  const dialog = page.getByRole('dialog', { name: 'Return the sheet' });
  await dialog.getByRole('textbox').fill('Recheck English');
  await dialog.getByRole('button', { name: 'Return sheet' }).click();
  await expect(page.getByTestId('sheet.status')).toHaveText('Returned');
  await expect(page.getByText('Returned by Amina Principal')).toBeVisible();
  expect(calls(requests, 'POST', '/result-sheets/rs1/return')[0]!.postDataJSON()).toEqual({
    reason: 'Recheck English',
  });
});

test('an approved sheet waits for publication, then is published', async ({ page }) => {
  const approved: ResultSheetDetailDto = {
    ...SUBMITTED,
    status: 'approved',
    source: 'stored',
    decidedAt: STAMP,
    decidedByName: 'Amina Principal',
    canDecide: true,
    canPublish: true,
    updatedAt: '2026-09-23T05:00:00.000Z',
  };
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler: (call) =>
      handler(call) ??
      (call.method === 'GET' && call.path === '/result-sheets/rs1'
        ? { status: 200, body: SUBMITTED }
        : undefined),
    replies: {
      'POST /result-sheets/rs1/approve': { status: 200, body: approved },
      'POST /result-sheets/rs1/publish': {
        status: 200,
        body: {
          ...approved,
          status: 'published',
          publishedAt: STAMP,
          publishedByName: 'Amina Principal',
          canPublish: false,
          canDecide: false,
          updatedAt: '2026-09-24T05:00:00.000Z',
        },
      },
    },
  });
  await open(page, '/results/sheets/rs1');
  await expect(page.getByTestId('sheet.status')).toHaveText('Waiting for approval');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByTestId('sheet.status')).toHaveText('Approved');
  await expect(page.getByRole('button', { name: 'Approve' })).toBeHidden();
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByTestId('sheet.status')).toHaveText('Published');
  expect(calls(requests, 'POST', '/result-sheets/rs1/approve')).toHaveLength(1);
  expect(calls(requests, 'POST', '/result-sheets/rs1/publish')).toHaveLength(1);
});

test('Approvals shows the result sheets waiting, flagged, linking to the sheet', async ({
  page,
}) => {
  const body: ApprovalsDto = {
    results: {
      count: 1,
      items: [
        {
          ...SUBMITTED,
          ownChildFlags: [{ userId: 'u9', role: 'mark_author', userName: 'Kamran Parent' }],
        },
      ],
    },
  };
  await mockSchoolApi(page, {
    me: { ...PRINCIPAL_ME, roles: ['teacher'] },
    replies: { 'GET /me/approvals': { status: 200, body } },
  });
  await open(page, '/approvals');
  const queue = page.getByTestId('approvals.results');
  await expect(queue.getByTestId('approvals.results.count')).toHaveText('1');
  await expect(queue).toContainText('Class 5 A · Mid-term');
  await expect(queue).toContainText('own child');
  await queue.getByRole('link', { name: /Class 5 A/ }).click();
  await expect(page).toHaveURL(/\/results\/sheets\/rs1$/);
});
