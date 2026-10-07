import { Capability, DEFAULT_GRADE_BANDS, SYSTEM_ROLE_DEFAULTS } from '@asms/shared';
import { expect as baseExpect, test, type Page, type Request } from '@playwright/test';
import type { ApiErrorEnvelope } from '../lib/api/errors';
import type {
  AcademicYearDto,
  ClassDto,
  ClassSubjectDto,
  ResultSettingsDto,
  SubjectDto,
  TermDto,
} from '../lib/api/school-academics-contract';
import type { MeDto } from '../lib/api/school-contract';

// Phase 4 slice 29 screens (contracts/slice-29.md): Academics → Terms and results, and the class
// page's Subjects and promotion link, against a mocked API answered in the browser by page.route.
// Payload types are the generated OpenAPI types (via the contract file).

const expect = baseExpect.configure({ timeout: 15_000 });

const PRINCIPAL_ME: MeDto = {
  id: 'u-principal',
  fullName: 'Amina Principal',
  email: 'amina@example.test',
  hasVerifiedEmail: true,
  passwordIsDefault: false,
  blockedCapabilities: [],
  school: { id: 's1', name: 'Green Valley School', shortCode: 'greenvalley', status: 'active' },
  roles: ['principal'],
  capabilities: Object.values(Capability).sort(),
  capabilityScopes: [],
  sessionExpiresAt: '2026-11-02T05:00:00.000Z',
  capacities: ['staff'],
  assignments: [],
  staffId: null,
  children: [],
};
const TEACHER_ME: MeDto = {
  ...PRINCIPAL_ME,
  id: 'u-teacher',
  fullName: 'Kamran Teacher',
  roles: ['teacher'],
  capabilities: [...SYSTEM_ROLE_DEFAULTS.teacher].sort(),
};

const STAMP = '2026-09-01T05:00:00.000Z';
const YEAR: AcademicYearDto = { id: 'y1', name: '2026-27', startsOn: '2026-04-01', endsOn: '2027-03-31', status: 'active', createdAt: STAMP, updatedAt: STAMP };
const NEXT_YEAR: AcademicYearDto = { ...YEAR, id: 'y2', name: '2027-28', startsOn: '2027-04-01', endsOn: '2028-03-31', status: 'planned' };
const klass = (id: string, name: string, y: AcademicYearDto): ClassDto => ({
  id,
  academicYearId: y.id,
  academicYearName: y.name,
  name,
  sortOrder: 0,
  attendanceMode: 'daily',
  status: 'active',
  nextClassId: null,
  nextClassName: null,
  isFinal: false,
  createdAt: STAMP,
  updatedAt: STAMP,
});
const term = (id: string, name: string, sortOrder: number, startsOn: string, endsOn: string, weight: number): TermDto => ({
  id,
  academicYearId: YEAR.id,
  name,
  sortOrder,
  startsOn,
  endsOn,
  weight,
  createdByUser: false,
  skippedClasses: [],
  createdAt: STAMP,
  updatedAt: STAMP,
});
const SETTINGS: ResultSettingsDto = {
  academicYearId: YEAR.id,
  testWeight: 20,
  examWeight: 80,
  passPercent: 40,
  passRule: 'all_subjects',
  bands: DEFAULT_GRADE_BANDS.map((b) => ({ ...b })),
  showPosition: true,
  showAttendance: true,
  showRemark: true,
  withholdCardForDues: false,
  notifyClassTests: false,
  locked: false,
  updatedAt: STAMP,
};
const subject = (id: string, name: string): SubjectDto => ({ id, name, code: null, archivedAt: null, createdAt: STAMP, updatedAt: STAMP });

type ErrorBody = ApiErrorEnvelope['error'];
const errorBody = (code: ErrorBody['code'], message: string, details: ErrorBody['details'] = null): ApiErrorEnvelope => ({
  error: { code, message, details, requestId: 'req-test' },
});
type Reply = { status: number; body: unknown };
const page1 = <T,>(data: T[]) => ({ data, page: 1, limit: 50, total: data.length });

type MockState = {
  me: MeDto;
  terms?: TermDto[];
  classes?: ClassDto[];
  classSubjects?: ClassSubjectDto[];
  subjects?: SubjectDto[];
  replies?: Record<string, Reply>;
};

async function mockApi(page: Page, state: MockState) {
  const terms = state.terms ?? [
    term('t1', 'Mid-term', 1, '2026-04-01', '2026-09-30', 50),
    term('t2', 'Annual', 2, '2026-10-01', '2027-03-31', 50),
  ];
  let settings = { ...SETTINGS };
  const classes = state.classes ?? [klass('c1', 'Class 5', YEAR), klass('c2', 'Nursery', YEAR), klass('c9', 'Class 6', NEXT_YEAR)];
  let classSubjects = state.classSubjects ?? [];
  const subjects = state.subjects ?? [subject('s1', 'Mathematics'), subject('s2', 'English'), subject('s3', 'Urdu')];
  const requests: Request[] = [];

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    requests.push(request);
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = request.method();
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const body = () => request.postDataJSON() as Record<string, unknown>;
    const canned = state.replies?.[`${method} ${path}`];
    if (canned) return json(canned.status, canned.body);

    if (method === 'GET' && path === '/me') return json(200, state.me);
    if (method === 'GET' && path === '/academic-years') return json(200, page1([NEXT_YEAR, YEAR]));
    if (path === '/academic-years/y1/terms') {
      if (method === 'GET') return json(200, page1(terms));
      const created = { ...term(`t${terms.length + 1}`, '', 0, '', '', 0), ...body(), createdByUser: true } as TermDto;
      terms.push(created);
      return json(201, created);
    }
    const termMatch = path.match(/^\/terms\/([^/]+)(?:\/(skip-class|unskip-class))?$/);
    if (termMatch) {
      const found = terms.find((t) => t.id === termMatch[1])!;
      if (termMatch[2] === 'skip-class') {
        const b = body();
        const c = classes.find((x) => x.id === b.classId)!;
        found.skippedClasses.push({ classId: c.id, className: c.name, reason: String(b.reason), createdAt: STAMP });
      } else if (termMatch[2] === 'unskip-class') {
        found.skippedClasses = found.skippedClasses.filter((s) => s.classId !== body().classId);
      } else {
        Object.assign(found, body());
      }
      return json(200, found);
    }
    if (path === '/academic-years/y1/result-settings') {
      if (method === 'PATCH') settings = { ...settings, ...body() } as ResultSettingsDto;
      return json(200, settings);
    }
    if (method === 'GET' && path === '/classes') {
      const yearId = url.searchParams.get('academicYearId');
      return json(200, page1(classes.filter((c) => !yearId || c.academicYearId === yearId)));
    }
    const classMatch = path.match(/^\/classes\/([^/]+)(?:\/(sections|subjects))?$/);
    if (classMatch) {
      const found = classes.find((c) => c.id === classMatch[1])!;
      if (classMatch[2] === 'sections') return json(200, page1([]));
      if (classMatch[2] === 'subjects') return json(200, page1(classSubjects));
      if (method === 'PATCH') {
        const b = body() as { subjects?: { subjectId: string; sortOrder: number; examMaxMarks: number }[]; nextClassId?: string | null; isFinal?: boolean };
        if (b.subjects) {
          classSubjects = b.subjects.map((s) => ({
            id: `cs-${s.subjectId}`,
            classId: found.id,
            subjectId: s.subjectId,
            subjectName: subjects.find((x) => x.id === s.subjectId)!.name,
            subjectCode: null,
            sortOrder: s.sortOrder,
            examMaxMarks: s.examMaxMarks,
          }));
        }
        if (b.isFinal !== undefined) found.isFinal = b.isFinal;
        if (b.nextClassId !== undefined) {
          found.nextClassId = b.nextClassId;
          found.nextClassName = classes.find((c) => c.id === b.nextClassId)?.name ?? null;
        }
      }
      return json(200, found);
    }
    if (method === 'GET' && path === '/subjects') return json(200, page1(subjects));
    return json(500, errorBody('INTERNAL_ERROR', `Unmocked ${method} ${path}`));
  });
  return requests;
}

const sent = (requests: Request[], method: string, suffix: string) =>
  requests.filter((r) => r.method() === method && new URL(r.url()).pathname.endsWith(suffix)).map((r) => r.postDataJSON() as unknown);

test('terms: the seeded terms, a new term with the default weight, and the weight total', async ({ page }) => {
  const requests = await mockApi(page, { me: PRINCIPAL_ME });
  await page.goto('/academics/terms');
  const table = page.getByRole('table').first();
  await expect(table.getByRole('row', { name: /Mid-term/ })).toBeVisible();
  await expect(table.getByRole('row', { name: /Annual/ })).toContainText('50%');
  await expect(page.getByText('Term weights add up to 100%.')).toBeVisible();

  await page.getByRole('button', { name: 'Add term' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add term' });
  await dialog.getByLabel('Name').fill('Summer test');
  await dialog.getByLabel('Starts on').fill('2026-06-01');
  await dialog.getByLabel('Ends on').fill('2026-06-10');
  await dialog.getByRole('button', { name: 'Add term' }).click();
  await expect(dialog).toBeHidden();
  expect(sent(requests, 'POST', '/academic-years/y1/terms')).toEqual([
    { name: 'Summer test', startsOn: '2026-06-01', endsOn: '2026-06-10' },
  ]);
});

test('terms: editing requires the weight; a cleared weight is refused, not silently kept', async ({ page }) => {
  const requests = await mockApi(page, { me: PRINCIPAL_ME });
  await page.goto('/academics/terms');
  await page.getByRole('button', { name: 'Actions for term Mid-term' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Mid-term' });
  const weight = dialog.getByLabel('Weight in final result (%)');
  await expect(weight).toHaveValue('50');
  await weight.fill('');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog.getByText('Enter a whole percent from 0 to 100.')).toBeVisible();
  expect(sent(requests, 'PATCH', '/terms/t1')).toEqual([]);

  await weight.fill('40');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toBeHidden();
  expect(sent(requests, 'PATCH', '/terms/t1')).toEqual([{ weight: 40 }]);
});

test('terms: an overlap refused by the API lands on the dates', async ({ page }) => {
  await mockApi(page, {
    me: PRINCIPAL_ME,
    replies: {
      'POST /academic-years/y1/terms': { status: 409, body: errorBody('TERM_OVERLAPS', 'This overlaps another term of the year.', { termId: 't1' }) },
    },
  });
  await page.goto('/academics/terms');
  await page.getByRole('button', { name: 'Add term' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add term' });
  await dialog.getByLabel('Name').fill('Extra');
  await dialog.getByLabel('Starts on').fill('2026-09-15');
  await dialog.getByLabel('Ends on').fill('2026-10-15');
  await dialog.getByRole('button', { name: 'Add term' }).click();
  await expect(dialog.getByText('These dates overlap another term of the year.')).toBeVisible();
  await expect(dialog).toBeVisible();
});

test('terms: a term marked not held for a class, then held again', async ({ page }) => {
  const requests = await mockApi(page, { me: PRINCIPAL_ME });
  await page.goto('/academics/terms');
  await page.getByRole('button', { name: 'Actions for term Mid-term' }).click();
  await page.getByRole('menuitem', { name: 'Not held for a class…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mid-term: not held for a class' });
  await dialog.getByLabel('Class').selectOption({ label: 'Nursery' });
  await dialog.getByRole('textbox').fill('Nursery has no mid-term');
  await dialog.getByRole('button', { name: 'Mark not held' }).click();
  await expect(dialog).toBeHidden();
  expect(sent(requests, 'POST', '/terms/t1/skip-class')).toEqual([{ classId: 'c2', reason: 'Nursery has no mid-term' }]);
  const row = page.getByRole('row', { name: /Mid-term/ });
  await expect(row.getByText('Nursery')).toBeVisible();

  await page.getByRole('button', { name: 'Actions for term Mid-term' }).click();
  await page.getByRole('menuitem', { name: 'Held for Nursery again' }).click();
  const hold = page.getByRole('dialog', { name: 'Hold Mid-term for Nursery?' });
  await hold.getByRole('textbox').fill('Held after all');
  await hold.getByRole('button', { name: 'Hold the term' }).click();
  await expect(row.getByText('Every class')).toBeVisible();
});

test('result rules: bands are checked whole before saving; only changed fields are sent', async ({ page }) => {
  const requests = await mockApi(page, { me: PRINCIPAL_ME });
  await page.goto('/academics/terms');
  await expect(page.getByLabel('Grade 1', { exact: true })).toHaveValue('A+');
  // The form is read-only until the session's capabilities are known.
  await expect(page.getByLabel('Class tests (%)')).toBeEnabled();
  await page.getByLabel('Class tests (%)').fill('30');
  await page.getByRole('button', { name: 'Save result rules' }).click();
  await expect(page.getByText('Class tests and the exam must add up to 100%.')).toBeVisible();
  await page.getByLabel('Term exam (%)').fill('70');

  // A band out of order is refused by the shared rule, with no request.
  await page.getByLabel('Minimum % for grade 2').fill('95');
  await page.getByRole('button', { name: 'Save result rules' }).click();
  await expect(page.getByText(/Grade bands: band 2: minimums must be strictly descending/)).toBeVisible();
  expect(sent(requests, 'PATCH', '/result-settings')).toHaveLength(0);

  await page.getByLabel('Minimum % for grade 2').fill('85');
  await page.getByLabel('Withhold the report card until dues are cleared').check();
  await page.getByRole('button', { name: 'Save result rules' }).click();
  await expect(page.getByText('Result rules saved.')).toBeVisible();
  expect(sent(requests, 'PATCH', '/result-settings')).toEqual([
    {
      testWeight: 30,
      examWeight: 70,
      bands: [
        { grade: 'A+', minPercent: 90 },
        { grade: 'A', minPercent: 85 },
        { grade: 'B', minPercent: 70 },
        { grade: 'C', minPercent: 60 },
        { grade: 'D', minPercent: 50 },
        { grade: 'E', minPercent: 40 },
        { grade: 'F', minPercent: 0 },
      ],
      withholdCardForDues: true,
    },
  ]);
});

test('result rules: removing a band alone sends the bands', async ({ page }) => {
  const requests = await mockApi(page, { me: PRINCIPAL_ME });
  await page.goto('/academics/terms');
  await expect(page.getByLabel('Grade 2', { exact: true })).toHaveValue('A');
  await page.getByRole('button', { name: 'Remove grade 2' }).click();
  await page.getByRole('button', { name: 'Save result rules' }).click();
  await expect(page.getByText('Result rules saved.')).toBeVisible();
  expect(sent(requests, 'PATCH', '/result-settings')).toEqual([
    {
      bands: DEFAULT_GRADE_BANDS.filter((_, i) => i !== 1).map(({ grade, minPercent }) => ({ grade, minPercent })),
    },
  ]);
});

test('a teacher reads the terms and rules but cannot change them', async ({ page }) => {
  await mockApi(page, { me: TEACHER_ME });
  await page.goto('/academics/terms');
  await expect(page.getByRole('row', { name: /Mid-term/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add term' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Actions for term Mid-term' })).toHaveCount(0);
  await expect(page.getByLabel('Class tests (%)')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save result rules' })).toHaveCount(0);
});

test('class subjects: set, order and remove with a reason; the final class', async ({ page }) => {
  const requests = await mockApi(page, {
    me: PRINCIPAL_ME,
    classSubjects: [
      { id: 'cs-s3', classId: 'c1', subjectId: 's3', subjectName: 'Urdu', subjectCode: null, sortOrder: 1, examMaxMarks: 100 },
    ],
  });
  await page.goto('/academics/classes/c1');
  const section = page.getByRole('region', { name: 'Subjects' });
  await expect(section.getByRole('row', { name: /Urdu/ })).toBeVisible();

  await section.getByRole('button', { name: 'Edit subjects' }).click();
  const dialog = page.getByRole('dialog', { name: 'Subjects of Class 5' });
  await dialog.getByLabel('Add a subject').selectOption({ label: 'Mathematics' });
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await dialog.getByLabel('Add a subject').selectOption({ label: 'English' });
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await dialog.getByRole('button', { name: 'Move English up' }).click();
  await dialog.getByLabel('Exam out of, Mathematics').fill('75');
  await dialog.getByRole('button', { name: 'Remove Urdu' }).click();
  // Removing a saved subject needs a reason before Save is offered.
  await expect(dialog.getByRole('button', { name: 'Save subjects' })).toBeDisabled();
  await dialog.getByLabel(/Why are Urdu removed/).fill('Urdu moves to the next year');
  await dialog.getByRole('button', { name: 'Save subjects' }).click();
  await expect(dialog).toBeHidden();
  expect(sent(requests, 'PATCH', '/classes/c1')).toEqual([
    {
      subjects: [
        { subjectId: 's2', sortOrder: 1, examMaxMarks: 100 },
        { subjectId: 's1', sortOrder: 2, examMaxMarks: 75 },
      ],
      reason: 'Urdu moves to the next year',
    },
  ]);
  await expect(section.getByRole('row', { name: /English/ })).toBeVisible();

  // The next class is preselected from the following year; marking the class final clears it.
  await section.getByLabel('Next class', { exact: true }).selectOption({ label: 'Class 6' });
  await section.getByRole('button', { name: 'Save promotion' }).click();
  await expect(section.getByText('A student who passes is promoted to Class 6.')).toBeVisible();
  await section.getByLabel(/This is the final class/).check();
  await section.getByRole('button', { name: 'Save promotion' }).click();
  await expect(section.getByText('This is the final class: a student who passes completes school.')).toBeVisible();
  expect(sent(requests, 'PATCH', '/classes/c1').slice(1)).toEqual([
    { nextClassId: 'c9', isFinal: false },
    { nextClassId: null, isFinal: true },
  ]);
});
