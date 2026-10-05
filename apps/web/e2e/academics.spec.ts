import { Capability, SYSTEM_ROLE_DEFAULTS } from '@asms/shared';
import { expect as baseExpect, test, type Page, type Request } from '@playwright/test';
import type { ApiErrorEnvelope } from '../lib/api/errors';
import type {
  AcademicYearDto,
  ClassDto,
  SectionDto,
  SubjectDto,
} from '../lib/api/school-academics-contract';
import type { MeDto } from '../lib/api/school-contract';

// Academic structure screens (contracts/slice-3.md §8) against a mocked API: every /api/v1/*
// request is answered in the browser by page.route. Payload and error types are the
// generated OpenAPI types (via the contract files), so the mocks follow the real API.

// `next dev` compiles each route on first visit: assertions wait longer than the 5 s default.
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
const year = (id: string, name: string, status: AcademicYearDto['status']): AcademicYearDto => ({
  id,
  name,
  startsOn: '2026-04-01',
  endsOn: '2027-03-31',
  status,
  createdAt: STAMP,
  updatedAt: STAMP,
});
const klass = (id: string, name: string, y: AcademicYearDto, sortOrder = 0): ClassDto => ({
  id,
  academicYearId: y.id,
  academicYearName: y.name,
  name,
  sortOrder,
  attendanceMode: 'daily',
  status: 'active',
  createdAt: STAMP,
  updatedAt: STAMP,
});
const section = (id: string, classId: string, name: string): SectionDto => ({
  id,
  classId,
  name,
  capacity: 30,
  archivedAt: null,
  createdAt: STAMP,
  updatedAt: STAMP,
});
const subject = (id: string, name: string, code: string | null): SubjectDto => ({
  id,
  name,
  code,
  archivedAt: null,
  createdAt: STAMP,
  updatedAt: STAMP,
});

type ErrorBody = ApiErrorEnvelope['error'];

function errorBody(
  code: ErrorBody['code'],
  message: string,
  details: ErrorBody['details'] = null,
): ApiErrorEnvelope {
  return { error: { code, message, details, requestId: 'req-test' } };
}

type Reply = { status: number; body: unknown };

type MockState = {
  me: MeDto;
  years?: AcademicYearDto[];
  classes?: ClassDto[];
  sections?: SectionDto[];
  subjects?: SubjectDto[];
  /** Answers the matching `METHOD /path` instead of the default behaviour. */
  replies?: Record<string, Reply>;
};

const page1 = <T,>(data: T[]) => ({ data, page: 1, limit: 25, total: data.length });
let nextId = 100;

async function mockAcademicsApi(page: Page, state: MockState) {
  const years = state.years ?? [];
  const classes = state.classes ?? [];
  const sections = state.sections ?? [];
  const subjects = state.subjects ?? [];
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

    if (path === '/academic-years') {
      if (method === 'GET') return json(200, page1(years));
      const created = { ...year(String(nextId++), '', 'planned'), ...body() } as AcademicYearDto;
      years.unshift(created);
      return json(201, created);
    }
    const yearAction = path.match(/^\/academic-years\/([^/]+)\/(activate|close)$/);
    if (yearAction && method === 'POST') {
      const found = years.find((y) => y.id === yearAction[1])!;
      found.status = yearAction[2] === 'activate' ? 'active' : 'closed';
      return json(200, found);
    }

    if (path === '/classes') {
      if (method === 'GET') {
        const yearId = url.searchParams.get('academicYearId');
        return json(200, page1(classes.filter((c) => !yearId || c.academicYearId === yearId)));
      }
      const b = body();
      const y = years.find((x) => x.id === b.academicYearId)!;
      const created = { ...klass(String(nextId++), '', y), ...b } as ClassDto;
      classes.push(created);
      return json(201, created);
    }
    const classMatch = path.match(/^\/classes\/([^/]+)(?:\/(sections|copy-sections))?$/);
    if (classMatch) {
      const found = classes.find((c) => c.id === classMatch[1]);
      if (!found) return json(404, errorBody('NOT_FOUND', 'Not found.'));
      if (!classMatch[2] && method === 'GET') return json(200, found);
      if (classMatch[2] === 'sections' && method === 'GET') {
        return json(200, page1(sections.filter((s) => s.classId === found.id)));
      }
      if (classMatch[2] === 'sections' && method === 'POST') {
        const created = { ...section(String(nextId++), found.id, ''), ...body() } as SectionDto;
        sections.push(created);
        return json(201, created);
      }
    }

    if (path === '/subjects') {
      if (method === 'GET') {
        const all = url.searchParams.get('includeArchived') === 'true';
        return json(200, page1(subjects.filter((s) => all || !s.archivedAt)));
      }
      const created = { ...subject(String(nextId++), '', null), ...body() } as SubjectDto;
      subjects.push(created);
      return json(201, created);
    }
    const subjectArchive = path.match(/^\/subjects\/([^/]+)\/archive$/);
    if (subjectArchive && method === 'POST') {
      const found = subjects.find((s) => s.id === subjectArchive[1])!;
      found.archivedAt = new Date().toISOString();
      return json(200, found);
    }

    return json(500, errorBody('INTERNAL_ERROR', `Unmocked ${method} ${path}`));
  });
  return requests;
}

const posts = (requests: Request[], suffix: string) =>
  requests.filter((r) => r.method() === 'POST' && new URL(r.url()).pathname.endsWith(suffix));

// ---- Academic years ----

test('academic years: create a year, then activate it', async ({ page }) => {
  const requests = await mockAcademicsApi(page, {
    me: PRINCIPAL_ME,
    years: [year('1', '2025-26', 'closed')],
  });

  await page.goto('/academics/years');
  const table = page.getByRole('table');
  await expect(table.getByText('2025-26')).toBeVisible();

  await page.getByRole('button', { name: 'New academic year' }).click();
  const dialog = page.getByRole('dialog', { name: 'New academic year' });
  await dialog.getByLabel('Name').fill('2026-27');
  await dialog.getByLabel('Starts on').fill('2026-04-01');
  await dialog.getByLabel('Ends on').fill('2027-03-31');
  await dialog.getByRole('button', { name: 'Create year' }).click();

  await expect(dialog).toBeHidden();
  expect(posts(requests, '/academic-years')[0].postDataJSON()).toEqual({
    name: '2026-27',
    startsOn: '2026-04-01',
    endsOn: '2027-03-31',
  });
  const row = table.getByRole('row', { name: /2026-27/ });
  await expect(row.getByText('Planned')).toBeVisible();

  await row.getByRole('button', { name: 'Actions for 2026-27' }).click();
  await page.getByRole('menuitem', { name: 'Activate' }).click();
  await expect(row.getByText('Active')).toBeVisible();
  // A closed year offers no actions.
  await expect(page.getByRole('button', { name: 'Actions for 2025-26' })).toHaveCount(0);
});

test('academic years: a refused close is explained inside the dialog', async ({ page }) => {
  await mockAcademicsApi(page, {
    me: PRINCIPAL_ME,
    years: [year('1', '2026-27', 'active')],
    replies: {
      'POST /academic-years/1/close': {
        status: 409,
        body: errorBody('ACADEMIC_YEAR_HAS_ACTIVE_ENROLMENTS', 'The year has active enrolments.'),
      },
    },
  });

  await page.goto('/academics/years');
  await page.getByRole('button', { name: 'Actions for 2026-27' }).click();
  await page.getByRole('menuitem', { name: 'Close year' }).click();
  const dialog = page.getByRole('dialog', { name: 'Close 2026-27?' });
  await expect(dialog.getByText('A closed year cannot be reopened.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close year permanently' }).click();
  await expect(dialog.getByText(/Students are still actively enrolled/)).toBeVisible();
  await expect(dialog).toBeVisible();
});

test('academic years: the end date must follow the start date', async ({ page }) => {
  const requests = await mockAcademicsApi(page, { me: PRINCIPAL_ME });
  await page.goto('/academics/years');
  await expect(page.getByText('No academic years yet')).toBeVisible();
  await page.getByRole('button', { name: 'New academic year' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('2026-27');
  await dialog.getByLabel('Starts on').fill('2026-04-01');
  await dialog.getByLabel('Ends on').fill('2026-03-01');
  await dialog.getByRole('button', { name: 'Create year' }).click();
  await expect(dialog.getByText('End after the start date.')).toBeVisible();
  expect(posts(requests, '/academic-years')).toHaveLength(0);
});

test('a teacher sees the structure but no write controls', async ({ page }) => {
  await mockAcademicsApi(page, {
    me: TEACHER_ME,
    years: [year('1', '2026-27', 'active')],
    subjects: [subject('5', 'Mathematics', 'MATH')],
  });

  await page.goto('/academics/years');
  await expect(page.getByRole('table').getByText('2026-27')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New academic year' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Actions for/ })).toHaveCount(0);

  await page.getByRole('link', { name: 'Subjects' }).click();
  await expect(page.getByRole('table').getByText('Mathematics')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New subject' })).toHaveCount(0);
});

test('a 403 from the API shows the no-permission state', async ({ page }) => {
  await mockAcademicsApi(page, {
    me: TEACHER_ME,
    replies: {
      'GET /subjects': { status: 403, body: errorBody('PERMISSION_DENIED', 'Not allowed.') },
    },
  });
  await page.goto('/academics/subjects');
  await expect(page.getByText('You do not have access')).toBeVisible();
});

// ---- Classes and sections ----

test('classes: the active year is preselected; a new class needs an attendance mode', async ({
  page,
}) => {
  const old = year('1', '2025-26', 'closed');
  const current = year('2', '2026-27', 'active');
  const requests = await mockAcademicsApi(page, {
    me: PRINCIPAL_ME,
    years: [current, old],
    classes: [klass('10', 'Class 1', current, 1), klass('11', 'Old Class', old)],
  });

  await page.goto('/academics/classes');
  await expect(page.getByLabel('Academic year')).toHaveValue('2');
  const table = page.getByRole('table');
  await expect(table.getByRole('link', { name: 'Class 1' })).toBeVisible();
  await expect(table.getByText('Old Class')).toHaveCount(0);

  await page.getByRole('button', { name: 'New class' }).click();
  const dialog = page.getByRole('dialog', { name: 'New class' });
  await dialog.getByLabel('Name').fill('Class 2');
  await dialog.getByLabel('Display order').fill('2');
  await dialog.getByRole('button', { name: 'Create class' }).click();
  await expect(dialog.getByText('Choose how attendance is taken.')).toBeVisible();

  await dialog.getByLabel('Attendance is taken').selectOption('period');
  await dialog.getByRole('button', { name: 'Create class' }).click();
  await expect(dialog).toBeHidden();
  expect(posts(requests, '/classes')[0].postDataJSON()).toEqual({
    academicYearId: '2',
    name: 'Class 2',
    sortOrder: 2,
    attendanceMode: 'period',
  });
  await expect(table.getByRole('link', { name: 'Class 2' })).toBeVisible();
  await expect(table.getByRole('row', { name: /Class 2/ }).getByText('Every period')).toBeVisible();
});

test('classes: copy sections reports what was created and skipped', async ({ page }) => {
  const current = year('2', '2026-27', 'active');
  const requests = await mockAcademicsApi(page, {
    me: PRINCIPAL_ME,
    years: [current],
    classes: [klass('10', 'Class 1', current), klass('11', 'Class 2', current)],
    replies: {
      'POST /classes/11/copy-sections': {
        status: 200,
        body: { created: [section('30', '11', 'B'), section('31', '11', 'C')], skippedNames: ['A'] },
      },
    },
  });

  await page.goto('/academics/classes?year=2');
  await page.getByRole('button', { name: 'Actions for Class 2' }).click();
  await page.getByRole('menuitem', { name: 'Copy sections from…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Copy sections into Class 2' });
  // The target itself is never offered as a source.
  await expect(dialog.getByLabel('Copy from class').getByRole('option', { name: 'Class 2' })).toHaveCount(0);
  await dialog.getByLabel('Copy from class').selectOption('10');
  await dialog.getByRole('button', { name: 'Copy sections' }).click();

  await expect(page.getByText('Created 2 sections: B, C.')).toBeVisible();
  await expect(page.getByText('Skipped, already in Class 2: A.')).toBeVisible();
  expect(posts(requests, '/copy-sections')[0].postDataJSON()).toEqual({ fromClassId: '10' });
});

test('sections: add a section; a taken name is shown on the field', async ({ page }) => {
  const current = year('2', '2026-27', 'active');
  const requests = await mockAcademicsApi(page, {
    me: PRINCIPAL_ME,
    years: [current],
    classes: [klass('10', 'Class 1', current)],
    sections: [section('20', '10', 'A')],
  });

  await page.goto('/academics/classes/10');
  await expect(page.getByRole('heading', { name: 'Class 1' })).toBeVisible();
  const table = page.getByRole('table');
  await expect(table.getByText('A', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Add section' }).click();
  let dialog = page.getByRole('dialog', { name: 'Add section' });
  await dialog.getByLabel('Name').fill('B');
  await dialog.getByLabel('Capacity (optional)').fill('35');
  await dialog.getByRole('button', { name: 'Add section' }).click();
  await expect(dialog).toBeHidden();
  expect(posts(requests, '/classes/10/sections')[0].postDataJSON()).toEqual({ name: 'B', capacity: 35 });
  await expect(table.getByText('B', { exact: true })).toBeVisible();

  await page.route('**/api/v1/classes/10/sections', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify(errorBody('SECTION_NAME_TAKEN', 'This class already has a section A.')),
        })
      : route.fallback(),
  );
  await page.getByRole('button', { name: 'Add section' }).click();
  dialog = page.getByRole('dialog', { name: 'Add section' });
  await dialog.getByLabel('Name').fill('A');
  await dialog.getByRole('button', { name: 'Add section' }).click();
  await expect(dialog.getByText('This class already has a section A.')).toBeVisible();
});

// ---- Subjects ----

test('subjects: add with an upper-cased code, then archive without a reason', async ({ page }) => {
  const requests = await mockAcademicsApi(page, { me: PRINCIPAL_ME, subjects: [] });

  await page.goto('/academics/subjects');
  await expect(page.getByText('No subjects yet')).toBeVisible();
  await page.getByRole('button', { name: 'New subject' }).click();
  const dialog = page.getByRole('dialog', { name: 'New subject' });
  await dialog.getByLabel('Name').fill('Mathematics');
  await dialog.getByLabel('Code (optional)').fill('math-5');
  await dialog.getByRole('button', { name: 'Add subject' }).click();
  await expect(dialog).toBeHidden();
  expect(posts(requests, '/subjects')[0].postDataJSON()).toEqual({ name: 'Mathematics', code: 'MATH-5' });

  const table = page.getByRole('table');
  await expect(table.getByText('MATH-5')).toBeVisible();
  await page.getByRole('button', { name: 'Actions for Mathematics' }).click();
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByText('No subjects yet')).toBeVisible();
  expect(posts(requests, '/archive')[0].postDataJSON()).toEqual({});
});

test('subjects: a 422 from the API lands on its field', async ({ page }) => {
  await mockAcademicsApi(page, {
    me: PRINCIPAL_ME,
    replies: {
      'POST /subjects': {
        status: 422,
        body: errorBody('VALIDATION_FAILED', 'Check the highlighted fields.', {
          fields: [{ path: 'code', code: 'INVALID_VALUE', message: 'Use letters, digits or dashes.' }],
        }),
      },
    },
  });
  await page.goto('/academics/subjects');
  await page.getByRole('button', { name: 'New subject' }).click();
  const dialog = page.getByRole('dialog', { name: 'New subject' });
  await dialog.getByLabel('Name').fill('Urdu');
  await dialog.getByLabel('Code (optional)').fill('URDU');
  await dialog.getByRole('button', { name: 'Add subject' }).click();
  await expect(dialog.getByText('Use letters, digits or dashes.')).toBeVisible();
});
