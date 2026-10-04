import { Capability, SYSTEM_ROLE_DEFAULTS } from '@asms/shared';
import { expect as baseExpect, test, type Page, type Request } from '@playwright/test';
import type { ApiErrorEnvelope } from '../lib/api/errors';
import type { AcademicYearDto, ClassDto, SectionDto } from '../lib/api/school-academics-contract';
import type { MeDto } from '../lib/api/school-contract';
import type {
  GuardianDetailDto,
  GuardianLookupResultDto,
  GuardianStudentDto,
} from '../lib/api/school-guardians-contract';
import type {
  EnrolmentDto,
  GuardianLinkDto,
  StatusChangeDto,
  StudentDetailDto,
  StudentDocumentDto,
} from '../lib/api/school-students-contract';

// Students list, student detail and readmission (contracts/slice-6.md §3–§6, §10) against a
// mocked API: every /api/v1/* request is answered in the browser by page.route.

const expect = baseExpect.configure({ timeout: 15_000 });

const OFFICE_ME: MeDto = {
  id: 'u-office',
  fullName: 'Sana Office',
  email: 'sana@example.test',
  hasVerifiedEmail: true,
  passwordIsDefault: false,
  school: { id: 's1', name: 'Green Valley School', shortCode: 'greenvalley', status: 'active' },
  roles: ['office_staff'],
  capabilities: [...SYSTEM_ROLE_DEFAULTS.office_staff].sort(),
  sessionExpiresAt: '2026-11-02T05:00:00.000Z',
  capacities: ['staff'],
  assignments: [],
  staffId: null,
  children: [],
};
const PRINCIPAL_ME: MeDto = { ...OFFICE_ME, id: 'u-principal', roles: ['principal'], capabilities: Object.values(Capability).sort() };
const TEACHER_ME: MeDto = {
  ...OFFICE_ME,
  id: 'u-teacher',
  roles: ['teacher'],
  capabilities: [...SYSTEM_ROLE_DEFAULTS.teacher].sort(),
};

const STAMP = '2026-09-01T05:00:00.000Z';
const YEAR: AcademicYearDto = {
  id: 'y1',
  name: '2026-27',
  startsOn: '2026-04-01',
  endsOn: '2027-03-31',
  status: 'active',
  createdAt: STAMP,
  updatedAt: STAMP,
};
const klass = (id: string, name: string): ClassDto => ({
  id,
  academicYearId: 'y1',
  academicYearName: '2026-27',
  name,
  sortOrder: 0,
  attendanceMode: 'daily',
  status: 'active',
  createdAt: STAMP,
  updatedAt: STAMP,
});
const section = (id: string, classId: string, name: string): SectionDto => ({
  id,
  classId,
  name,
  capacity: null,
  archivedAt: null,
  createdAt: STAMP,
  updatedAt: STAMP,
});
const CLASSES = [klass('c5', 'Class 5'), klass('c6', 'Class 6')];
const SECTIONS: Record<string, SectionDto[]> = {
  c5: [section('sec-a', 'c5', 'A'), section('sec-b', 'c5', 'B')],
  c6: [section('sec-6a', 'c6', 'A')],
};

const student = (id: string, fullName: string, extra: Partial<StudentDetailDto> = {}): StudentDetailDto => ({
  id,
  admissionNo: '1001',
  fullName,
  gender: 'male',
  dateOfBirth: '2016-05-04',
  hasBForm: true,
  bFormMasked: '35202-*****-3',
  status: 'active',
  admittedOn: '2025-04-01',
  current: {
    enrolmentId: 'e1',
    academicYearId: 'y1',
    academicYearName: '2026-27',
    classId: 'c5',
    className: 'Class 5',
    sectionId: 'sec-a',
    sectionName: 'A',
    rollNo: 7,
  },
  userId: null,
  createdAt: STAMP,
  updatedAt: STAMP,
  notes: null,
  photoDocumentId: null,
  ...extra,
});

const link = (id: string, guardianId: string, name: string, extra: Partial<GuardianLinkDto> = {}): GuardianLinkDto => ({
  id,
  studentId: 'st1',
  guardianId,
  guardianFullName: name,
  relationship: 'father',
  isPrimaryContact: false,
  isFeePayer: false,
  canLogin: false,
  phone: '+923001234567',
  endedAt: null,
  contactCapability: 'whatsapp',
  guardianCnicMasked: '35201-*****-1',
  guardianAddress: null,
  guardianUserId: null,
  ...extra,
});

const ENROLMENT: EnrolmentDto = {
  id: 'e1',
  studentId: 'st1',
  academicYearId: 'y1',
  academicYearName: '2026-27',
  classId: 'c5',
  className: 'Class 5',
  sectionId: 'sec-a',
  sectionName: 'A',
  rollNo: 7,
  status: 'active',
  startedOn: '2025-04-01',
  endedOn: null,
};

type ErrorBody = ApiErrorEnvelope['error'];
const errorBody = (code: ErrorBody['code'], message: string, details: ErrorBody['details'] = null): ApiErrorEnvelope => ({
  error: { code, message, details, requestId: 'req-test' },
});

type Reply = { status: number; body: unknown };
type MockState = {
  me: MeDto;
  students?: StudentDetailDto[];
  links?: GuardianLinkDto[];
  documents?: StudentDocumentDto[];
  statusChanges?: StatusChangeDto[];
  guardianLookup?: GuardianLookupResultDto;
  settings?: { studentLoginEnabled: boolean };
  replies?: Record<string, Reply>;
};

const page1 = <T,>(data: T[]) => ({ data, page: 1, limit: 25, total: data.length });

async function mockApi(page: Page, state: MockState) {
  const students = state.students ?? [student('st1', 'Ali Khan')];
  const links = state.links ?? [];
  const documents = state.documents ?? [];
  const requests: Request[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    requests.push(request);
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const method = request.method();
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const canned = state.replies?.[`${method} ${path}`];
    if (canned) return json(canned.status, canned.body);

    if (method === 'GET' && path === '/me') return json(200, state.me);
    if (method === 'GET' && path === '/school/settings') {
      return json(200, { feeDueDay: 10, studentLoginEnabled: state.settings?.studentLoginEnabled ?? true, updatedAt: STAMP });
    }
    if (method === 'GET' && path === '/academic-years') return json(200, page1([YEAR]));
    if (method === 'GET' && path === '/classes') return json(200, page1(CLASSES));
    const sectionsMatch = path.match(/^\/classes\/([^/]+)\/sections$/);
    if (method === 'GET' && sectionsMatch) return json(200, page1(SECTIONS[sectionsMatch[1]] ?? []));
    if (method === 'GET' && path === '/students') return json(200, page1(students));
    if (method === 'POST' && path === '/students/lookup') return json(200, { data: [], truncated: false });
    if (method === 'POST' && path === '/guardians/lookup') {
      return json(200, state.guardianLookup ?? { data: [], truncated: false });
    }
    if (method === 'POST' && path === '/uploads') {
      return json(201, { id: 'up9', mime: 'image/png', sizeBytes: 2048, expiresAt: STAMP });
    }
    const doc = path.match(/^\/documents\/([^/]+)\/content$/);
    if (method === 'GET' && doc) {
      return route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        headers: { 'Content-Disposition': `attachment; filename="b_form-${doc[1]}.pdf"` },
        body: '%PDF-1.4',
      });
    }
    const linkMatch = path.match(/^\/guardian-links\/([^/]+)(\/end)?$/);
    if (linkMatch) {
      const found = links.find((l) => l.id === linkMatch[1])!;
      if (linkMatch[2]) found.endedAt = STAMP;
      else Object.assign(found, request.postDataJSON());
      return json(200, found);
    }
    const enrolmentMatch = path.match(/^\/enrolments\/([^/]+)(?:\/(change-section|change-class))?$/);
    if (enrolmentMatch && enrolmentMatch[2]) {
      // contracts/slice-10.md §8: close-old/open-new, the old one ending the day before.
      const body = request.postDataJSON() as { sectionId: string; effectiveOn: string };
      const dayBefore = new Date(Date.parse(`${body.effectiveOn}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      return json(200, {
        closed: { ...ENROLMENT, status: 'left', endedOn: dayBefore },
        opened: { ...ENROLMENT, id: 'e2', sectionId: body.sectionId, sectionName: 'B', rollNo: null, startedOn: body.effectiveOn },
      });
    }
    if (enrolmentMatch) return json(200, { ...ENROLMENT, ...(request.postDataJSON() as object) });

    const match = path.match(/^\/students\/([^/]+)(?:\/([a-z-]+))?$/);
    if (match) {
      const found = students.find((s) => s.id === match[1]);
      if (!found) return json(404, errorBody('NOT_FOUND', 'Not found.'));
      const sub = match[2];
      if (!sub && method === 'GET') return json(200, found);
      if (!sub && method === 'PATCH') {
        Object.assign(found, request.postDataJSON(), { updatedAt: new Date().toISOString() });
        return json(200, found);
      }
      if (sub === 'change-status') {
        const body = request.postDataJSON() as { status: StudentDetailDto['status'] };
        Object.assign(found, { status: body.status, updatedAt: new Date().toISOString() });
        return json(200, found);
      }
      if (sub === 'readmit') {
        Object.assign(found, { status: 'active', updatedAt: new Date().toISOString() });
        return json(200, found);
      }
      if (sub === 'guardian-links' && method === 'GET') return json(200, page1(links));
      if (sub === 'guardian-links' && method === 'POST') {
        const body = request.postDataJSON() as Partial<GuardianLinkDto>;
        const created = link('l-new', body.guardianId!, 'Bilal Khan', body);
        links.push(created);
        return json(201, created);
      }
      if (sub === 'enrolments') return json(200, page1([ENROLMENT]));
      if (sub === 'status-changes') return json(200, page1(state.statusChanges ?? []));
      if (sub === 'documents' && method === 'GET') return json(200, page1(documents));
      if (sub === 'documents' && method === 'POST') {
        const body = request.postDataJSON() as { type: StudentDocumentDto['type'] };
        const created: StudentDocumentDto = {
          id: 'd-new',
          studentId: found.id,
          type: body.type,
          mime: 'image/png',
          sizeBytes: 2048,
          uploadedBy: 'u-office',
          uploadedByName: 'Sana Office',
          createdAt: STAMP,
        };
        documents.push(created);
        return json(201, created);
      }
      if (sub === 'issue-login') return json(201, { id: 'u-st' });
    }
    if (method === 'GET' && path === '/guardians/g1') {
      const guardianRow: GuardianDetailDto = {
        id: 'g1',
        fullName: 'Ahmed Khan',
        cnicMasked: '35201-*****-1',
        hasCnic: true,
        phone: '+923001234567',
        hasPhone: true,
        contactCapability: 'whatsapp',
        status: 'active',
        mergedIntoId: null,
        userId: null,
        createdAt: STAMP,
        updatedAt: STAMP,
        email: null,
        address: null,
      };
      return json(200, guardianRow);
    }
    if (method === 'GET' && path === '/guardians/g1/students') {
      const row: GuardianStudentDto = {
        linkId: 'l1',
        studentId: 'st1',
        studentFullName: 'Ali Khan',
        admissionNo: '1001',
        className: 'Class 5',
        sectionName: 'A',
        relationship: 'father',
        isPrimaryContact: true,
        isFeePayer: true,
        canLogin: false,
        linkEndedAt: null,
      };
      return json(200, page1([row]));
    }
    return json(500, errorBody('INTERNAL_ERROR', `Unmocked ${method} ${path}`));
  });
  return requests;
}

const calls = (requests: Request[], method: string, path: string) =>
  requests.filter((r) => r.method() === method && new URL(r.url()).pathname === `/api/v1${path}`);

// ---- List ----

test('list: active students by default; a B-Form typed in search goes to the lookup, never the list', async ({
  page,
}) => {
  const requests = await mockApi(page, { me: OFFICE_ME });
  await page.goto('/students');
  const row = page.getByRole('row', { name: /Ali Khan/ });
  await expect(row.getByRole('link', { name: 'Ali Khan' })).toHaveAttribute('href', '/students/st1');
  await expect(row.getByText('Class 5 A')).toBeVisible();
  await expect(page.getByRole('link', { name: 'New admission' })).toHaveAttribute('href', '/admissions/new');
  expect(new URL(calls(requests, 'GET', '/students')[0].url()).searchParams.get('status')).toBe('active');

  await page.getByLabel('Academic year').selectOption('y1');
  await page.getByLabel('Class').selectOption('c5');
  await expect
    .poll(() => calls(requests, 'GET', '/students').map((r) => new URL(r.url()).searchParams.get('classId')))
    .toContain('c5');

  await page.getByLabel('Search').fill('35202-1234567-3');
  await page.getByRole('button', { name: 'Use Find by B-Form' }).click();
  const dialog = page.getByRole('dialog', { name: 'Find by B-Form' });
  await expect(dialog.getByLabel('B-Form number')).toHaveValue('35202-1234567-3');
  await dialog.getByRole('button', { name: 'Search' }).click();
  await expect(dialog.getByText('No student has this B-Form number.')).toBeVisible();
  expect(calls(requests, 'POST', '/students/lookup')[0].postDataJSON()).toEqual({ bForm: '3520212345673' });
  for (const r of calls(requests, 'GET', '/students')) {
    expect(new URL(r.url()).searchParams.get('q') ?? '').not.toMatch(/\d{5}/);
  }
});

test('a teacher sees a read-only list and record: no admission, no edits, no documents', async ({ page }) => {
  await mockApi(page, { me: TEACHER_ME, links: [link('l1', 'g1', 'Ahmed Khan', { isPrimaryContact: true })] });
  await page.goto('/students');
  await expect(page.getByRole('link', { name: 'Ali Khan' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'New admission' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Find by B-Form' })).toHaveCount(0);

  await page.getByRole('link', { name: 'Ali Khan' }).click();
  await expect(page.getByRole('heading', { name: 'Ali Khan' })).toBeVisible();
  await expect(page.getByLabel('Full name')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Change status' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Documents' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Guardians' }).click();
  await expect(page.getByText('Ahmed Khan')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ahmed Khan' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Link a guardian' })).toHaveCount(0);
});

test('list refusal: a user without student.view gets the no-permission state', async ({ page }) => {
  await mockApi(page, {
    me: { ...OFFICE_ME, capabilities: [] },
    replies: { 'GET /students': { status: 403, body: errorBody('PERMISSION_DENIED', 'Not allowed.') } },
  });
  await page.goto('/students');
  await expect(page.getByText('You do not have access')).toBeVisible();
});

test('detail refusal: a student outside scope is "not found"', async ({ page }) => {
  await mockApi(page, { me: TEACHER_ME });
  await page.goto('/students/st-other');
  await expect(page.getByText('Student not found')).toBeVisible();
});

// ---- Details and status ----

test('details: only changes are sent; a B-Form already on record links to that student', async ({ page }) => {
  const requests = await mockApi(page, {
    me: OFFICE_ME,
    replies: {},
  });
  await page.goto('/students/st1');
  await page.getByLabel('Full name').fill('Ali Raza Khan');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Student saved.')).toBeVisible();
  expect(calls(requests, 'PATCH', '/students/st1')[0].postDataJSON()).toEqual({ fullName: 'Ali Raza Khan' });

  await page.unrouteAll({ behavior: 'wait' });
  await mockApi(page, {
    me: OFFICE_ME,
    students: [student('st1', 'Ali Raza Khan')],
    replies: {
      'PATCH /students/st1': {
        status: 409,
        body: errorBody('STUDENT_BFORM_EXISTS', 'Another student has this B-Form number.', { studentId: 'st2' }),
      },
    },
  });
  await page.getByLabel('Replace B-Form (optional)').fill('3520299999993');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Another student has this B-Form number.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open existing student' })).toHaveAttribute('href', '/students/st2');
});

test('status: withdraw through the reason dialog; readmission is then offered', async ({ page }) => {
  const requests = await mockApi(page, { me: OFFICE_ME });
  await page.goto('/students/st1');
  await page.getByRole('button', { name: 'Change status' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change status: Ali Khan' });
  await expect(dialog.getByLabel('New status').locator('option')).toHaveText(['Choose…', 'Suspended', 'Withdrawn', 'Transferred']);
  await dialog.getByLabel('New status').selectOption('withdrawn');
  await dialog.getByLabel('Effective from').fill('2026-09-15');
  await dialog.getByLabel('Reason').fill('Family moved to Karachi');
  await dialog.getByRole('button', { name: 'Change status' }).click();
  await expect(dialog).toBeHidden();
  expect(calls(requests, 'POST', '/students/st1/change-status')[0].postDataJSON()).toEqual({
    status: 'withdrawn',
    reason: 'Family moved to Karachi',
    effectiveOn: '2026-09-15',
  });
  await expect(page.getByRole('link', { name: 'Readmit' })).toHaveAttribute('href', '/students/st1/readmit');
});

test('status refusal: an illegal transition is shown in the dialog', async ({ page }) => {
  await mockApi(page, {
    me: OFFICE_ME,
    replies: {
      'POST /students/st1/change-status': {
        status: 409,
        body: errorBody('ILLEGAL_STATUS_TRANSITION', 'This status change is not allowed.', { from: 'active', to: 'suspended', hint: null }),
      },
    },
  });
  await page.goto('/students/st1');
  await page.getByRole('button', { name: 'Change status' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('New status').selectOption('suspended');
  await dialog.getByLabel('Reason').fill('Repeated absence');
  await dialog.getByRole('button', { name: 'Change status' }).click();
  await expect(dialog.getByText('This status change is not allowed.')).toBeVisible();
});

test('status history: the admission row has no reason (null) and later changes show theirs', async ({ page }) => {
  const row = (extra: Partial<StatusChangeDto>): StatusChangeDto => ({
    id: 'sc1',
    fromStatus: null,
    toStatus: 'active',
    reason: null,
    effectiveOn: '2026-04-01',
    changedBy: 'u-office',
    changedByName: 'Sana Office',
    createdAt: '2026-04-01T05:00:00.000Z',
    ...extra,
  });
  await mockApi(page, {
    me: OFFICE_ME,
    statusChanges: [
      row({ id: 'sc2', fromStatus: 'active', toStatus: 'suspended', reason: 'Fighting', effectiveOn: '2026-09-02' }),
      row({}),
    ],
  });
  await page.goto('/students/st1');
  await page.getByRole('tab', { name: 'Status history' }).click();
  const rows = page.getByRole('row');
  await expect(rows.filter({ hasText: 'Active → Suspended' })).toContainText('Fighting');
  await expect(rows.filter({ hasText: 'Admitted (active)' })).toContainText('—');
});

test('issue student login: a refusal (setting off) is shown; a principal sees the setting itself', async ({ page }) => {
  await mockApi(page, {
    me: OFFICE_ME,
    replies: {
      'POST /students/st1/issue-login': {
        status: 409,
        body: errorBody('STUDENT_LOGIN_DISABLED', 'Student logins are turned off for this school.'),
      },
    },
  });
  await page.goto('/students/st1');
  await page.getByRole('button', { name: 'Issue login' }).click();
  const dialog = page.getByRole('dialog', { name: 'Issue a login to Ali Khan?' });
  // R57: an optional reason, sent as typed.
  await dialog.getByLabel('Reason (optional)').fill('Asked by the class teacher');
  const posted = page.waitForRequest(
    (r) => r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/students/st1/issue-login'),
  );
  await dialog.getByRole('button', { name: 'Issue login' }).click();
  expect((await posted).postDataJSON()).toEqual({ reason: 'Asked by the class teacher' });
  await expect(dialog.getByText('Student logins are turned off for this school.')).toBeVisible();

  await page.unrouteAll({ behavior: 'wait' });
  await mockApi(page, { me: PRINCIPAL_ME, settings: { studentLoginEnabled: false } });
  await page.goto('/students/st1');
  await expect(page.getByText('Student logins are turned off in the school settings.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Issue login' })).toHaveCount(0);
});

// ---- Guardian links ----

test('guardian links: link one through the finder; the primary contact cannot be ended; a refusal is shown', async ({
  page,
}) => {
  const requests = await mockApi(page, {
    me: OFFICE_ME,
    links: [link('l1', 'g1', 'Ahmed Khan', { isPrimaryContact: true, isFeePayer: true })],
    guardianLookup: {
      data: [{ guardian: guardianDto('g2', 'Bilal Khan'), resolvedFromId: null, students: [] }],
      truncated: false,
    },
    replies: {
      'PATCH /guardian-links/l-new': {
        status: 409,
        body: errorBody('PRIMARY_CONTACT_NEEDS_PHONE', 'The primary contact must have a phone number.'),
      },
    },
  });
  await page.goto('/students/st1');
  await page.getByRole('tab', { name: 'Guardians' }).click();
  await expect(page.getByRole('link', { name: 'Ahmed Khan' })).toHaveAttribute('href', '/guardians/g1');

  // The primary contact: ending is blocked before the API has to refuse (R28).
  await page.getByRole('button', { name: 'Actions for Ahmed Khan' }).click();
  await page.getByRole('menuitem', { name: 'End link' }).click();
  const endDialog = page.getByRole('dialog', { name: 'End link: Ahmed Khan' });
  await expect(endDialog.getByText('This guardian is the primary contact.', { exact: false })).toBeVisible();
  await endDialog.getByLabel('Reason').fill('Moved abroad');
  await expect(endDialog.getByRole('button', { name: 'End link' })).toBeDisabled();
  await endDialog.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'Link a guardian' }).click();
  const addDialog = page.getByRole('dialog', { name: 'Link a guardian to Ali Khan' });
  await addDialog.getByLabel('Guardian’s CNIC').fill('35201-7654321-1');
  await addDialog.getByRole('button', { name: 'Search by CNIC' }).click();
  await addDialog.getByRole('button', { name: 'Link Bilal Khan' }).click();
  await addDialog.getByLabel('Relationship').selectOption('guardian');
  await addDialog.getByLabel('May log in').check();
  await addDialog.getByRole('button', { name: 'Link guardian' }).click();
  await expect(addDialog).toBeHidden();
  expect(calls(requests, 'POST', '/students/st1/guardian-links')[0].postDataJSON()).toEqual({
    guardianId: 'g2',
    relationship: 'guardian',
    isPrimaryContact: false,
    isFeePayer: false,
    canLogin: true,
  });

  await page.getByRole('button', { name: 'Actions for Bilal Khan' }).click();
  await page.getByRole('menuitem', { name: 'Edit link' }).click();
  const editDialog = page.getByRole('dialog', { name: 'Edit link: Bilal Khan' });
  await editDialog.getByLabel('Primary contact').check();
  await editDialog.getByRole('button', { name: 'Save' }).click();
  await expect(editDialog.getByText('The primary contact must have a phone number.', { exact: false })).toBeVisible();
  expect(calls(requests, 'PATCH', '/guardian-links/l-new')[0].postDataJSON()).toEqual({ isPrimaryContact: true });
});

function guardianDto(id: string, fullName: string) {
  return {
    id,
    fullName,
    cnicMasked: '35201-*****-1',
    hasCnic: true,
    phone: '+923007654321',
    hasPhone: true,
    contactCapability: 'whatsapp' as const,
    status: 'active' as const,
    mergedIntoId: null,
    userId: null,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

// ---- Enrolment ----

test('enrolment: change section closes and reopens with a reason; a taken roll number is refused', async ({ page }) => {
  const requests = await mockApi(page, {
    me: OFFICE_ME,
    replies: {
      'PATCH /enrolments/e1': { status: 409, body: errorBody('ROLL_NO_TAKEN', 'Roll number 3 is already used in this section.') },
    },
  });
  await page.goto('/students/st1');
  await page.getByRole('tab', { name: 'Enrolment history' }).click();
  await page.getByRole('button', { name: 'Actions for Class 5 A' }).click();
  await page.getByRole('menuitem', { name: 'Change section' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change section' });
  await expect(dialog.getByLabel('New section').locator('option')).toHaveText(['Choose…', 'B']);
  await dialog.getByLabel('New section').selectOption('sec-b');
  await dialog.getByLabel('Effective from').fill('2026-09-15');
  await expect(dialog).toContainText('Closes the current enrolment on 14 Sept 2026 and opens a new one from 15 Sept 2026.');
  // A reason is required now (slice-10 §8.2).
  await expect(dialog.getByRole('button', { name: 'Change section' })).toBeDisabled();
  await dialog.getByLabel('Reason').fill('Parent request');
  await dialog.getByRole('button', { name: 'Change section' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Now in Class 5 B from 15 Sept 2026. Class 5 A ended on 14 Sept 2026.')).toBeVisible();
  expect(calls(requests, 'POST', '/enrolments/e1/change-section')[0].postDataJSON()).toEqual({
    sectionId: 'sec-b',
    effectiveOn: '2026-09-15',
    reason: 'Parent request',
  });

  await page.getByRole('button', { name: 'Actions for Class 5 A' }).click();
  await page.getByRole('menuitem', { name: 'Set roll number' }).click();
  const roll = page.getByRole('dialog', { name: 'Roll number' });
  await roll.getByLabel('Roll number').fill('3');
  await roll.getByRole('button', { name: 'Save' }).click();
  await expect(roll.getByText('Roll number 3 is already used in this section.')).toBeVisible();
  expect(calls(requests, 'PATCH', '/enrolments/e1')[0].postDataJSON()).toEqual({ rollNo: 3 });
});

test('enrolment: change class closes the old enrolment the day before; a zero-length row reads not in force', async ({ page }) => {
  const corrected = { ...ENROLMENT, id: 'e0', sectionId: 'sec-b', sectionName: 'B', status: 'left' as const, startedOn: '2025-04-01', endedOn: '2025-03-31' };
  const requests = await mockApi(page, {
    me: OFFICE_ME,
    replies: {
      'GET /students/st1/enrolments': { status: 200, body: page1([ENROLMENT, corrected]) },
      'POST /enrolments/e1/change-class': {
        status: 200,
        body: {
          closed: { ...ENROLMENT, status: 'left', endedOn: '2026-09-30' },
          opened: { ...ENROLMENT, id: 'e3', classId: 'c6', className: 'Class 6', sectionId: 'sec-6a', sectionName: 'A', rollNo: null, startedOn: '2026-10-01' },
        },
      },
    },
  });
  await page.clock.setFixedTime(new Date('2026-10-04T05:00:00Z'));
  await page.goto('/students/st1');
  await page.getByRole('tab', { name: 'Enrolment history' }).click();
  await expect(page.getByText('Not in force (corrected)')).toBeVisible();
  await page.getByRole('button', { name: 'Actions for Class 5 A' }).click();
  await page.getByRole('menuitem', { name: 'Change class' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change class' });
  await dialog.getByLabel('Class', { exact: true }).selectOption('c6');
  await dialog.getByLabel('Section', { exact: true }).selectOption('sec-6a');
  await dialog.getByLabel('Effective from').fill('2026-10-01');
  await expect(dialog).toContainText('Closes the current enrolment on 30 Sept 2026 and opens a new one from 1 Oct 2026.');
  await dialog.getByLabel('Reason').fill('Promoted mid-year');
  await dialog.getByRole('button', { name: 'Change class' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Now in Class 6 A from 1 Oct 2026. Class 5 A ended on 30 Sept 2026.')).toBeVisible();
  expect(calls(requests, 'POST', '/enrolments/e1/change-class')[0].postDataJSON()).toEqual({
    classId: 'c6',
    sectionId: 'sec-6a',
    effectiveOn: '2026-10-01',
    reason: 'Promoted mid-year',
  });
});

// ---- Documents ----

test('documents: upload then attach; download through the API; an unsupported file is refused', async ({ page }) => {
  const requests = await mockApi(page, {
    me: OFFICE_ME,
    documents: [
      {
        id: 'd1',
        studentId: 'st1',
        type: 'b_form',
        mime: 'application/pdf',
        sizeBytes: 50_000,
        uploadedBy: 'u-office',
        uploadedByName: 'Sana Office',
        createdAt: STAMP,
      },
    ],
  });
  await page.goto('/students/st1');
  await page.getByRole('tab', { name: 'Documents' }).click();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download B-Form' }).click();
  expect((await download).suggestedFilename()).toBe('b_form-d1.pdf');

  const card = page.locator('[data-slot="card"]').filter({ hasText: 'Add a document' });
  await card.getByLabel('Type').selectOption('photo');
  await card.getByLabel('File').setInputFiles({ name: 'scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') });
  await expect(card.getByText('A photo must be a JPEG or PNG image.')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Upload' })).toBeDisabled();

  await card.getByLabel('File').setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: Buffer.from('png') });
  await card.getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByText('Photo added.')).toBeVisible();
  expect(calls(requests, 'POST', '/uploads')[0].headers()['content-type']).toMatch(/^multipart\/form-data/);
  expect(calls(requests, 'POST', '/students/st1/documents')[0].postDataJSON()).toEqual({
    stagedUploadId: 'up9',
    type: 'photo',
  });
  await expect(page.getByRole('cell', { name: 'Photo', exact: true })).toBeVisible();

  await page.unrouteAll({ behavior: 'wait' });
  await mockApi(page, {
    me: OFFICE_ME,
    replies: {
      'POST /uploads': { status: 415, body: errorBody('UNSUPPORTED_MEDIA_TYPE', 'Only JPEG, PNG and PDF files are accepted.') },
    },
  });
  await card.getByLabel('Type').selectOption('other');
  await card.getByLabel('File').setInputFiles({ name: 'x.pdf', mimeType: 'application/pdf', buffer: Buffer.from('<svg/>') });
  await card.getByRole('button', { name: 'Upload' }).click();
  await expect(card.getByText('Only JPEG, PNG and PDF files are accepted.')).toBeVisible();
});

// ---- Readmission ----

test('readmit: class, section and date, then the reason; a guardian-link refusal points at the links', async ({
  page,
}) => {
  const requests = await mockApi(page, {
    me: OFFICE_ME,
    students: [student('st1', 'Hina Ali', { status: 'withdrawn', current: null })],
    replies: {
      'POST /students/st1/readmit': {
        status: 409,
        body: errorBody('PRIMARY_CONTACT_REQUIRED', 'The student has no primary contact.'),
      },
    },
  });
  await page.goto('/students/st1/readmit');
  await expect(page.getByRole('heading', { name: 'Readmit Hina Ali' })).toBeVisible();
  await page.getByLabel('Academic year').selectOption('y1');
  await page.getByLabel('Class').selectOption('c6');
  await page.getByLabel('Section').selectOption('sec-6a');
  await page.getByLabel('Roll number (optional)').fill('12');
  await page.getByRole('button', { name: 'Readmit…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Readmit Hina Ali?' });
  await dialog.getByLabel('Reason').fill('Returned from Lahore');
  await dialog.getByRole('button', { name: 'Readmit' }).click();
  await expect(page.getByText('The student has no primary contact.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Fix the guardian links first' })).toHaveAttribute('href', '/students/st1');
  expect(calls(requests, 'POST', '/students/st1/readmit')[0].postDataJSON()).toMatchObject({
    classId: 'c6',
    sectionId: 'sec-6a',
    rollNo: 12,
    reason: 'Returned from Lahore',
  });

  await page.unrouteAll({ behavior: 'wait' });
  await mockApi(page, { me: OFFICE_ME, students: [student('st1', 'Hina Ali', { status: 'withdrawn', current: null })] });
  await page.getByRole('button', { name: 'Readmit…' }).click();
  await page.getByRole('dialog').getByLabel('Reason').fill('Returned from Lahore');
  await page.getByRole('dialog').getByRole('button', { name: 'Readmit' }).click();
  await expect(page).toHaveURL(/\/students\/st1$/);
  await expect(page.getByText('Hina Ali is readmitted.')).toBeVisible();
});

// ---- Guardian detail ----

test("guardian detail lists the guardian's students, linked to their records", async ({ page }) => {
  await mockApi(page, { me: OFFICE_ME });
  await page.goto('/guardians/g1');
  const row = page.getByRole('row', { name: /Ali Khan/ });
  await expect(row.getByRole('link', { name: 'Ali Khan' })).toHaveAttribute('href', '/students/st1');
  await expect(row.getByText('Primary contact')).toBeVisible();
  await expect(row.getByText('Class 5 A')).toBeVisible();
});
