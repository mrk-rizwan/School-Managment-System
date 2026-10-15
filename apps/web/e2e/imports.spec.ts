import { DEFAULT_PASSWORD_INERT_ACTION_NAMES, ErrorCode } from '@asms/shared';
import { expect as baseExpect, test } from '@playwright/test';
import type { TermDto } from '../lib/api/school-academics-contract';
import type { MeDto } from '../lib/api/school-contract';
import type { ImportDetailDto } from '../lib/api/school-imports-contract';
import {
  OFFICE_ME,
  PRINCIPAL_ME,
  STAMP,
  TABLET,
  calls,
  errorBody,
  expectNoSidewaysScroll,
  mockSchoolApi,
  open,
  page1,
} from './support/wave-e';

// Phase 5 slice 43 (contracts/slice-43.md §1, §2): the Imports page. A past-results file is
// uploaded multipart with its section and term and a key; the preview lists every refused row by
// line (never the cell's text) and offers no commit; a clean file shows the marks per subject and
// commits; opening balances show the advance that pays each row. The four states, the office's
// note, rule 24's greyed kind, and a tablet width without sideways scroll.

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

const base = (extra: Partial<ImportDetailDto>): ImportDetailDto => ({
  id: 'i1',
  kind: 'past_results',
  status: 'previewed',
  fileName: 'class5a-mid.csv',
  rowCount: 2,
  academicYearId: 'y1',
  academicYearName: '2026-27',
  classId: 'c5',
  className: 'Class 5',
  sectionId: 'sec-a',
  sectionName: 'A',
  termId: 't1',
  termName: 'Mid-term',
  dueOn: null,
  createdByName: 'Amina Principal',
  createdAt: STAMP,
  expiresAt: '2026-09-21T05:00:00.000Z',
  committedByName: null,
  committedAt: null,
  failedAt: null,
  error: null,
  errorCount: 0,
  errors: [],
  subjects: [
    { classSubjectId: 'cs-m', name: 'Mathematics', maxMarks: 100 },
    { classSubjectId: 'cs-e', name: 'English', maxMarks: 50 },
  ],
  rows: [],
  totalAmount: null,
  totalAdvance: null,
  resultSheetId: null,
  ...extra,
});

const WITH_ERRORS = base({
  errorCount: 3,
  errors: [
    { row: 2, field: 'English', code: 'over_max' },
    { row: 3, field: 'admission_no', code: 'identity_number' },
    { row: 0, field: 'admission_no', code: 'missing_from_file', admissionNo: 'A-104' },
  ],
});

const CLEAN = base({
  id: 'i2',
  rows: [
    { row: 2, studentId: 's1', admissionNo: 'A-101', studentName: 'Zara Khan', marks: [{ classSubjectId: 'cs-m', obtained: 80 }, { classSubjectId: 'cs-e', obtained: null }], amount: null, note: null, advance: null },
    { row: 3, studentId: 's2', admissionNo: 'A-102', studentName: 'Ali Raza', marks: [{ classSubjectId: 'cs-m', obtained: 90 }, { classSubjectId: 'cs-e', obtained: 45 }], amount: null, note: null, advance: null },
  ],
});

const csvFile = (name = 'class5a-mid.csv') => ({ name, mimeType: 'text/csv', buffer: Buffer.from('admission_no,Mathematics,English\nA-101,80,Ab\n') });

test('past results: an upload with errors lists them by line and cannot be committed; a clean one shows the marks and commits', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    replies: {
      'GET /academic-years/y1/terms': { status: 200, body: page1(TERMS) },
      'GET /imports': { status: 200, body: page1([]) },
      'POST /imports/past-results': [
        { status: 201, body: WITH_ERRORS },
        { status: 201, body: CLEAN },
      ],
      'GET /imports/i1': { status: 200, body: WITH_ERRORS },
      'GET /imports/i2': { status: 200, body: CLEAN },
      'POST /imports/i2/commit': { status: 200, body: { ...CLEAN, status: 'committed', committedAt: STAMP, committedByName: 'Amina Principal', resultSheetId: 'rs9' } },
    },
  });
  await open(page, '/imports');
  await expect(page.getByRole('heading', { name: 'Imports' })).toBeVisible();
  await expect(page.getByText('No imports yet')).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Imports' })).toBeVisible();

  const upload = page.getByRole('button', { name: 'Upload and check' });
  await expect(upload).toBeDisabled();
  await page.getByLabel('Section').selectOption('sec-a');
  await page.getByLabel('Term').selectOption('t1');
  await page.getByLabel('CSV file').setInputFiles(csvFile());
  await upload.click();

  const panel = page.getByRole('region', { name: 'Import preview' });
  await expect(panel.getByText('3 problems found')).toBeVisible();
  await expect(panel.getByRole('row', { name: /2 English Above the exam/ })).toBeVisible();
  await expect(panel.getByText('Looks like an identity number, which is not accepted')).toBeVisible();
  await expect(panel.getByText('(admission no. A-104)')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Commit results' })).toHaveCount(0);

  const sent = calls(requests, 'POST', '/imports/past-results')[0]!;
  expect(sent.headers()['content-type']).toContain('multipart/form-data');
  expect(sent.headers()['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  const body = sent.postDataBuffer()?.toString('utf8') ?? '';
  expect(body).toContain('name="sectionId"');
  expect(body).toContain('sec-a');
  expect(body).toContain('name="termId"');
  expect(body).toContain('filename="class5a-mid.csv"');

  await page.getByLabel('CSV file').setInputFiles(csvFile('fixed.csv'));
  await upload.click();
  await expect(panel.getByText('Every row is valid')).toBeVisible();
  await expect(panel.getByRole('columnheader', { name: /English of 50/ })).toBeVisible();
  await expect(panel.getByRole('row', { name: /Zara Khan A-101 80 Ab/ })).toBeVisible();
  // A second upload is a second key.
  const keys = calls(requests, 'POST', '/imports/past-results').map((r) => r.headers()['idempotency-key']);
  expect(new Set(keys).size).toBe(2);

  await panel.getByRole('button', { name: 'Commit results' }).click();
  await expect(panel.getByText(/^Committed \d/)).toBeVisible();
  await expect(panel.getByText('no message was sent', { exact: false })).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Open the result sheet' })).toHaveAttribute('href', '/results/sheets/rs9');
  expect(calls(requests, 'POST', '/imports/i2/commit')[0]?.headers()['idempotency-key']).toBeTruthy();
});

test('opening balances: the due date, the advance that pays each row, a refusal in words; the default password greys the kind', async ({ page }) => {
  const balances = base({
    id: 'i3',
    kind: 'opening_balances',
    classId: null,
    className: null,
    sectionId: null,
    sectionName: null,
    termId: null,
    termName: null,
    dueOn: '2026-10-10',
    subjects: [],
    rows: [
      { row: 2, studentId: 's1', admissionNo: 'A-101', studentName: 'Zara Khan', marks: null, amount: 12500, note: 'Arrears 2025-26', advance: 0 },
      { row: 3, studentId: 's2', admissionNo: 'A-102', studentName: 'Ali Raza', marks: null, amount: 2000, note: null, advance: 1200 },
    ],
    totalAmount: 14500,
    totalAdvance: 1200,
  });
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    replies: {
      'GET /imports': { status: 200, body: page1([balances]) },
      'POST /imports/opening-balances': [
        { status: 409, body: errorBody(ErrorCode.IMPORT_DUPLICATE_FILE, 'This file has already been imported.', { importId: 'i0' }) },
        { status: 201, body: balances },
      ],
      'GET /imports/i3': { status: 200, body: balances },
    },
  });
  await open(page, '/imports');
  await page.getByLabel('What to import').selectOption('opening_balances');
  await page.getByLabel('Due on').fill('2026-10-10');
  await page.getByLabel('CSV file').setInputFiles(csvFile('balances.csv'));
  await page.getByRole('button', { name: 'Upload and check' }).click();
  await expect(page.getByText('This file has already been imported.')).toBeVisible();
  await page.getByRole('button', { name: 'Upload and check' }).click();
  const panel = page.getByRole('region', { name: 'Import preview' });
  await expect(panel.getByText(/Rs 14,500 in all, of which Rs 1,200 is paid at once/)).toBeVisible();
  await expect(panel.getByRole('row', { name: /Ali Raza A-102 Rs 2,000 Rs 1,200/ })).toBeVisible();
  const body = calls(requests, 'POST', '/imports/opening-balances')[1]?.postDataBuffer()?.toString('utf8') ?? '';
  expect(body).toContain('name="dueOn"');
  expect(body).toContain('2026-10-10');
  // The history row opens the same panel.
  await expect(page.getByRole('region', { name: 'Import history' }).getByText('2026-27 · due 10 Oct 2026')).toBeVisible();

  await page.unrouteAll({ behavior: 'wait' });
  const onDefault: MeDto = { ...PRINCIPAL_ME, passwordIsDefault: true, blockedActions: [...DEFAULT_PASSWORD_INERT_ACTION_NAMES] };
  await mockSchoolApi(page, { me: onDefault, replies: { 'GET /imports': { status: 200, body: page1([]) } } });
  await open(page, '/imports');
  await page.getByLabel('What to import').selectOption('opening_balances');
  await page.getByLabel('CSV file').setInputFiles(csvFile('balances.csv'));
  await expect(page.getByText('Change your password first: this is off while you use the default password.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upload and check' })).toBeDisabled();
});

test('the empty, failed and office states; tablet fits', async ({ page }) => {
  await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    replies: {
      'GET /academic-years/y1/terms': { status: 200, body: page1(TERMS) },
      'GET /imports': { status: 200, body: page1([CLEAN]) },
      'GET /imports/i2': { status: 200, body: CLEAN },
    },
  });
  await page.setViewportSize(TABLET);
  await open(page, '/imports');
  await page.getByRole('button', { name: 'View' }).click();
  await expect(page.getByRole('region', { name: 'Import preview' }).getByText('Zara Khan')).toBeVisible();
  await expectNoSidewaysScroll(page);

  await page.unrouteAll({ behavior: 'wait' });
  await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    replies: { 'GET /imports': { status: 500, body: errorBody('INTERNAL_ERROR', 'Something went wrong.') } },
  });
  await open(page, '/imports');
  await expect(page.getByRole('button', { name: /Try again/ })).toBeVisible();

  await page.unrouteAll({ behavior: 'wait' });
  await mockSchoolApi(page, { me: OFFICE_ME, replies: { 'GET /imports': { status: 200, body: page1([]) } } });
  await open(page, '/imports');
  await expect(page.getByText('Only the principal imports results and opening balances.')).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Imports' })).toHaveCount(0);
});
