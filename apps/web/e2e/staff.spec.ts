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
import type { CustomRoleDto } from '../lib/api/school-roles-contract';
import type {
  StaffDto,
  TeacherAssignmentDto,
  UserDto,
  UserRoleDto,
} from '../lib/api/school-staff-contract';

// Staff screens (contracts/slice-4.md §8) against a mocked API: every /api/v1/* request is
// answered in the browser by page.route. Payload types come from the contract files.

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
  capabilityScopes: [],
  sessionExpiresAt: '2026-11-02T05:00:00.000Z',
  capacities: ['staff'],
  assignments: [],
  staffId: null,
  children: [],
};
const PRINCIPAL_ME: MeDto = {
  ...OFFICE_ME,
  id: 'u-principal',
  roles: ['principal'],
  capabilities: Object.values(Capability).sort(),
};
const TEACHER_ME: MeDto = {
  ...OFFICE_ME,
  id: 'u-teacher',
  roles: ['teacher'],
  capabilities: [...SYSTEM_ROLE_DEFAULTS.teacher].sort(),
};

const STAMP = '2026-09-01T05:00:00.000Z';
const staffRow = (id: string, fullName: string, extra: Partial<StaffDto> = {}): StaffDto => ({
  id,
  fullName,
  cnicMasked: '35201-*****-1',
  hasCnic: true,
  phone: '+923001234567',
  designation: 'Teacher',
  joinedOn: '2026-08-01',
  status: 'active',
  userId: null,
  systemRoles: [],
  customRoleNames: [],
  createdAt: STAMP,
  updatedAt: STAMP,
  ...extra,
});

const userFor = (staff: StaffDto): UserDto => ({
  id: 'u-new',
  staffId: staff.id,
  guardianId: null,
  studentId: null,
  fullName: staff.fullName,
  systemRoles: [],
  customRoleNames: [],
  status: 'active',
  emailMasked: null,
  hasEmail: false,
  hasVerifiedEmail: false,
  passwordIsDefault: true,
  lastLoginAt: null,
  createdAt: STAMP,
});

const YEAR: AcademicYearDto = {
  id: 'y1',
  name: '2026-27',
  startsOn: '2026-04-01',
  endsOn: '2027-03-31',
  status: 'active',
  createdAt: STAMP,
  updatedAt: STAMP,
};
const CLASS5: ClassDto = {
  id: 'c5',
  academicYearId: 'y1',
  academicYearName: '2026-27',
  name: 'Class 5',
  attendanceMode: 'daily',
  sortOrder: 5,
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
const MATHS: SubjectDto = {
  id: 'sub-m',
  name: 'Mathematics',
  code: 'MATH',
  archivedAt: null,
  createdAt: STAMP,
  updatedAt: STAMP,
};

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
  staff?: StaffDto[];
  roles?: UserRoleDto[];
  assignments?: TeacherAssignmentDto[];
  /** Answers the matching `METHOD /path` (once each, in order) instead of the default behaviour. */
  replies?: Record<string, Reply | Reply[]>;
};

const page1 = <T,>(data: T[]) => ({ data, page: 1, limit: 25, total: data.length });

async function mockStaffApi(page: Page, state: MockState) {
  const staff = state.staff ?? [];
  const roles = state.roles ?? [];
  const assignments = state.assignments ?? [];
  const requests: Request[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    requests.push(request);
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = request.method();
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const canned = state.replies?.[`${method} ${path}`];
    if (canned) {
      const reply = Array.isArray(canned) ? canned.shift() : canned;
      if (reply) return json(reply.status, reply.body);
    }

    if (method === 'GET' && path === '/me') return json(200, state.me);
    if (method === 'GET' && path === '/academic-years') return json(200, page1([YEAR]));
    if (method === 'GET' && path === '/classes') return json(200, page1([CLASS5]));
    if (method === 'GET' && path === '/classes/c5/sections') return json(200, page1([SECTION_A]));
    if (method === 'GET' && path === '/subjects') return json(200, page1([MATHS]));
    if (path === '/staff' && method === 'GET') return json(200, page1(staff));
    if (path === '/custom-roles' && method === 'GET') return json(200, page1([CLERK_ROLE]));
    if (path === '/staff' && method === 'POST') {
      const b = request.postDataJSON() as Partial<StaffDto> & { cnic?: string | null };
      const created = staffRow('st-new', b.fullName ?? '', {
        cnicMasked: b.cnic ? '35201-*****-1' : null,
        hasCnic: Boolean(b.cnic),
        phone: b.phone ?? '',
        designation: b.designation ?? null,
        joinedOn: b.joinedOn ?? null,
      });
      staff.push(created);
      return json(201, created);
    }
    const userRoles = path.match(/^\/users\/([^/]+)\/roles$/);
    if (userRoles && method === 'GET') return json(200, page1(roles));
    const match = path.match(/^\/staff\/([^/]+)(?:\/(change-status|issue-login|teacher-assignments))?$/);
    if (match) {
      const found = staff.find((s) => s.id === match[1]);
      if (!found) return json(404, errorBody('NOT_FOUND', 'Not found.'));
      const touch = () => (found.updatedAt = new Date().toISOString());
      if (!match[2] && method === 'GET') return json(200, found);
      if (!match[2] && method === 'PATCH') {
        Object.assign(found, request.postDataJSON());
        touch();
        return json(200, found);
      }
      if (match[2] === 'change-status') {
        found.status = (request.postDataJSON() as { status: StaffDto['status'] }).status;
        touch();
        return json(200, found);
      }
      if (match[2] === 'issue-login') {
        found.userId = 'u-new';
        found.systemRoles = [(request.postDataJSON() as { systemRole: 'teacher' }).systemRole];
        touch();
        return json(201, userFor(found));
      }
      if (match[2] === 'teacher-assignments' && method === 'GET') return json(200, page1(assignments));
      if (match[2] === 'teacher-assignments' && method === 'POST') {
        const b = request.postDataJSON() as { role: TeacherAssignmentDto['role'] };
        const row = assignment('ta-new', { role: b.role, staffId: found.id, staffFullName: found.fullName });
        assignments.unshift(row);
        return json(201, row);
      }
    }
    const end = path.match(/^\/teacher-assignments\/([^/]+)\/end$/);
    if (end) {
      const row = assignments.find((a) => a.id === end[1]);
      if (!row) return json(404, errorBody('NOT_FOUND', 'Not found.'));
      row.endsOn = '2026-10-02';
      row.activeToday = false;
      return json(200, row);
    }
    return json(500, errorBody('INTERNAL_ERROR', `Unmocked ${method} ${path}`));
  });
  return requests;
}

const assignment = (id: string, extra: Partial<TeacherAssignmentDto> = {}): TeacherAssignmentDto => ({
  id,
  staffId: 'st1',
  staffFullName: 'Ayesha Malik',
  academicYearId: 'y1',
  academicYearName: '2026-27',
  classId: 'c5',
  className: 'Class 5',
  sectionId: 'sec-a',
  sectionName: 'A',
  subjectId: null,
  subjectName: null,
  role: 'class_teacher',
  startsOn: '2026-04-01',
  endsOn: null,
  voidedAt: null,
  activeToday: true,
  coversAssignmentId: null,
  coversStaffFullName: null,
  createdAt: STAMP,
  ...extra,
});

const CLERK_ROLE: CustomRoleDto = {
  id: 'cr1',
  key: 'accounts_clerk',
  name: 'Accounts clerk',
  status: 'active',
  capabilities: [Capability.PAYMENT_RECORD],
  holderCount: 0,
  createdAt: STAMP,
  updatedAt: STAMP,
};

const roleRow = (id: string, extra: Partial<UserRoleDto> = {}): UserRoleDto => ({
  id,
  userId: 'u7',
  systemRole: 'teacher',
  customRoleId: null,
  customRoleName: null,
  assignedBy: 'u-principal',
  assignedAt: STAMP,
  endedAt: null,
  endedBy: null,
  ...extra,
});

const calls = (requests: Request[], method: string, path: string) =>
  requests.filter((r) => r.method() === method && new URL(r.url()).pathname === `/api/v1${path}`);

// ---- List ----

test('list: masked CNIC, roles and status; asks for active staff; never sends a CNIC search', async ({ page }) => {
  const requests = await mockStaffApi(page, {
    me: OFFICE_ME,
    staff: [
      staffRow('st1', 'Ayesha Malik', { userId: 'u7', systemRoles: ['teacher'], customRoleNames: ['Exams desk'] }),
      staffRow('st2', 'Bilal Ahmed', { cnicMasked: null, hasCnic: false, designation: null }),
    ],
  });

  await page.goto('/staff');
  const table = page.getByRole('table');
  const ayesha = table.getByRole('row', { name: /Ayesha Malik/ });
  await expect(ayesha.getByText('35201-*****-1')).toBeVisible();
  await expect(ayesha.getByText('Teacher', { exact: true }).last()).toBeVisible();
  await expect(ayesha.getByText('Exams desk', { exact: true })).toBeVisible();
  await expect(ayesha.getByText('Has login')).toBeVisible();
  await expect(ayesha.getByText('Active')).toBeVisible();
  await expect(table.getByRole('row', { name: /Bilal Ahmed/ }).getByText('No CNIC')).toBeVisible();
  expect(new URL(calls(requests, 'GET', '/staff')[0].url()).searchParams.get('status')).toBe('active');
  // Office staff hold staff.view only.
  await expect(page.getByRole('link', { name: 'New staff member' })).toHaveCount(0);

  await page.getByLabel('Role').selectOption('teacher');
  await expect.poll(() => calls(requests, 'GET', '/staff').some((r) => new URL(r.url()).searchParams.get('role') === 'teacher')).toBe(true);

  await page.getByLabel('Search').fill('35201-1234567-1');
  await expect(page.getByText('Staff cannot be searched by CNIC.', { exact: false })).toBeVisible();
  await page.waitForTimeout(500);
  for (const r of calls(requests, 'GET', '/staff')) {
    expect(new URL(r.url()).searchParams.get('q') ?? '').not.toMatch(/\d{5}/);
  }
});

test('list: a user without staff.view gets the no-permission state', async ({ page }) => {
  await mockStaffApi(page, {
    me: TEACHER_ME,
    replies: { 'GET /staff': { status: 403, body: errorBody('PERMISSION_DENIED', 'Not allowed.') } },
  });
  await page.goto('/staff');
  await expect(page.getByText('You do not have access')).toBeVisible();
  await expect(page.getByRole('link', { name: 'New staff member' })).toHaveCount(0);
});

// ---- Create ----

test('create: sends the normalised CNIC and opens the new record', async ({ page }) => {
  const requests = await mockStaffApi(page, { me: PRINCIPAL_ME });
  await page.goto('/staff/new');
  await page.getByLabel('Full name').fill('Ayesha Malik');
  await page.getByLabel('CNIC (optional)').fill('3520112345671');
  await expect(page.getByLabel('CNIC (optional)')).toHaveValue('35201-1234567-1');
  await page.getByLabel('Mobile phone').fill('0300 1234567');
  await expect(page.getByText('Will be saved as +923001234567.')).toBeVisible();
  await page.getByLabel('Designation (optional)').fill('Senior teacher');
  await page.getByRole('button', { name: 'Add staff member' }).click();

  await expect(page).toHaveURL(/\/staff\/st-new$/);
  await expect(page.getByRole('heading', { name: 'Ayesha Malik' })).toBeVisible();
  expect(calls(requests, 'POST', '/staff')[0].postDataJSON()).toEqual({
    fullName: 'Ayesha Malik',
    cnic: '3520112345671',
    phone: '0300 1234567',
    designation: 'Senior teacher',
    // No joining date given: the field is left out (CreateStaffDto.joinedOn is not nullable).
  });
});

test('create: a user without staff.create gets the no-permission state, not the form', async ({ page }) => {
  const requests = await mockStaffApi(page, { me: TEACHER_ME });
  await page.goto('/staff/new');
  await expect(page.getByText('You do not have access')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'New staff member' })).toBeVisible();
  await expect(page.getByLabel('Full name')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add staff member' })).toHaveCount(0);
  expect(calls(requests, 'POST', '/staff')).toHaveLength(0);
});

test('create: an existing CNIC offers to open that staff member', async ({ page }) => {
  await mockStaffApi(page, {
    me: PRINCIPAL_ME,
    replies: {
      'POST /staff': {
        status: 409,
        body: errorBody('STAFF_CNIC_EXISTS', 'A staff member with this CNIC already exists.', { staffId: 'st9' }),
      },
    },
  });
  await page.goto('/staff/new');
  await page.getByLabel('Full name').fill('Ayesha Malik');
  await page.getByLabel('CNIC (optional)').fill('3520112345671');
  await page.getByLabel('Mobile phone').fill('03001234567');
  await page.getByRole('button', { name: 'Add staff member' }).click();
  await expect(page.getByText('A staff member with this CNIC already exists.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open existing staff member' })).toHaveAttribute('href', '/staff/st9');
});

// ---- Details ----

test('details: CNIC locked once a login exists; only changes are sent; a 422 lands on its field', async ({ page }) => {
  const requests = await mockStaffApi(page, {
    me: PRINCIPAL_ME,
    staff: [staffRow('st1', 'Ayesha Malik', { userId: 'u7', systemRoles: ['teacher'] })],
    replies: {
      'PATCH /staff/st1': [
        {
          status: 422,
          body: errorBody('VALIDATION_FAILED', 'Check the highlighted fields.', {
            fields: [{ path: 'designation', code: 'INVALID_VALUE', message: 'Designation is not allowed here.' }],
          }),
        },
      ],
    },
  });
  await page.goto('/staff/st1');
  await expect(page.getByRole('heading', { name: 'Ayesha Malik' })).toBeVisible();
  await expect(page.getByText(/the CNIC is its username, so it cannot be changed/)).toBeVisible();
  await expect(page.getByLabel(/CNIC \(optional\)/)).toHaveCount(0);

  await page.getByLabel('Designation (optional)').fill('Head of maths');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Designation is not allowed here.')).toBeVisible();

  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Staff member saved.')).toBeVisible();
  expect(calls(requests, 'PATCH', '/staff/st1')[1].postDataJSON()).toEqual({ designation: 'Head of maths' });
});

test('details: without staff.update the form is read-only and there is no status control', async ({ page }) => {
  await mockStaffApi(page, { me: OFFICE_ME, staff: [staffRow('st1', 'Ayesha Malik')] });
  await page.goto('/staff/st1');
  await expect(page.getByText('You can view this record but not change it.')).toBeVisible();
  await expect(page.getByLabel('Full name')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Change status' })).toHaveCount(0);
  // Office staff lack class.manage: no assignments tab.
  await expect(page.getByRole('tab', { name: 'Teaching assignments' })).toHaveCount(0);
});

// ---- Status ----

test('status: leaving spells out what ends, then records the reason', async ({ page }) => {
  const requests = await mockStaffApi(page, {
    me: PRINCIPAL_ME,
    staff: [staffRow('st1', 'Ayesha Malik', { userId: 'u7', systemRoles: ['teacher'] })],
  });
  await page.goto('/staff/st1');
  await page.getByRole('button', { name: 'Change status' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change status: Ayesha Malik' });
  await dialog.getByLabel('New status').selectOption('left');
  await expect(dialog.getByText('Every role on their login is ended.')).toBeVisible();
  await expect(dialog.getByText('They are signed out everywhere at once.')).toBeVisible();
  await expect(dialog.getByText(/Re-hiring later restores nothing/)).toBeVisible();
  await dialog.getByLabel('Reason').fill('Resigned at term end');
  await dialog.getByRole('button', { name: 'Mark as left' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Ayesha Malik: status changed to Left.')).toBeVisible();
  expect(calls(requests, 'POST', '/staff/st1/change-status')[0].postDataJSON()).toEqual({
    status: 'left',
    reason: 'Resigned at term end',
  });
});

test('status: LAST_PRINCIPAL is shown inline; hidden on your own record', async ({ page }) => {
  await mockStaffApi(page, {
    me: PRINCIPAL_ME,
    staff: [
      staffRow('st1', 'Imran Principal', { userId: 'u-other', systemRoles: ['principal'] }),
      staffRow('st-me', 'Me Myself', { userId: 'u-principal', systemRoles: ['principal'] }),
    ],
    replies: {
      'POST /staff/st1/change-status': {
        status: 409,
        body: errorBody('LAST_PRINCIPAL', 'The school must keep an active principal.'),
      },
    },
  });
  await page.goto('/staff/st1');
  await page.getByRole('button', { name: 'Change status' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('New status').selectOption('suspended');
  await dialog.getByLabel('Reason').fill('Inquiry pending');
  await dialog.getByRole('button', { name: 'Mark as suspended' }).click();
  await expect(dialog.getByText('This is the school’s only active principal. Appoint another principal first.')).toBeVisible();
  await expect(dialog).toBeVisible();

  await page.goto('/staff/st-me');
  await expect(page.getByText('This is your own record.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change status' })).toHaveCount(0);
});

// ---- Issue login ----

test('issue login: office may give only office staff; an existing login needs a second confirmation', async ({ page }) => {
  const requests = await mockStaffApi(page, {
    me: OFFICE_ME,
    staff: [staffRow('st1', 'Ayesha Malik')],
    replies: {
      'POST /staff/st1/issue-login': [
        {
          status: 409,
          body: errorBody('LINK_EXISTING_LOGIN_UNCONFIRMED', 'A login with this CNIC exists.'),
        },
      ],
    },
  });
  await page.goto('/staff/st1');
  await page.getByRole('tab', { name: 'Login and roles' }).click();
  await page.getByRole('button', { name: 'Issue login' }).click();
  const dialog = page.getByRole('dialog');
  const select = dialog.getByLabel('Role');
  // Office defaults cover office staff only: not teacher (marks, attendance) nor principal.
  await expect(select.locator('option')).toHaveText(['Choose…', 'Office staff']);
  await expect(select).toHaveValue('office_staff');
  // R57: an optional reason; too short is held back, a typed one is sent trimmed.
  const reason = dialog.getByLabel('Reason (optional)');
  await reason.fill('ab');
  await expect(dialog.getByRole('button', { name: 'Issue login' })).toBeDisabled();
  await reason.fill('  New office clerk  ');
  await dialog.getByRole('button', { name: 'Issue login' }).click();

  await expect(dialog.getByText('This CNIC already has a sign-in')).toBeVisible();
  await expect(dialog.getByText('reset its password to the default, their CNIC digits;')).toBeVisible();
  await dialog.getByRole('button', { name: 'Reset and link login' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/Has a login, as Office staff/)).toBeVisible();

  const posts = calls(requests, 'POST', '/staff/st1/issue-login');
  expect(posts.map((r) => r.postDataJSON())).toEqual([
    { systemRole: 'office_staff', reason: 'New office clerk' },
    { systemRole: 'office_staff', confirmLinkExisting: true, reason: 'New office clerk' },
  ]);
});

test('issue login: a refusal is shown in the dialog', async ({ page }) => {
  await mockStaffApi(page, {
    me: PRINCIPAL_ME,
    staff: [staffRow('st1', 'Ayesha Malik')],
    replies: {
      'POST /staff/st1/issue-login': {
        status: 409,
        body: errorBody('USERNAME_IN_USE', 'This CNIC is a student’s login and cannot be linked.'),
      },
    },
  });
  await page.goto('/staff/st1');
  await page.getByRole('tab', { name: 'Login and roles' }).click();
  await page.getByRole('button', { name: 'Issue login' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Role').locator('option')).toHaveText(['Choose…', 'Principal', 'Office staff', 'Teacher']);
  await dialog.getByLabel('Role').selectOption('teacher');
  await dialog.getByRole('button', { name: 'Issue login' }).click();
  await expect(dialog.getByText('This CNIC is a student’s login and cannot be linked.')).toBeVisible();
});

// ---- Roles ----

test('roles: a principal gives a role with a reason; removing the last principal is refused inline', async ({ page }) => {
  const requests = await mockStaffApi(page, {
    me: PRINCIPAL_ME,
    staff: [staffRow('st1', 'Ayesha Malik', { userId: 'u7', systemRoles: ['principal'] })],
    roles: [roleRow('ur1', { systemRole: 'principal', assignedBy: null })],
    replies: {
      'POST /users/u7/roles': { status: 201, body: roleRow('ur2', { systemRole: 'teacher' }) },
      'POST /user-roles/ur1/remove': {
        status: 409,
        body: errorBody('LAST_PRINCIPAL', 'The school must keep an active principal.'),
      },
    },
  });
  await page.goto('/staff/st1');
  await page.getByRole('tab', { name: 'Login and roles' }).click();
  const row = page.getByRole('row', { name: /Principal/ });
  await expect(row.getByText('by the platform')).toBeVisible();
  await expect(row.getByText('Current')).toBeVisible();

  await page.getByRole('button', { name: 'Give a role' }).click();
  const give = page.getByRole('dialog');
  // One select, system roles and active custom roles in two groups (slice-7 §9); held roles are left out.
  await expect(give.getByLabel('Role').locator('option')).toHaveText([
    'Choose…',
    'Office staff',
    'Teacher',
    'Accounts clerk (1 capability)',
  ]);
  await expect(give.locator('optgroup[label="System roles"] option')).toHaveText(['Office staff', 'Teacher']);
  await expect(give.locator('optgroup[label="Custom roles"] option')).toHaveText(['Accounts clerk (1 capability)']);
  await give.getByLabel('Role').selectOption({ label: 'Teacher' });
  await give.getByLabel('Reason').fill('Teaches maths too');
  await give.getByRole('button', { name: 'Give role' }).click();
  await expect(give).toBeHidden();
  expect(calls(requests, 'POST', '/users/u7/roles')[0].postDataJSON()).toEqual({
    systemRole: 'teacher',
    reason: 'Teaches maths too',
  });

  await row.getByRole('button', { name: 'Remove' }).click();
  const remove = page.getByRole('dialog');
  await remove.getByLabel('Reason').fill('Stepping down');
  await remove.getByRole('button', { name: 'Remove role' }).click();
  await expect(remove.getByText('This is the school’s only active principal. Appoint another principal first.')).toBeVisible();
  await remove.getByRole('button', { name: 'Cancel' }).click();
  await expect(remove).toBeHidden();

  await page.getByLabel('Show history').check();
  await expect
    .poll(() => calls(requests, 'GET', '/users/u7/roles').some((r) => new URL(r.url()).searchParams.get('includeEnded') === 'true'))
    .toBe(true);
});

test('roles: without role.manage the roles are listed with no write controls', async ({ page }) => {
  await mockStaffApi(page, {
    me: OFFICE_ME,
    staff: [staffRow('st1', 'Ayesha Malik', { userId: 'u7', systemRoles: ['teacher'] })],
    roles: [roleRow('ur1')],
  });
  await page.goto('/staff/st1');
  await page.getByRole('tab', { name: 'Login and roles' }).click();
  await expect(page.getByRole('row', { name: /Teacher/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Give a role' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Issue login' })).toHaveCount(0);
});

// ---- Assignments ----

test('assignments: a taken section asks before replacing its class teacher', async ({ page }) => {
  const requests = await mockStaffApi(page, {
    me: PRINCIPAL_ME,
    staff: [staffRow('st1', 'Ayesha Malik', { userId: 'u7', systemRoles: ['teacher'] })],
    assignments: [assignment('ta1', { role: 'subject_teacher', subjectId: 'sub-m', subjectName: 'Mathematics', sectionId: null, sectionName: null })],
    replies: {
      'POST /staff/st1/teacher-assignments': [
        {
          status: 409,
          body: errorBody('CLASS_TEACHER_EXISTS', 'This section already has a class teacher.', {
            conflicts: [
              { assignmentId: 'ta9', staffId: 'st9', staffFullName: 'Bilal Ahmed', startsOn: '2026-04-01', endsOn: null },
            ],
          }),
        },
      ],
    },
  });
  await page.goto('/staff/st1');
  await page.getByRole('tab', { name: 'Teaching assignments' }).click();
  const existing = page.getByRole('row', { name: /Mathematics/ });
  await expect(existing.getByText('all sections')).toBeVisible();
  await expect(existing.getByText('Active today')).toBeVisible();

  await page.getByRole('button', { name: 'Add assignment' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Role').selectOption('class_teacher');
  await expect(dialog.getByLabel('Session')).toHaveValue('y1');
  await dialog.getByLabel('Class').selectOption('c5');
  await dialog.getByLabel('Section').selectOption('sec-a');
  await dialog.getByRole('button', { name: 'Add assignment' }).click();

  await expect(dialog.getByText('This section already has a class teacher')).toBeVisible();
  await expect(dialog.getByText('Bilal Ahmed')).toBeVisible();
  await dialog.getByRole('button', { name: 'Replace class teacher' }).click();
  await expect(dialog).toBeHidden();

  const posts = calls(requests, 'POST', '/staff/st1/teacher-assignments').map((r) => r.postDataJSON());
  expect(posts).toEqual([
    { role: 'class_teacher', classId: 'c5', sectionId: 'sec-a' },
    { role: 'class_teacher', classId: 'c5', sectionId: 'sec-a', replaceCurrent: true },
  ]);
});

test('assignments: ending with a reason; a refusal is shown in the dialog', async ({ page }) => {
  const requests = await mockStaffApi(page, {
    me: PRINCIPAL_ME,
    staff: [staffRow('st1', 'Ayesha Malik', { userId: 'u7', systemRoles: ['teacher'] })],
    assignments: [assignment('ta1'), assignment('ta2', { sectionId: 'sec-b', sectionName: 'B' })],
    replies: {
      'POST /teacher-assignments/ta2/end': {
        status: 422,
        body: errorBody('VALIDATION_FAILED', 'Check the highlighted fields.', {
          fields: [{ path: 'endsOn', code: 'INVALID_VALUE', message: 'The last day cannot be after the current one.' }],
        }),
      },
    },
  });
  await page.goto('/staff/st1');
  await page.getByRole('tab', { name: 'Teaching assignments' }).click();

  await page.getByRole('button', { name: 'Actions for Class 5 A' }).click();
  await page.getByRole('menuitem', { name: 'End assignment' }).click();
  let dialog = page.getByRole('dialog', { name: 'End assignment: Class 5 A' });
  await dialog.getByLabel('Reason').fill('Moved to Class 6');
  await dialog.getByRole('button', { name: 'End assignment' }).click();
  await expect(dialog).toBeHidden();
  expect(calls(requests, 'POST', '/teacher-assignments/ta1/end')[0].postDataJSON()).toEqual({ reason: 'Moved to Class 6' });

  await page.getByRole('button', { name: 'Actions for Class 5 B' }).click();
  await page.getByRole('menuitem', { name: 'End assignment' }).click();
  dialog = page.getByRole('dialog', { name: 'End assignment: Class 5 B' });
  await dialog.getByRole('button', { name: 'End assignment' }).click();
  await expect(dialog.getByText('The last day cannot be after the current one.')).toBeVisible();
});
