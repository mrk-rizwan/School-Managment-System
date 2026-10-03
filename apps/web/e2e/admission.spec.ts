import { SYSTEM_ROLE_DEFAULTS } from '@asms/shared';
import { expect as baseExpect, test, type Page, type Request } from '@playwright/test';
import type { ApiErrorEnvelope } from '../lib/api/errors';
import type { AcademicYearDto, ClassDto, SectionDto } from '../lib/api/school-academics-contract';
import type { MeDto } from '../lib/api/school-contract';
import type { GuardianDto, GuardianLookupResultDto } from '../lib/api/school-guardians-contract';
import type {
  AdmissionBody,
  AdmissionResultDto,
  StudentDetailDto,
  StudentLookupResultDto,
} from '../lib/api/school-students-contract';

// The admission wizard (contracts/slice-6.md §6.3, §10; plan §5 slice 6) against a mocked API:
// every /api/v1/* request is answered in the browser by page.route.

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
};
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
const CLOSED_YEAR: AcademicYearDto = { ...YEAR, id: 'y0', name: '2025-26', status: 'closed' };
const CLASS_5: ClassDto = {
  id: 'c5',
  academicYearId: 'y1',
  academicYearName: '2026-27',
  name: 'Class 5',
  sortOrder: 5,
  attendanceMode: 'daily',
  status: 'active',
  createdAt: STAMP,
  updatedAt: STAMP,
};
const SECTION_A: SectionDto = {
  id: 'sec-a',
  classId: 'c5',
  name: 'A',
  capacity: null,
  archivedAt: null,
  createdAt: STAMP,
  updatedAt: STAMP,
};

const guardian = (id: string, fullName: string, extra: Partial<GuardianDto> = {}): GuardianDto => ({
  id,
  fullName,
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
  ...extra,
});

const studentDetail = (extra: Partial<StudentDetailDto> = {}): StudentDetailDto => ({
  id: 'st-new',
  admissionNo: '1042',
  fullName: 'Ali Khan',
  gender: 'male',
  dateOfBirth: '2016-05-04',
  hasBForm: true,
  bFormMasked: '35202-*****-3',
  status: 'active',
  admittedOn: '2026-09-01',
  current: {
    enrolmentId: 'e1',
    academicYearId: 'y1',
    academicYearName: '2026-27',
    classId: 'c5',
    className: 'Class 5',
    sectionId: 'sec-a',
    sectionName: 'A',
    rollNo: null,
  },
  userId: null,
  createdAt: STAMP,
  updatedAt: STAMP,
  notes: null,
  photoDocumentId: null,
  ...extra,
});

const ADMITTED: AdmissionResultDto = {
  student: studentDetail(),
  enrolment: {
    id: 'e1',
    studentId: 'st-new',
    academicYearId: 'y1',
    academicYearName: '2026-27',
    classId: 'c5',
    className: 'Class 5',
    sectionId: 'sec-a',
    sectionName: 'A',
    rollNo: null,
    status: 'active',
    startedOn: '2026-09-01',
    endedOn: null,
  },
  guardianLinks: [],
  documents: [],
  loginOffers: { student: true, guardians: [{ guardianId: 'g1', fullName: 'Ahmed Khan', available: true }] },
};

type ErrorBody = ApiErrorEnvelope['error'];
const errorBody = (code: ErrorBody['code'], message: string, details: ErrorBody['details'] = null): ApiErrorEnvelope => ({
  error: { code, message, details, requestId: 'req-test' },
});

type Reply = { status: number; body: unknown };
type MockState = {
  me?: MeDto;
  studentLookup?: StudentLookupResultDto;
  cnicHits?: GuardianLookupResultDto;
  phoneHits?: GuardianLookupResultDto;
  /** Answers to POST /admissions, in order; the last one repeats. */
  admissions?: Reply[];
  replies?: Record<string, Reply>;
};
const NO_HITS: GuardianLookupResultDto = { data: [], truncated: false };

async function mockApi(page: Page, state: MockState = {}) {
  const requests: Request[] = [];
  const admissions = state.admissions ?? [{ status: 201, body: ADMITTED }];
  let admissionCalls = 0;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    requests.push(request);
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const method = request.method();
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const canned = state.replies?.[`${method} ${path}`];
    if (canned) return json(canned.status, canned.body);

    if (method === 'GET' && path === '/me') return json(200, state.me ?? OFFICE_ME);
    if (method === 'POST' && path === '/auth/login') return json(200, state.me ?? OFFICE_ME);
    if (method === 'POST' && path === '/students/lookup') {
      return json(200, state.studentLookup ?? { data: [], truncated: false });
    }
    if (method === 'POST' && path === '/guardians/lookup') {
      const body = request.postDataJSON() as { cnic?: string; phone?: string };
      return json(200, (body.cnic ? state.cnicHits : state.phoneHits) ?? NO_HITS);
    }
    if (method === 'GET' && path === '/academic-years') {
      return json(200, { data: [YEAR, CLOSED_YEAR], page: 1, limit: 50, total: 2 });
    }
    if (method === 'GET' && path === '/classes') return json(200, { data: [CLASS_5], page: 1, limit: 50, total: 1 });
    if (method === 'GET' && path === '/classes/c5/sections') {
      return json(200, { data: [SECTION_A], page: 1, limit: 50, total: 1 });
    }
    if (method === 'POST' && path === '/uploads') {
      return json(201, { id: 'up1', mime: 'application/pdf', sizeBytes: 1234, expiresAt: STAMP });
    }
    if (method === 'POST' && path === '/admissions') {
      const reply = admissions[Math.min(admissionCalls, admissions.length - 1)];
      admissionCalls += 1;
      return json(reply.status, reply.body);
    }
    if (method === 'POST' && /^\/(students|guardians)\/[^/]+\/issue-login$/.test(path)) {
      return json(201, { id: 'u-new' });
    }
    return json(500, errorBody('INTERNAL_ERROR', `Unmocked ${method} ${path}`));
  });
  return requests;
}

const calls = (requests: Request[], method: string, path: string) =>
  requests.filter((r) => r.method() === method && new URL(r.url()).pathname === `/api/v1${path}`);

const AHMED_HIT: GuardianLookupResultDto = {
  data: [
    {
      guardian: guardian('g1', 'Ahmed Khan'),
      resolvedFromId: null,
      students: [{ studentId: 's9', fullName: 'Sara', className: 'Class 3', relationship: 'father' }],
    },
  ],
  truncated: false,
};

/** Step 1: B-Form checked (a miss), then the details. */
async function fillStudentStep(page: Page) {
  await page.goto('/admissions/new');
  await page.getByLabel('Student’s B-Form or CRC number').fill('3520212345673');
  await expect(page.getByLabel('Student’s B-Form or CRC number')).toHaveValue('35202-1234567-3');
  await page.getByRole('button', { name: 'Check B-Form' }).click();
  await expect(page.getByText('35202-*******-3')).toBeVisible();
  await page.getByLabel('Full name').fill('Ali Khan');
  await page.getByLabel('Gender').selectOption('male');
  await page.getByLabel('Date of birth').fill('2016-05-04');
  await page.getByRole('button', { name: 'Continue' }).click();
}

/** Step 2: Ahmed Khan found by CNIC and linked as father. */
async function linkAhmed(page: Page) {
  await page.getByLabel('Guardian’s CNIC').fill('35201-1234567-1');
  await page.getByRole('button', { name: 'Search by CNIC' }).click();
  await expect(page.getByText('Ahmed Khan')).toBeVisible();
  await expect(page.getByText('— father of Sara, Class 3')).toBeVisible();
  await page.getByRole('button', { name: 'Link Ahmed Khan' }).click();
  await page.getByLabel('Relationship').selectOption('father');
  await page.getByRole('button', { name: 'Continue' }).click();
}

async function fillPlacementStep(page: Page) {
  await expect(page.getByLabel('Academic year').locator('option')).toHaveText(['Choose…', '2026-27']);
  await page.getByLabel('Academic year').selectOption('y1');
  await page.getByLabel('Class').selectOption('c5');
  await page.getByLabel('Section').selectOption('sec-a');
  await page.getByRole('button', { name: 'Continue' }).click();
}

async function reachReview(page: Page) {
  await fillStudentStep(page);
  await linkAhmed(page);
  await fillPlacementStep(page);
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page.getByRole('button', { name: 'Admit student' })).toBeVisible();
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

test('happy path: B-Form checked, guardian matched by CNIC, a document staged, then login offers', async ({
  page,
}) => {
  const requests = await mockApi(page, { cnicHits: AHMED_HIT });
  await fillStudentStep(page);
  expect(calls(requests, 'POST', '/students/lookup')[0].postDataJSON()).toEqual({ bForm: '3520212345673' });

  await linkAhmed(page);
  await fillPlacementStep(page);

  // Step 4: a staged upload, multipart to POST /uploads.
  await page.getByLabel('Type').selectOption('b_form');
  await page.getByLabel(/^File/).setInputFiles({ name: 'bform.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
  await page.getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByText('— bform.pdf, 1 KB')).toBeVisible();
  const upload = calls(requests, 'POST', '/uploads')[0];
  expect(upload.headers()['content-type']).toMatch(/^multipart\/form-data; boundary=/);
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByText('Father, primary contact, pays fees')).toBeVisible();
  await page.getByRole('button', { name: 'Admit student' }).click();
  await expect(page.getByText('Ali Khan is admitted')).toBeVisible();

  const admission = calls(requests, 'POST', '/admissions')[0];
  expect(admission.headers()['idempotency-key']).toMatch(KEY_PATTERN);
  const body = admission.postDataJSON() as AdmissionBody;
  expect(body).toMatchObject({
    student: { fullName: 'Ali Khan', gender: 'male', dateOfBirth: '2016-05-04', bForm: '3520212345673' },
    guardians: [{ guardianId: 'g1', relationship: 'father', isPrimaryContact: true, isFeePayer: true, canLogin: false }],
    enrolment: { classId: 'c5', sectionId: 'sec-a' },
    documents: [{ stagedUploadId: 'up1', type: 'b_form' }],
  });
  // The linked guardian is sent by id, never by the CNIC that found them.
  expect(JSON.stringify(body.guardians)).not.toContain('3520112345671');
  expect(body.acknowledgedDuplicateStudentIds).toBeUndefined();

  // Login offers (user.account.manage).
  await page.getByRole('listitem').filter({ hasText: 'Ahmed Khan (guardian)' }).getByRole('button', { name: 'Issue login' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Ahmed Khan (guardian)' }).getByText('Login issued')).toBeVisible();
  expect(calls(requests, 'POST', '/guardians/g1/issue-login')).toHaveLength(1);
  await expect(page.getByRole('link', { name: 'Open the student’s record' })).toHaveAttribute('href', '/students/st-new');
});

test('guardian step cannot be skipped: CNIC, then phone; every phone hit shown; a new guardian only after both', async ({
  page,
}) => {
  const requests = await mockApi(page, {
    phoneHits: {
      data: [
        { guardian: guardian('g1', 'Ahmed Khan'), resolvedFromId: 'g0', students: [] },
        {
          guardian: guardian('g2', 'Bilal Khan'),
          resolvedFromId: null,
          students: [{ studentId: 's7', fullName: 'Zara', className: 'Class 2', relationship: 'father' }],
        },
      ],
      truncated: false,
    },
  });
  await fillStudentStep(page);

  // Nothing linked yet: the step refuses to continue.
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Link or add at least one guardian.')).toBeVisible();

  await page.getByLabel('Guardian’s CNIC').fill('35201-1234567-9');
  await page.getByRole('button', { name: 'Search by CNIC' }).click();
  await expect(page.getByText('No guardian has this CNIC.')).toBeVisible();
  // A miss moves on to the phone search; no "add new" yet.
  await expect(page.getByRole('button', { name: 'Add a new guardian' })).toHaveCount(0);

  await page.getByLabel('Guardian’s mobile phone').fill('0300 1234567');
  await page.getByRole('button', { name: 'Search by phone' }).click();
  await expect(page.getByText('2 guardians found.', { exact: false })).toBeVisible();
  await expect(page.getByText('Ahmed Khan')).toBeVisible();
  await expect(page.getByText('— father of Zara, Class 2')).toBeVisible();
  await expect(page.getByText('The matching record was merged into this one.')).toBeVisible();
  expect(calls(requests, 'POST', '/guardians/lookup').map((r) => r.postDataJSON())).toEqual([
    { cnic: '3520112345679' },
    { phone: '+923001234567' },
  ]);

  await page.getByRole('button', { name: 'None of these' }).click();
  await page.getByRole('button', { name: 'Add a new guardian' }).click();
  // The searched values are filled in.
  await expect(page.getByLabel('CNIC (optional)')).toHaveValue('35201-1234567-9');
  await expect(page.getByLabel('Mobile phone (optional)')).toHaveValue('+923001234567');
  await page.getByLabel('Full name').fill('Nadia Khan');
  await page.getByRole('radio', { name: /Keypad phone/ }).check();
  await page.getByRole('button', { name: 'Add guardian' }).click();

  await expect(page.getByText('New guardian, created with the admission.')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Choose each guardian’s relationship.')).toBeVisible();
  await page.getByLabel('Relationship').selectOption('mother');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByLabel('Academic year')).toBeVisible();
});

test('possible duplicate: the warning lists matches; "different children" resubmits with the same key and the ids', async ({
  page,
}) => {
  const requests = await mockApi(page, {
    cnicHits: AHMED_HIT,
    admissions: [
      {
        status: 409,
        body: errorBody('ADMISSION_POSSIBLE_DUPLICATE', 'A student with these details may already exist.', {
          matches: [
            {
              studentId: 's9',
              admissionNo: '0907',
              fullName: 'Ali Khan',
              dateOfBirth: '2016-05-04',
              status: 'active',
              className: 'Class 5',
            },
          ],
        }),
      },
      { status: 201, body: ADMITTED },
    ],
  });
  await reachReview(page);
  await page.getByRole('button', { name: 'Admit student' }).click();

  await expect(page.getByText('This may be a child already on record')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ali Khan' })).toHaveAttribute('href', '/students/s9');
  await page.getByRole('button', { name: 'These are different children — admit' }).click();
  await expect(page.getByText('Ali Khan is admitted')).toBeVisible();

  const [first, second] = calls(requests, 'POST', '/admissions');
  expect(first.headers()['idempotency-key']).toMatch(KEY_PATTERN);
  expect(second.headers()['idempotency-key']).toBe(first.headers()['idempotency-key']);
  expect((first.postDataJSON() as AdmissionBody).acknowledgedDuplicateStudentIds).toBeUndefined();
  expect((second.postDataJSON() as AdmissionBody).acknowledgedDuplicateStudentIds).toEqual(['s9']);
});

test('session expiry: the submit signs in again in place and resends with the same key', async ({ page }) => {
  const requests = await mockApi(page, {
    cnicHits: AHMED_HIT,
    admissions: [
      { status: 401, body: errorBody('AUTH_REQUIRED', 'Sign in to continue.') },
      { status: 201, body: ADMITTED },
    ],
  });
  await reachReview(page);
  await page.getByRole('button', { name: 'Admit student' }).click();

  const dialog = page.getByRole('dialog', { name: 'Sign in to continue' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('CNIC').fill('3520112345671');
  await dialog.getByLabel('Password').fill('a-password');
  await dialog.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByText('Ali Khan is admitted')).toBeVisible();
  // Never sent to /login: the wizard and its answers stayed on the page.
  await expect(page).toHaveURL(/\/admissions\/new$/);
  expect(calls(requests, 'POST', '/auth/login')[0].postDataJSON()).toEqual({
    schoolCode: 'greenvalley',
    username: '3520112345671',
    password: 'a-password', // pragma: allowlist secret
  });
  const [first, second] = calls(requests, 'POST', '/admissions');
  expect(second.headers()['idempotency-key']).toBe(first.headers()['idempotency-key']);
  expect(second.postDataJSON()).toEqual(first.postDataJSON());
});

test('a background 401 (GET /me on window focus) opens the sign-in dialog instead of leaving the wizard', async ({
  page,
}) => {
  // Real time keeps flowing; fastForward makes the cached /me stale (staleTime 30 s) on demand.
  await page.clock.install();
  const state: MockState = { cnicHits: AHMED_HIT };
  const requests = await mockApi(page, state);
  await fillStudentStep(page);
  await linkAhmed(page);
  await expect(page.getByLabel('Academic year')).toBeVisible();

  // The session ends; the next refetch of GET /me answers 401.
  state.replies = { 'GET /me': { status: 401, body: errorBody('AUTH_REQUIRED', 'Sign in to continue.') } };
  const meCallsBefore = calls(requests, 'GET', '/me').length;
  await page.clock.fastForward('01:00');
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => calls(requests, 'GET', '/me').length).toBeGreaterThan(meCallsBefore);

  const dialog = page.getByRole('dialog', { name: 'Sign in to continue' });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/admissions\/new$/);

  state.replies = {};
  await dialog.getByLabel('CNIC').fill('3520112345671');
  await dialog.getByLabel('Password').fill('a-password');
  await dialog.getByRole('button', { name: 'Sign in' }).click();
  await expect(dialog).toHaveCount(0);

  // The wizard kept its answers: it carries on at the class step and admits.
  await fillPlacementStep(page);
  await page.getByRole('button', { name: 'Skip' }).click();
  await page.getByRole('button', { name: 'Admit student' }).click();
  await expect(page.getByText('Ali Khan is admitted')).toBeVisible();
  const body = calls(requests, 'POST', '/admissions')[0].postDataJSON() as AdmissionBody;
  expect(body.student.fullName).toBe('Ali Khan');
  expect(body.guardians).toEqual([expect.objectContaining({ guardianId: 'g1', relationship: 'father' })]);
});

test('B-Form lookup: a former student is offered readmission; a current one stops the admission', async ({
  page,
}) => {
  const former = studentDetail({ id: 's3', fullName: 'Hina Ali', status: 'withdrawn', current: null });
  await mockApi(page, { studentLookup: { data: [{ student: former, readmissible: true }], truncated: false } });
  await page.goto('/admissions/new');
  await page.getByLabel('Student’s B-Form or CRC number').fill('35202-1234567-3');
  await page.getByRole('button', { name: 'Check B-Form' }).click();
  await expect(page.getByText('This child was a student here')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Readmit Hina Ali' })).toHaveAttribute('href', '/students/s3/readmit');
  await expect(page.getByLabel('Full name')).toHaveCount(0);

  await page.unrouteAll({ behavior: 'wait' });
  const current = studentDetail({ id: 's4', fullName: 'Omar Ali' });
  await mockApi(page, { studentLookup: { data: [{ student: current, readmissible: false }], truncated: false } });
  await page.getByRole('button', { name: 'Check B-Form' }).click();
  await expect(page.getByText('This child is already a student')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open the record' })).toHaveAttribute('href', '/students/s4');
});

test('refusal: a taken roll number sends the office back to the class step', async ({ page }) => {
  await mockApi(page, {
    cnicHits: AHMED_HIT,
    admissions: [{ status: 409, body: errorBody('ROLL_NO_TAKEN', 'Roll number 7 is already used in this section.') }],
  });
  await reachReview(page);
  await page.getByRole('button', { name: 'Admit student' }).click();
  await expect(page.getByText('The student was not admitted')).toBeVisible();
  await expect(page.getByText('Roll number 7 is already used in this section.')).toBeVisible();
  await page.getByRole('button', { name: 'Go to class and section' }).click();
  await expect(page.getByLabel('Roll number (optional)')).toBeVisible();
});

test('a user without student.create gets the no-permission state', async ({ page }) => {
  await mockApi(page, { me: TEACHER_ME });
  await page.goto('/admissions/new');
  await expect(page.getByText('You do not have access')).toBeVisible();
  await expect(page.getByLabel('Student’s B-Form or CRC number')).toHaveCount(0);
});
