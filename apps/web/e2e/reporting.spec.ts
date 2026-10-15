import { expect as baseExpect, test, type Page } from '@playwright/test';
import type { TermDto } from '../lib/api/school-academics-contract';
import type { DiscrepancyDto } from '../lib/api/school-attendance-contract';
import type { MeritListDto } from '../lib/api/school-my-results-contract';
import type { FinancialStatementDto, StatementFiguresDto } from '../lib/api/school-reports-contract';
import type { StaffReportDto } from '../lib/api/school-staff-contract';
import type { StudentProfileDto } from '../lib/api/school-students-contract';
import { PRINCIPAL_ME, STAMP, calls, errorBody, expectNoSidewaysScroll, mockSchoolApi, open, page1, TABLET } from './support/wave-e';

// Phase 5 slice 42 (contracts/slice-42.md §5) against a mocked API: the financial statement tab,
// the class merit list, the staff report, attendance discrepancies, the one-page student profile,
// and the Download CSV links (format=csv, the tab's filters, never page or limit).

const expect = baseExpect.configure({ timeout: 15_000 });

/** The Download CSV link's query, as an object. */
async function csvQuery(page: Page) {
  const link = page.getByRole('link', { name: 'Download CSV' });
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  const url = new URL(href ?? '', 'http://localhost');
  return { path: url.pathname, query: Object.fromEntries(url.searchParams) };
}

const figures = (period: string, extra: Partial<StatementFiguresDto> = {}): StatementFiguresDto => ({
  period,
  from: `${period}-01`,
  to: `${period}-30`,
  receipts: 100_000,
  refundReversals: 0,
  refunds: 2_000,
  netReceipts: 98_000,
  expenses: 20_000,
  shortfallWriteOffs: 500,
  salaries: 60_000,
  advancesPaid: 5_000,
  advanceRecoveries: 1_000,
  staff: 65_000,
  expenditure: 85_500,
  net: 12_500,
  ...extra,
});

const STATEMENT: FinancialStatementDto = {
  basis: 'received',
  from: '2026-04-01',
  to: '2027-03-31',
  months: [
    figures('2026-04'),
    figures('2026-05', { receipts: 40_000, netReceipts: 38_000, net: -47_500 }),
  ],
  total: { ...figures('total'), from: '2026-04-01', to: '2027-03-31', receipts: 140_000, netReceipts: 136_000, net: -35_000 },
};

test.describe('financial statement', () => {
  test('a row per month and the total, the basis used, a negative net shown, and its CSV', async ({ page }) => {
    const { requests } = await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      replies: { 'GET /finance-reports/financial-statement': { status: 200, body: STATEMENT } },
    });
    await open(page, '/reports/financial-statement');
    await expect(page.getByRole('link', { name: 'Financial statement' })).toHaveAttribute('aria-current', 'page');
    const table = page.getByTestId('financial-statement');
    await expect(table.getByRole('row', { name: /Apr 2026/ })).toContainText('Rs 100,000');
    const may = table.getByRole('row', { name: /May 2026/ });
    await expect(may).toContainText('-Rs 47,500');
    await expect(may.getByText('-Rs 47,500')).toHaveClass(/text-destructive/);
    await expect(table.getByRole('row', { name: /Total/ })).toContainText('Rs 140,000');
    await expect(table.getByText('already inside salaries', { exact: true })).toBeVisible();
    await expect(page.getByTestId('statement-basis')).toHaveText('Received');
    await expect(table.getByText('(school default)', { exact: false })).toBeVisible();

    const first = new URL(calls(requests, 'GET', '/finance-reports/financial-statement')[0].url()).searchParams;
    expect(Object.fromEntries(first)).toEqual({ academicYearId: 'y1' });
    expect(await csvQuery(page)).toEqual({
      path: '/api/v1/finance-reports/financial-statement',
      query: { academicYearId: 'y1', format: 'csv' },
    });

    // One window at a time: dates replace the year, and a chosen basis is sent.
    await page.getByLabel('Window').selectOption('range');
    await page.getByLabel('Basis').selectOption('verified');
    await expect
      .poll(() =>
        calls(requests, 'GET', '/finance-reports/financial-statement').some((r) => {
          const q = Object.fromEntries(new URL(r.url()).searchParams);
          return q.from === '2026-01-01' && q.to === '2026-10-06' && q.basis === 'verified' && !('academicYearId' in q);
        }),
      )
      .toBe(true);
    expect((await csvQuery(page)).query).toEqual({ from: '2026-01-01', to: '2026-10-06', basis: 'verified', format: 'csv' });
  });

  test('a failure shows the error state and no download', async ({ page }) => {
    await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      replies: {
        'GET /finance-reports/financial-statement': { status: 409, body: errorBody('CONCURRENT_UPDATE', 'The statement could not be read.') },
      },
    });
    await open(page, '/reports/financial-statement');
    await expect(page.getByText('Something went wrong')).toBeVisible();
    await expect(page.getByText('The statement could not be read.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download CSV' })).toBeDisabled();
  });

  test('fits a tablet without sideways page scroll', async ({ page }) => {
    await page.setViewportSize(TABLET);
    await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      replies: { 'GET /finance-reports/financial-statement': { status: 200, body: STATEMENT } },
    });
    await open(page, '/reports/financial-statement');
    await expect(page.getByTestId('financial-statement')).toBeVisible();
    await expectNoSidewaysScroll(page);
  });
});

test('every finance tab offers its CSV with the tab filters and no paging', async ({ page }) => {
  await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    replies: {
      'GET /finance-reports/defaulters': {
        status: 200,
        body: page1([
          {
            studentId: 'st1',
            studentName: 'Hamza Tariq',
            admissionNo: '1001',
            className: 'Class 5',
            sectionName: 'A',
            outstanding: 6000,
            overdue: 3000,
            oldestDueOn: '2026-09-10',
            openCharges: 2,
            feePayer: null,
            lastPaymentOn: null,
            lastReminderAt: null,
            pendingClaim: false,
          },
        ]),
      },
    },
  });
  await open(page, '/reports/defaulters');
  await expect(page.getByRole('row', { name: /Hamza Tariq/ })).toBeVisible();
  expect(await csvQuery(page)).toEqual({
    path: '/api/v1/finance-reports/defaulters',
    query: { sort: '-outstanding', format: 'csv' },
  });
  await page.getByLabel('Overdue only').check();
  await expect.poll(async () => (await csvQuery(page)).query).toEqual({ sort: '-outstanding', overdueOnly: 'true', format: 'csv' });
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

const MERIT_BASE: Omit<MeritListDto, 'status' | 'data' | 'total' | 'pendingSections' | 'rankingId' | 'computedAt' | 'trigger'> = {
  classId: 'c5',
  className: 'Class 5',
  termId: 't1',
  termName: 'Mid-term',
  page: 1,
  limit: 25,
};

const meritRow = (studentId: string, studentName: string, classPosition: number | null, percentBp: number | null, sectionName = 'A') => ({
  resultId: `r-${studentId}`,
  studentId,
  studentName,
  admissionNo: `10${studentId.slice(-2)}`,
  sectionId: sectionName === 'A' ? 'sec-a' : 'sec-b',
  sectionName,
  classPosition,
  positionOf: classPosition === null ? null : 3,
  percentBp,
  grade: percentBp === null ? null : 'A',
  passed: percentBp === null ? null : true,
});

async function openMeritList(page: Page, body: MeritListDto) {
  const mock = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    replies: {
      'GET /academic-years/y1/terms': { status: 200, body: page1(TERMS) },
      'GET /result-reports/merit-list': { status: 200, body },
    },
  });
  await open(page, '/results/reports');
  await page.getByRole('tab', { name: 'Merit list' }).click();
  await page.getByLabel('Class').selectOption('c5');
  await page.getByLabel('Term').selectOption('t1');
  return mock;
}

test.describe('merit list', () => {
  test('ranked: positions across sections, percentages, the version read, and its CSV', async ({ page }) => {
    const { requests } = await openMeritList(page, {
      ...MERIT_BASE,
      status: 'ranked',
      rankingId: 'rk1',
      computedAt: '2026-10-05T06:00:00.000Z',
      trigger: 'publish',
      pendingSections: [],
      data: [meritRow('st01', 'Hira Khan', 1, 9150, 'B'), meritRow('st02', 'Hamza Tariq', 1, 9150), meritRow('st03', 'Ali Raza', null, null)],
      total: 3,
    });
    const list = page.getByTestId('merit-list');
    await expect(list.getByRole('row', { name: /Hira Khan/ })).toContainText('1 of 3');
    await expect(list.getByRole('row', { name: /Hira Khan/ })).toContainText('91.50 %');
    await expect(list.getByRole('row', { name: /Hamza Tariq/ })).toContainText('1 of 3');
    await expect(list.getByRole('row', { name: /Ali Raza/ })).toContainText('—');
    await expect(list.getByText(/Ranked .*after a section published/)).toBeVisible();
    const sent = Object.fromEntries(new URL(calls(requests, 'GET', '/result-reports/merit-list').at(-1)!.url()).searchParams);
    expect(sent).toEqual({ classId: 'c5', termId: 't1', page: '1', limit: '25' });
    expect(await csvQuery(page)).toEqual({
      path: '/api/v1/result-reports/merit-list',
      query: { classId: 'c5', termId: 't1', format: 'csv' },
    });
  });

  test('pending: names the sections still to publish, and no download', async ({ page }) => {
    await openMeritList(page, {
      ...MERIT_BASE,
      status: 'pending',
      rankingId: null,
      computedAt: null,
      trigger: null,
      pendingSections: [
        { sectionId: 'sec-b', sectionName: 'B' },
        { sectionId: 'sec-c', sectionName: 'C' },
      ],
      data: [],
      total: 0,
    });
    await expect(page.getByText('Ranking pending')).toBeVisible();
    await expect(page.getByText('Waiting for sections B, C to publish.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download CSV' })).toBeDisabled();
  });
});

const STAFF_REPORT: StaffReportDto = {
  from: '2026-01-01',
  to: '2026-10-06',
  page: 1,
  limit: 25,
  total: 2,
  data: [
    {
      staffId: 'sf1',
      fullName: 'Ayesha Malik',
      designation: 'Teacher',
      status: 'active',
      present: 180,
      late: 4,
      absent: 6,
      onLeave: 5,
      attendancePercent: 96.8,
      leaveTakenDays: 5,
      contractStatus: 'live',
      contractType: 'fixed_term',
      contractEndsOn: '2026-11-15',
      contractEndingSoon: true,
    },
    {
      staffId: 'sf2',
      fullName: 'Bilal Ahmed',
      designation: null,
      status: 'active',
      present: 0,
      late: 0,
      absent: 0,
      onLeave: 0,
      attendancePercent: null,
      leaveTakenDays: 0,
      contractStatus: 'expired_not_ended',
      contractType: 'probation',
      contractEndsOn: '2026-09-30',
      contractEndingSoon: false,
    },
  ],
};

test('staff report: the window, the figures, the contract standing and its CSV', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    replies: {
      'GET /staff': { status: 200, body: page1([]) },
      'GET /staff-reports/summary': { status: 200, body: STAFF_REPORT },
    },
  });
  await open(page, '/staff');
  await page.getByRole('link', { name: 'Staff report' }).click();
  await expect(page).toHaveURL(/\/staff\/report$/);
  const ayesha = page.getByRole('row', { name: /Ayesha Malik/ });
  await expect(ayesha).toContainText('96.8%');
  await expect(ayesha).toContainText('Current');
  await expect(ayesha).toContainText('Fixed term');
  await expect(ayesha.getByText('Ending soon')).toBeVisible();
  const bilal = page.getByRole('row', { name: /Bilal Ahmed/ });
  await expect(bilal.getByText('Expired, not ended')).toBeVisible();
  await expect(bilal).toContainText('—');
  const sent = Object.fromEntries(new URL(calls(requests, 'GET', '/staff-reports/summary')[0].url()).searchParams);
  expect(sent).toEqual({ from: '2026-01-01', to: '2026-10-06', page: '1', limit: '25' });

  await page.getByLabel('Search').fill('Ayesha');
  await expect
    .poll(async () => (await csvQuery(page)).query)
    .toEqual({ from: '2026-01-01', to: '2026-10-06', staffName: 'Ayesha', format: 'csv' });
});

const discrepancy = (extra: Partial<DiscrepancyDto>): DiscrepancyDto => ({
  date: '2026-10-05',
  kind: 'mixed_day',
  classId: 'c5',
  className: 'Class 5',
  sectionId: 'sec-a',
  sectionName: 'A',
  studentId: 'st1',
  studentName: 'Hamza Tariq',
  period: null,
  presentPeriods: [1, 2],
  absentPeriods: [3],
  amendments: null,
  ...extra,
});

test('attendance discrepancies: both kinds, the kind filter and its CSV', async ({ page }) => {
  const { requests } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    replies: {
      'GET /attendance-reports/absentees': { status: 200, body: page1([]) },
      'GET /attendance-reports/discrepancies': {
        status: 200,
        body: page1([
          discrepancy({}),
          discrepancy({
            kind: 'amended_register',
            date: '2026-10-02',
            studentId: null,
            studentName: null,
            period: 4,
            presentPeriods: [],
            absentPeriods: [],
            amendments: 3,
          }),
        ]),
      },
    },
  });
  await open(page, '/attendance/reports');
  await page.getByRole('tab', { name: 'Discrepancies' }).click();
  const mixed = page.getByRole('row', { name: /Hamza Tariq/ });
  await expect(mixed).toContainText('Present and absent on one day');
  await expect(mixed).toContainText('1, 2');
  const amended = page.getByRole('row', { name: /Register amended more than once/ });
  await expect(amended).toContainText('Class 5 A');
  await expect(amended).toContainText('3');
  const sent = Object.fromEntries(new URL(calls(requests, 'GET', '/attendance-reports/discrepancies')[0].url()).searchParams);
  expect(sent).toEqual({ from: '2026-09-07', to: '2026-10-06', page: '1', limit: '25' });

  await page.getByLabel('Kind').selectOption('amended_register');
  await expect
    .poll(async () => (await csvQuery(page)).query)
    .toEqual({ from: '2026-09-07', to: '2026-10-06', kind: 'amended_register', format: 'csv' });
});

const PROFILE: StudentProfileDto = {
  studentId: 'st1',
  fullName: 'Hamza Tariq',
  admissionNo: '1001',
  status: 'active',
  admittedOn: '2024-04-01',
  dateOfBirth: '2015-02-03',
  asOf: '2026-10-06',
  current: { academicYearId: 'y1', academicYearName: '2026-27', className: 'Class 5', sectionName: 'A', rollNo: 7 },
  attendance: { dateFrom: '2026-04-01', dateTo: '2026-10-06', countedDays: 100, present: 92, absent: 5, late: 3, onLeave: 0, percentage: 95 },
  latestResult: {
    resultId: 'r1',
    academicYearName: '2026-27',
    className: 'Class 5',
    sectionName: 'A',
    termName: 'Mid-term',
    isFinal: false,
    percentBp: 8250,
    grade: 'A',
    passed: true,
    position: 2,
    positionOf: 30,
    classPosition: 5,
    classPositionOf: 61,
    publishedAt: STAMP,
    revised: true,
  },
  dues: { outstanding: 3000, advance: 0, cleared: false },
  documents: {
    complete: false,
    items: [
      { type: 'b_form', status: 'verified' },
      { type: 'photo', status: 'missing' },
    ],
  },
  transport: { routeName: 'Route 1', stopName: 'Model Town', pickupTime: '07:10', startsOn: '2026-04-01' },
};

test.describe('student profile', () => {
  test('every section, with a print button', async ({ page }) => {
    await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      replies: { 'GET /students/st1/profile': { status: 200, body: PROFILE } },
    });
    await open(page, '/students/st1/profile');
    const profile = page.getByTestId('student-profile');
    await expect(profile.getByRole('heading', { name: 'Hamza Tariq' })).toBeVisible();
    await expect(profile).toContainText('Admission no. 1001 · Class 5 A');
    const attendance = profile.getByRole('region', { name: 'Attendance' });
    await expect(attendance).toContainText('95.0%');
    await expect(attendance).toContainText('1 Apr 2026');
    const result = profile.getByRole('region', { name: 'Latest result' });
    await expect(result).toContainText('82.50 %');
    await expect(result).toContainText('2 of 30');
    await expect(result).toContainText('5 of 61');
    await expect(result.getByText('Revised')).toBeVisible();
    await expect(profile.getByRole('region', { name: 'Dues' })).toContainText('Rs 3,000');
    const documents = profile.getByRole('region', { name: 'Documents' });
    await expect(documents).toContainText('B-Form');
    await expect(documents.getByText('Missing')).toBeVisible();
    await expect(profile.getByRole('region', { name: 'Transport' })).toContainText('Model Town');
    await expect(page.getByRole('button', { name: 'Print' })).toBeVisible();
  });

  test('without the money and document keys the sections are left out; no route says so', async ({ page }) => {
    await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      replies: {
        'GET /students/st1/profile': { status: 200, body: { ...PROFILE, dues: null, documents: null, transport: null, latestResult: null } },
      },
    });
    await open(page, '/students/st1/profile');
    const profile = page.getByTestId('student-profile');
    await expect(profile.getByRole('region', { name: 'Attendance' })).toBeVisible();
    await expect(profile.getByRole('region', { name: 'Dues' })).toHaveCount(0);
    await expect(profile.getByRole('region', { name: 'Documents' })).toHaveCount(0);
    await expect(profile.getByRole('region', { name: 'Transport' })).toContainText('No route.');
    await expect(profile.getByRole('region', { name: 'Latest result' })).toContainText('No published result yet.');
  });

  test('a student outside the caller’s scope is not found', async ({ page }) => {
    await mockSchoolApi(page, {
      me: PRINCIPAL_ME,
      replies: { 'GET /students/st9/profile': { status: 404, body: errorBody('NOT_FOUND', 'Not found.') } },
    });
    await open(page, '/students/st9/profile');
    await expect(page.getByText('Student not found')).toBeVisible();
  });
});
