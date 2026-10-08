import { expect as baseExpect, test } from '@playwright/test';
import type { MeDto } from '../lib/api/school-contract';
import type {
  MyAssessmentMarkDto,
  MyChildResultsDto,
  ResultDto,
  SectionSummaryReportDto,
  SubjectReportDto,
} from '../lib/api/school-my-results-contract';
import type { ResultSheetDto } from '../lib/api/school-results-contract';
import type { TermDto } from '../lib/api/school-academics-contract';
import { calls, expectNoSidewaysScroll, mockSchoolApi, open, page1, PRINCIPAL_ME, STAMP, TABLET } from './support/wave-e';

// Phase 4 slice 33 (contracts/slice-33.md §5): a guardian's child's results (the published terms,
// the report card, class tests), a withheld card with the amount owed, the student's own results
// with no figure while withheld, and Results → Reports (section summary and subject).

const expect = baseExpect.configure({ timeout: 15_000 });

const GUARDIAN_ME: MeDto = {
  ...PRINCIPAL_ME,
  id: 'u-guardian',
  staffId: null,
  fullName: 'Sana Khan',
  roles: ['parent'],
  capabilities: [],
  capabilityScopes: [],
  capacities: ['guardian'],
  children: [{ studentId: 'st1', fullName: 'Zara Khan', relationship: 'mother', status: 'active', current: null }],
};

const STUDENT_ME: MeDto = {
  ...GUARDIAN_ME,
  id: 'u-student',
  fullName: 'Zara Khan',
  roles: ['student'],
  capacities: ['student'],
  children: [],
};

const SUMMARY = {
  id: 'r1',
  academicYearId: 'y1',
  academicYearName: '2026-27',
  termId: 't1',
  termName: 'Mid-term',
  isFinal: false,
  className: 'Six',
  sectionName: 'A',
  percentBp: 7450,
  grade: 'B',
  revised: false,
  publishedAt: STAMP,
};

const LIST: MyChildResultsDto = {
  studentId: 'st1',
  academicYearId: 'y1',
  years: [{ id: 'y1', name: '2026-27' }],
  terms: [SUMMARY],
  final: null,
  withheld: false,
  outstanding: null,
};

const CARD: ResultDto = {
  id: 'r1',
  sheetId: 'sh1',
  sheetVersion: 1,
  schoolName: 'Green Valley School',
  academicYearId: 'y1',
  academicYearName: '2026-27',
  termId: 't1',
  termName: 'Mid-term',
  isFinal: false,
  classId: 'c5',
  className: 'Six',
  sectionId: 'sec-a',
  sectionName: 'A',
  enrolmentId: 'e1',
  studentId: 'st1',
  studentName: 'Zara Khan',
  admissionNo: '1001',
  rollNo: 1,
  totalObtained: 149,
  totalMax: 200,
  percentBp: 7450,
  grade: 'B',
  passed: true,
  failedSubjects: 0,
  position: 1,
  positionOf: 2,
  attendanceBp: 9230,
  remark: 'A steady, careful worker.',
  showPosition: true,
  showAttendance: true,
  showRemark: true,
  revised: false,
  publishedAt: STAMP,
  supersededAt: null,
  subjects: [
    {
      classSubjectId: 'cs1',
      subjectName: 'Mathematics',
      sortOrder: 1,
      testBp: 7500,
      examBp: 8000,
      examObtained: 80,
      examMax: 100,
      examAbsent: false,
      examExcused: false,
      percentBp: 7900,
      obtained: 79,
      max: 100,
      grade: 'B',
      status: 'assessed',
    },
    {
      classSubjectId: 'cs2',
      subjectName: 'English',
      sortOrder: 2,
      testBp: null,
      examBp: 7000,
      examObtained: 70,
      examMax: 100,
      examAbsent: false,
      examExcused: false,
      percentBp: 7000,
      obtained: 70,
      max: 100,
      grade: 'B',
      status: 'assessed',
    },
  ],
};

const TEST_MARK: MyAssessmentMarkDto = {
  markId: 'm1',
  assessmentId: 'a1',
  name: 'Weekly test',
  testType: 'weekly',
  heldOn: '2026-10-01',
  termId: 't1',
  termName: 'Mid-term',
  subjectName: 'Mathematics',
  maxMarks: 20,
  obtained: 15,
  absent: false,
  excused: false,
};

test.describe("a guardian's child's results", () => {
  test('shows the published term, the report card and the class tests', async ({ page }) => {
    await page.setViewportSize(TABLET);
    await mockSchoolApi(page, {
      me: GUARDIAN_ME,
      replies: {
        'GET /me/children/st1/results': { status: 200, body: LIST },
        'GET /me/children/st1/results/r1': { status: 200, body: { withheld: false, outstanding: null, result: CARD } },
        'GET /me/children/st1/assessments': { status: 200, body: page1([TEST_MARK]) },
      },
    });
    await open(page, '/my-children/results');
    await page.getByRole('link', { name: 'Zara Khan' }).click();
    await expect(page.getByTestId('myResults.summary.r1')).toContainText('74.50 %');
    const card = page.getByTestId('reportCard.r1');
    await expect(card).toContainText('Mid-term · 2026-27');
    await expect(card).toContainText('Mathematics');
    await expect(card).toContainText('79 / 100');
    await expect(card.getByTestId('reportCard.percent')).toHaveText('74.50 %');
    await expect(card).toContainText('1 of 2');
    await expect(card).toContainText('92.30 %');
    await expect(card).toContainText('A steady, careful worker.');
    await expect(page.getByTestId('myResults.test.a1')).toContainText('15 / 20');
    await expectNoSidewaysScroll(page);
  });

  test('a withheld card names the amount owed and shows no card', async ({ page }) => {
    const { requests } = await mockSchoolApi(page, {
      me: GUARDIAN_ME,
      replies: {
        'GET /me/children/st1/results': { status: 200, body: { ...LIST, withheld: true, outstanding: 4500 } },
        'GET /me/children/st1/results/r1': { status: 200, body: { withheld: true, outstanding: 4500, result: null } },
        'GET /me/children/st1/assessments': { status: 200, body: page1([]) },
      },
    });
    await open(page, '/my-children/st1/results');
    await expect(page.getByTestId('myResults.withheld')).toContainText('4,500');
    await expect(page.getByTestId('myResults.summary.r1')).toContainText('74.50 %');
    await expect(page.getByTestId('reportCard.r1')).toHaveCount(0);
    await expect(page.getByText('No class test has been marked yet.')).toBeVisible();
    expect(calls(requests, 'GET', '/me/children/st1/results/r1')).toHaveLength(1);
  });

  test('nothing published yet is an empty state', async ({ page }) => {
    await mockSchoolApi(page, {
      me: GUARDIAN_ME,
      replies: {
        'GET /me/children/st1/results': {
          status: 200,
          body: { ...LIST, academicYearId: null, years: [], terms: [] },
        },
        'GET /me/children/st1/assessments': { status: 200, body: page1([]) },
      },
    });
    await open(page, '/my-children/st1/results');
    await expect(page.getByText('No results published yet')).toBeVisible();
  });
});

test.describe("the student's own results", () => {
  test('withheld: no figure and no amount', async ({ page }) => {
    await mockSchoolApi(page, {
      me: STUDENT_ME,
      replies: {
        'GET /me/student/results': {
          status: 200,
          body: { ...LIST, withheld: true, outstanding: null, terms: [{ ...SUMMARY, percentBp: null, grade: null }] },
        },
        'GET /me/student/results/r1': { status: 200, body: { withheld: true, outstanding: null, result: null } },
        'GET /me/student/assessments': { status: 200, body: page1([TEST_MARK]) },
      },
    });
    await open(page, '/my-results');
    await expect(page.getByRole('link', { name: 'My results' })).toBeVisible();
    await expect(page.getByTestId('myResults.withheld')).toBeVisible();
    await expect(page.getByTestId('myResults.withheld')).not.toContainText('Rs');
    // Security L3: the student is not told the card is held for fees.
    await expect(page.getByTestId('myResults.withheld')).toContainText('Report card not available');
    await expect(page.getByTestId('myResults.withheld')).toContainText('Please ask your parent or the school office.');
    await expect(page.getByTestId('myResults.withheld')).not.toContainText(/fee/i);
    await expect(page.getByTestId('myResults.summary.r1')).toContainText('—');
    await expect(page.getByTestId('myResults.test.a1')).toContainText('15 / 20');
  });
});

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

const SHEET: ResultSheetDto = {
  id: 'sh1',
  academicYearId: 'y1',
  termId: 't1',
  termName: 'Mid-term',
  isFinal: false,
  classId: 'c5',
  className: 'Six',
  sectionId: 'sec-a',
  sectionName: 'A',
  version: 1,
  status: 'published',
  submittedAt: STAMP,
  submittedByName: 'Ayesha Class',
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
};

const SECTION_SUMMARY: SectionSummaryReportDto = {
  sheetId: 'sh1',
  status: 'published',
  version: 1,
  academicYearId: 'y1',
  termId: 't1',
  termName: 'Mid-term',
  classId: 'c5',
  className: 'Six',
  sectionId: 'sec-a',
  sectionName: 'A',
  passPercent: 40,
  students: 2,
  assessed: 2,
  passed: 1,
  failed: 1,
  averageBp: 5075,
  grades: [
    { grade: 'B', count: 1 },
    { grade: 'F', count: 1 },
  ],
  subjects: [
    { classSubjectId: 'cs1', subjectName: 'Mathematics', assessed: 2, passed: 2, failed: 0, averageBp: 6450, grades: [{ grade: 'B', count: 2 }] },
  ],
};

const SUBJECT_REPORT: SubjectReportDto = {
  termId: 't1',
  termName: 'Mid-term',
  classId: 'c5',
  className: 'Six',
  classSubjectId: 'cs1',
  subjectName: 'Mathematics',
  assessed: 2,
  averageBp: 6450,
  sections: [
    {
      sectionId: 'sec-a',
      sectionName: 'A',
      published: true,
      students: 2,
      assessed: 2,
      averageBp: 6450,
      top: [{ resultId: 'r1', studentId: 'st1', fullName: 'Zara Khan', percentBp: 7900 }],
      bottom: [{ resultId: 'r2', studentId: 'st2', fullName: 'Ali Raza', percentBp: 5000 }],
    },
  ],
};

test.describe('result reports', () => {
  test('a corrected section lists every published version, the newest first, by its number', async ({ page }) => {
    const { requests } = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      replies: {
        'GET /academic-years/y1/terms': { status: 200, body: page1(TERMS) },
        'GET /result-sheets': { status: 200, body: page1([SHEET, { ...SHEET, id: 'sh2', version: 2 }]) },
        'GET /result-reports/section-summary': { status: 200, body: SECTION_SUMMARY },
      },
    });
    await open(page, '/results/reports');
    await page.getByLabel('Term').selectOption('t1');
    const options = page.getByLabel('Section').locator('option');
    await expect(options).toHaveText(['Choose a section', /version 2$/, /version 1$/]);
    await page.getByLabel('Section').selectOption('sh1');
    await expect(page.getByTestId('resultReports.passed')).toHaveText('1');
    const asked = calls(requests, 'GET', '/result-reports/section-summary').at(-1);
    expect(new URL(asked?.url() ?? 'http://x').searchParams.get('sheetId')).toBe('sh1');
  });

  test('the section summary and the subject report', async ({ page }) => {
    const { requests } = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      replies: {
        'GET /academic-years/y1/terms': { status: 200, body: page1(TERMS) },
        'GET /result-sheets': { status: 200, body: page1([SHEET]) },
        'GET /result-reports/section-summary': { status: 200, body: SECTION_SUMMARY },
        'GET /classes/c5/subjects': {
          status: 200,
          body: page1([{ id: 'cs1', classId: 'c5', subjectId: 'sub-m', subjectName: 'Mathematics', subjectCode: null, sortOrder: 1, examMaxMarks: 100 }]),
        },
        'GET /result-reports/subject': { status: 200, body: SUBJECT_REPORT },
      },
    });
    await open(page, '/results/reports');
    await page.getByLabel('Term').selectOption('t1');
    await page.getByLabel('Section').selectOption('sh1');
    await expect(page.getByTestId('resultReports.passed')).toHaveText('1');
    await expect(page.getByTestId('resultReports.summary')).toContainText('64.50 %');
    const listed = calls(requests, 'GET', '/result-sheets')[0];
    expect(new URL(listed?.url() ?? 'http://x').searchParams.get('status')).toBe('published');

    await page.getByRole('tab', { name: 'Subject' }).click();
    await page.getByLabel('Term').selectOption('t1');
    await page.getByLabel('Class').selectOption('c5');
    await page.getByLabel('Subject').selectOption('cs1');
    await expect(page.getByTestId('resultReports.subject')).toContainText('Zara Khan (79.00 %)');
    await expect(page.getByTestId('resultReports.subject')).toContainText('Ali Raza (50.00 %)');
    await expectNoSidewaysScroll(page);
  });
});
