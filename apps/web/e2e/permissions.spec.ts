import { Capability, SYSTEM_ROLE_DEFAULTS } from '@asms/shared';
import { expect as baseExpect, test, type Page, type Request } from '@playwright/test';
import type { ApiErrorEnvelope } from '../lib/api/errors';
import type { MeDto } from '../lib/api/school-contract';
import type {
  CustomRoleDto,
  GrantDto,
  UserPermissionsDto,
  UserRoleDto,
} from '../lib/api/school-roles-contract';
import type { StaffDto } from '../lib/api/school-staff-contract';

// Custom roles, grants and revokes, the permissions tab (contracts/slice-7.md §9) against a
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
};
const PRINCIPAL_ME: MeDto = {
  ...OFFICE_ME,
  id: 'u-principal',
  fullName: 'Amina Principal',
  roles: ['principal'],
  capabilities: Object.values(Capability).sort(),
};
/** A principal whose payment.verify was revoked: it must not be tickable or grantable. */
const LIMITED_PRINCIPAL_ME: MeDto = {
  ...PRINCIPAL_ME,
  capabilities: PRINCIPAL_ME.capabilities.filter((c) => c !== Capability.PAYMENT_VERIFY),
};
const TEACHER_ME: MeDto = {
  ...OFFICE_ME,
  id: 'u-teacher',
  roles: ['teacher'],
  capabilities: [...SYSTEM_ROLE_DEFAULTS.teacher].sort(),
};

const STAMP = '2026-09-01T05:00:00.000Z';

const customRole = (id: string, name: string, extra: Partial<CustomRoleDto> = {}): CustomRoleDto => ({
  id,
  key: name.toLowerCase().replace(/\W+/g, '_'),
  name,
  status: 'active',
  capabilities: [Capability.PAYMENT_RECORD, Capability.PAYMENT_VERIFY],
  holderCount: 0,
  createdAt: STAMP,
  updatedAt: STAMP,
  ...extra,
});

const staffRow = (id: string, fullName: string, extra: Partial<StaffDto> = {}): StaffDto => ({
  id,
  fullName,
  cnicMasked: '35201-*****-1',
  hasCnic: true,
  phone: '+923001234567',
  designation: 'Accountant',
  joinedOn: '2026-08-01',
  status: 'active',
  userId: 'u7',
  systemRoles: ['office_staff'],
  customRoleNames: [],
  createdAt: STAMP,
  updatedAt: STAMP,
  ...extra,
});

const grantRow = (id: string, extra: Partial<GrantDto> = {}): GrantDto => ({
  id,
  userId: 'u7',
  capability: Capability.PAYMENT_VERIFY,
  effect: 'grant',
  reason: 'Covers the accountant on leave',
  grantedBy: 'u-principal',
  grantedByName: 'Amina Principal',
  grantedAt: STAMP,
  revokedAt: null,
  revokedBy: null,
  revokedByName: null,
  endReason: null,
  ...extra,
});

const officePermissions = (deltas: GrantDto[] = [grantRow('g1')]): UserPermissionsDto => ({
  userId: 'u7',
  staffId: 'st1',
  staffStatus: 'active',
  staffCapacity: true,
  roles: [
    {
      userRoleId: 'ur1',
      systemRole: 'office_staff',
      customRoleId: null,
      customRoleName: null,
      customRoleStatus: null,
      capabilities: [...SYSTEM_ROLE_DEFAULTS.office_staff],
    },
  ],
  deltas,
  effective: [
    {
      capability: Capability.STUDENT_VIEW,
      group: 'students',
      scope: 'all',
      sources: [{ kind: 'system_role', systemRole: 'office_staff', customRoleId: null, customRoleName: null, grantId: null }],
    },
    {
      capability: Capability.PAYMENT_VERIFY,
      group: 'finance',
      scope: 'all',
      sources: [{ kind: 'grant', systemRole: null, customRoleId: null, customRoleName: null, grantId: 'g1' }],
    },
  ],
});

type ErrorBody = ApiErrorEnvelope['error'];
function errorBody(code: ErrorBody['code'], message: string, details: ErrorBody['details'] = null): { error: ErrorBody } {
  return { error: { code, message, details, requestId: 'req-test' } };
}

type Reply = { status: number; body: unknown };
type MockState = {
  me: MeDto;
  roles?: CustomRoleDto[];
  staff?: StaffDto[];
  permissions?: UserPermissionsDto;
  /** Answers the matching `METHOD /path` (once each, in order) instead of the default behaviour. */
  replies?: Record<string, Reply | Reply[]>;
};

const page1 = <T,>(data: T[]) => ({ data, page: 1, limit: 25, total: data.length });

async function mockApi(page: Page, state: MockState) {
  const roles = state.roles ?? [];
  const staff = state.staff ?? [];
  const requests: Request[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    requests.push(request);
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const method = request.method();
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const canned = state.replies?.[`${method} ${path}`];
    if (canned) {
      const reply = Array.isArray(canned) ? canned.shift() : canned;
      if (reply) return json(reply.status, reply.body);
    }

    if (method === 'GET' && path === '/me') return json(200, state.me);
    if (path === '/custom-roles' && method === 'GET') return json(200, page1(roles));
    if (path === '/custom-roles' && method === 'POST') {
      const b = request.postDataJSON() as Pick<CustomRoleDto, 'key' | 'name' | 'capabilities'>;
      const created = customRole('cr-new', b.name, { key: b.key, capabilities: b.capabilities });
      roles.push(created);
      return json(201, created);
    }
    const role = path.match(/^\/custom-roles\/([^/]+)(\/archive)?$/);
    if (role) {
      const found = roles.find((r) => r.id === role[1]);
      if (!found) return json(404, errorBody('NOT_FOUND', 'Not found.'));
      if (!role[2] && method === 'GET') return json(200, found);
      if (!role[2] && method === 'PATCH') {
        const b = request.postDataJSON() as Partial<CustomRoleDto>;
        Object.assign(found, b.name && { name: b.name }, b.capabilities && { capabilities: b.capabilities });
        found.updatedAt = new Date().toISOString();
        return json(200, found);
      }
      if (role[2]) {
        found.status = 'archived';
        found.updatedAt = new Date().toISOString();
        return json(200, found);
      }
    }
    const member = path.match(/^\/staff\/([^/]+)$/);
    if (member && method === 'GET') {
      const found = staff.find((s) => s.id === member[1]);
      return found ? json(200, found) : json(404, errorBody('NOT_FOUND', 'Not found.'));
    }
    if (path === '/users/u7/permissions' && method === 'GET' && state.permissions) {
      return json(200, state.permissions);
    }
    if (path === '/users/u7/grants' && method === 'POST') {
      const b = request.postDataJSON() as Pick<GrantDto, 'capability' | 'effect' | 'reason'>;
      return json(201, grantRow('g-new', b));
    }
    const end = path.match(/^\/grants\/([^/]+)\/end$/);
    if (end && method === 'POST') {
      return json(200, grantRow(end[1], { revokedAt: new Date().toISOString(), revokedBy: 'u-principal' }));
    }
    if (path === '/users/u7/roles' && method === 'GET') return json(200, page1<UserRoleDto>([]));
    if (path === '/users/u7/roles' && method === 'POST') {
      const b = request.postDataJSON() as { customRoleId: string };
      const row: UserRoleDto = {
        id: 'ur-new',
        userId: 'u7',
        systemRole: null,
        customRoleId: b.customRoleId,
        customRoleName: roles.find((r) => r.id === b.customRoleId)?.name ?? null,
        assignedBy: 'u-principal',
        assignedAt: STAMP,
        endedAt: null,
        endedBy: null,
      };
      return json(201, row);
    }
    return json(500, errorBody('INTERNAL_ERROR', `Unmocked ${method} ${path}`));
  });
  return requests;
}

const calls = (requests: Request[], method: string, path: string) =>
  requests.filter((r) => r.method() === method && new URL(r.url()).pathname === `/api/v1${path}`);

// ---- Nav ----

test('nav: office staff see Custom roles; a teacher does not', async ({ page }) => {
  await mockApi(page, { me: OFFICE_ME });
  await page.goto('/account');
  await expect(page.getByRole('link', { name: 'Custom roles' })).toBeVisible();

  await page.unrouteAll();
  await mockApi(page, { me: TEACHER_ME });
  await page.reload();
  await expect(page.getByRole('link', { name: 'Your account' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Custom roles' })).toHaveCount(0);
});

// ---- List ----

test('list: rows, active by default; office staff read without write controls', async ({ page }) => {
  const requests = await mockApi(page, {
    me: OFFICE_ME,
    roles: [customRole('cr1', 'Accounts clerk', { holderCount: 2 })],
  });
  await page.goto('/custom-roles');
  const row = page.getByRole('row', { name: /Accounts clerk/ });
  await expect(row.getByText('accounts_clerk')).toBeVisible();
  await expect(row.getByText('2 people')).toBeVisible();
  await expect(row.getByText('Active')).toBeVisible();
  expect(new URL(calls(requests, 'GET', '/custom-roles')[0].url()).searchParams.get('status')).toBe('active');
  await expect(page.getByRole('link', { name: 'New custom role' })).toHaveCount(0);

  await page.getByLabel('Status').selectOption('');
  await expect
    .poll(() => calls(requests, 'GET', '/custom-roles').some((r) => !new URL(r.url()).searchParams.has('status')))
    .toBe(true);
});

test('list: empty state, and the no-permission state on 403', async ({ page }) => {
  await mockApi(page, { me: PRINCIPAL_ME });
  await page.goto('/custom-roles');
  await expect(page.getByText('No custom roles yet')).toBeVisible();
  await expect(page.getByRole('link', { name: 'New custom role' })).toBeVisible();

  await page.unrouteAll();
  await mockApi(page, {
    me: TEACHER_ME,
    replies: { 'GET /custom-roles': { status: 403, body: errorBody('PERMISSION_DENIED', 'Not allowed.') } },
  });
  await page.reload();
  await expect(page.getByText('You do not have access')).toBeVisible();
});

// ---- Create ----

test('create: role.manage is never offered; a key not held is disabled with a reason; body sent', async ({ page }) => {
  const requests = await mockApi(page, { me: LIMITED_PRINCIPAL_ME });
  await page.goto('/custom-roles/new');
  await expect(page.getByRole('heading', { name: 'New custom role' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Manage roles and permissions/ })).toHaveCount(0);
  const verify = page.getByRole('checkbox', { name: /Verify payments/ });
  await expect(verify).toBeDisabled();
  await expect(page.getByText('You do not hold this, so you cannot add it.')).toBeVisible();

  await page.getByLabel('Key').fill('Accounts');
  await page.getByLabel('Name').fill('Accounts clerk');
  await page.getByRole('button', { name: 'Create role' }).click();
  await expect(page.getByText(/Use 2–32 lower-case letters/)).toBeVisible();

  // An identity number never reaches the audit log through a key (shared customRoleKeyProblem).
  await page.getByLabel('Key').fill('clerk_3520112345671');
  await page.getByRole('button', { name: 'Create role' }).click();
  await expect(page.getByText(/cannot contain 13 digits in a row/)).toBeVisible();
  expect(calls(requests, 'POST', '/custom-roles')).toHaveLength(0);

  await page.getByLabel('Key').fill('accounts_clerk');
  await page.getByRole('checkbox', { name: /Record payments/ }).check();
  await page.getByRole('checkbox', { name: /View fee statements/ }).check();
  await page.getByRole('button', { name: 'Create role' }).click();
  await expect(page).toHaveURL(/\/custom-roles\/cr-new$/);
  await expect(page.getByRole('heading', { name: 'Accounts clerk' })).toBeVisible();
  expect(calls(requests, 'POST', '/custom-roles')[0].postDataJSON()).toEqual({
    key: 'accounts_clerk',
    name: 'Accounts clerk',
    // Registry order, whatever the click order.
    capabilities: [Capability.PAYMENT_RECORD, Capability.FEE_STATEMENT_VIEW],
  });
});

test('create: CUSTOM_ROLE_KEY_TAKEN lands on the key; capability_not_held is spelt out', async ({ page }) => {
  await mockApi(page, {
    me: PRINCIPAL_ME,
    replies: {
      'POST /custom-roles': [
        {
          status: 409,
          body: errorBody('CUSTOM_ROLE_KEY_TAKEN', 'Key in use.', { customRoleId: 'cr9' }),
        },
        {
          status: 403,
          body: errorBody('PERMISSION_DENIED', 'Not allowed.', {
            reason: 'capability_not_held',
            capabilities: [Capability.PAYMENT_VERIFY],
          }),
        },
      ],
    },
  });
  await page.goto('/custom-roles/new');
  await page.getByLabel('Key').fill('accounts_clerk');
  await page.getByLabel('Name').fill('Accounts clerk');
  await page.getByRole('checkbox', { name: /Verify payments/ }).check();
  await page.getByRole('button', { name: 'Create role' }).click();
  await expect(page.getByText('An active custom role already uses this key.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open the role using this key' })).toHaveAttribute(
    'href',
    '/custom-roles/cr9',
  );

  await page.getByRole('button', { name: 'Create role' }).click();
  await expect(page.getByText('You can only give capabilities you hold yourself: Verify payments.')).toBeVisible();
});

test('create: without role.manage the screen is refused', async ({ page }) => {
  await mockApi(page, { me: OFFICE_ME });
  await page.goto('/custom-roles/new');
  await expect(page.getByText('You do not have access')).toBeVisible();
});

// ---- Edit and archive ----

test('edit: adding sends no reason; removing asks for one and sends the full set', async ({ page }) => {
  const requests = await mockApi(page, {
    me: PRINCIPAL_ME,
    roles: [customRole('cr1', 'Accounts clerk', { holderCount: 3 })],
  });
  await page.goto('/custom-roles/cr1');
  await expect(page.getByRole('heading', { name: 'Accounts clerk' })).toBeVisible();
  await expect(page.getByText(/held by 3 people/)).toBeVisible();

  await page.getByRole('checkbox', { name: /Void payments/ }).check();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/Accounts clerk saved/)).toBeVisible();
  expect(calls(requests, 'PATCH', '/custom-roles/cr1')[0].postDataJSON()).toEqual({
    capabilities: [Capability.PAYMENT_RECORD, Capability.PAYMENT_VERIFY, Capability.PAYMENT_VOID],
  });

  await page.getByRole('checkbox', { name: /Verify payments/ }).uncheck();
  await page.getByRole('button', { name: 'Save changes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove capabilities from this role?' });
  await expect(dialog.getByText('its 3 holders', { exact: false })).toBeVisible();
  await expect(dialog.getByRole('listitem')).toHaveText(['Verify payments']);
  await dialog.getByLabel('Reason').fill('Verification moves to the principal');
  await dialog.getByRole('button', { name: 'Save and remove' }).click();
  await expect(dialog).toBeHidden();
  expect(calls(requests, 'PATCH', '/custom-roles/cr1')[1].postDataJSON()).toEqual({
    capabilities: [Capability.PAYMENT_RECORD, Capability.PAYMENT_VOID],
    reason: 'Verification moves to the principal',
  });
});

test('edit: a key the editor lacks is editable when already in the role, disabled otherwise', async ({ page }) => {
  await mockApi(page, {
    me: LIMITED_PRINCIPAL_ME,
    roles: [
      customRole('cr1', 'Accounts clerk'),
      customRole('cr2', 'Fee counter', { capabilities: [Capability.PAYMENT_RECORD] }),
    ],
  });
  await page.goto('/custom-roles/cr1');
  // Already in the role: R94 checks added keys only.
  await expect(page.getByRole('checkbox', { name: /Verify payments/ })).toBeEnabled();
  await page.goto('/custom-roles/cr2');
  await expect(page.getByRole('heading', { name: 'Fee counter' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Verify payments/ })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: /Void payments/ })).toBeEnabled();
});

test('edit: CUSTOM_ROLE_ARCHIVED is shown; an archived role is read-only', async ({ page }) => {
  await mockApi(page, {
    me: PRINCIPAL_ME,
    roles: [customRole('cr1', 'Accounts clerk'), customRole('cr2', 'Old role', { status: 'archived' })],
    replies: {
      'PATCH /custom-roles/cr1': { status: 409, body: errorBody('CUSTOM_ROLE_ARCHIVED', 'Archived.') },
    },
  });
  await page.goto('/custom-roles/cr1');
  await page.getByLabel('Name').fill('Accounts clerk (senior)');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('This custom role is archived. It can no longer be changed or given.')).toBeVisible();

  await page.goto('/custom-roles/cr2');
  await expect(page.getByText(/This role is archived/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Archive' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: /Record payments/ })).toBeDisabled();
});

test('edit: a missing role shows not found; office staff see it read-only', async ({ page }) => {
  await mockApi(page, { me: OFFICE_ME, roles: [customRole('cr1', 'Accounts clerk')] });
  await page.goto('/custom-roles/nope');
  await expect(page.getByText('Custom role not found')).toBeVisible();
  await page.goto('/custom-roles/cr1');
  await expect(page.getByText('You can view this role but not change it.')).toBeVisible();
  await expect(page.getByLabel('Name')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Archive' })).toHaveCount(0);
});

test('archive: CUSTOM_ROLE_IN_USE shows the holder count; then archives with a reason', async ({ page }) => {
  const requests = await mockApi(page, {
    me: PRINCIPAL_ME,
    roles: [customRole('cr1', 'Accounts clerk')],
    replies: {
      'POST /custom-roles/cr1/archive': [
        { status: 409, body: errorBody('CUSTOM_ROLE_IN_USE', 'In use.', { holderCount: 2 }) },
      ],
    },
  });
  await page.goto('/custom-roles/cr1');
  await page.getByRole('button', { name: 'Archive' }).click();
  const dialog = page.getByRole('dialog', { name: 'Archive Accounts clerk?' });
  await dialog.getByLabel('Reason').fill('No longer used');
  await dialog.getByRole('button', { name: 'Archive role' }).click();
  await expect(dialog.getByText(/^2 people hold this role/)).toBeVisible();

  await dialog.getByRole('button', { name: 'Archive role' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Accounts clerk archived.')).toBeVisible();
  expect(calls(requests, 'POST', '/custom-roles/cr1/archive')[1].postDataJSON()).toEqual({ reason: 'No longer used' });
});

// ---- Staff member → Permissions ----

test('permissions: three columns with who, why, when, source and scope', async ({ page }) => {
  await mockApi(page, {
    me: PRINCIPAL_ME,
    staff: [staffRow('st1', 'Bilal Accountant')],
    permissions: officePermissions(),
  });
  await page.goto('/staff/st1');
  await page.getByRole('tab', { name: 'Permissions' }).click();

  const defaults = page.getByRole('region', { name: /Role defaults/ });
  await expect(defaults.getByText('Office staff', { exact: true })).toBeVisible();
  await expect(defaults.getByText(`${SYSTEM_ROLE_DEFAULTS.office_staff.length} capabilities`)).toBeVisible();

  const deltas = page.getByRole('region', { name: /Grants and revokes/ });
  const grant = deltas.getByRole('listitem', { name: 'Grant: Verify payments' });
  await expect(grant.getByText('“Covers the accountant on leave”')).toBeVisible();
  await expect(grant.getByText(/By Amina Principal · 1 Sept 2026/)).toBeVisible();
  await expect(grant.getByRole('button', { name: 'End' })).toBeVisible();

  const effective = page.getByRole('region', { name: /In force/ });
  const line = effective.getByRole('listitem', { name: 'Verify payments' });
  await expect(line.getByText('Whole school')).toBeVisible();
  await expect(line.getByText('From Granted')).toBeVisible();
  await expect(effective.getByRole('listitem', { name: 'View students' }).getByText('From Office staff')).toBeVisible();
});

test('permissions: hidden for office staff and on your own record; 403 shows no access', async ({ page }) => {
  await mockApi(page, {
    me: OFFICE_ME,
    staff: [staffRow('st1', 'Bilal Accountant'), staffRow('st-me', 'Me', { userId: 'u-principal' })],
  });
  await page.goto('/staff/st1');
  await expect(page.getByRole('tab', { name: 'Login and roles' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Permissions' })).toHaveCount(0);

  await page.unrouteAll();
  await mockApi(page, {
    me: PRINCIPAL_ME,
    staff: [staffRow('st1', 'Bilal Accountant'), staffRow('st-me', 'Me', { userId: 'u-principal' })],
    replies: {
      'GET /users/u7/permissions': { status: 403, body: errorBody('PERMISSION_DENIED', 'Not allowed.') },
    },
  });
  await page.goto('/staff/st-me');
  await expect(page.getByRole('heading', { name: 'Me' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Permissions' })).toHaveCount(0);

  await page.goto('/staff/st1');
  await page.getByRole('tab', { name: 'Permissions' }).click();
  await expect(page.getByText('You do not have access')).toBeVisible();
});

test('permissions: grant picker lists only held keys; sends the body; GRANT_EXISTS counts as done', async ({ page }) => {
  const requests = await mockApi(page, {
    me: LIMITED_PRINCIPAL_ME,
    staff: [staffRow('st1', 'Bilal Accountant')],
    permissions: officePermissions([]),
    replies: {
      'POST /users/u7/grants': [
        { status: 201, body: grantRow('g2', { capability: Capability.PAYMENT_VOID }) },
        { status: 409, body: errorBody('GRANT_EXISTS', 'Exists.', { grantId: 'g2' }) },
      ],
    },
  });
  await page.goto('/staff/st1');
  await page.getByRole('tab', { name: 'Permissions' }).click();
  await expect(page.getByText('No grants or revokes')).toBeVisible();

  await page.getByRole('button', { name: 'Grant or revoke' }).click();
  const dialog = page.getByRole('dialog', { name: 'Grant or revoke for Bilal Accountant' });
  const picker = dialog.getByLabel('Capability');
  await expect(picker.locator('option', { hasText: 'Verify payments' })).toHaveCount(0);
  await expect(picker.locator('option', { hasText: 'Manage roles and permissions' })).toHaveCount(0);
  await picker.selectOption(Capability.PAYMENT_VOID);
  await dialog.getByLabel('Reason').fill('Handles refunds');
  await dialog.getByRole('button', { name: 'Grant', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Granted “Void payments” for Bilal Accountant.')).toBeVisible();
  expect(calls(requests, 'POST', '/users/u7/grants')[0].postDataJSON()).toEqual({
    capability: Capability.PAYMENT_VOID,
    effect: 'grant',
    reason: 'Handles refunds',
  });

  // A resubmit after a lost response: the row exists, so the dialog closes.
  await page.getByRole('button', { name: 'Grant or revoke' }).click();
  await dialog.getByLabel('Change').selectOption('revoke');
  await dialog.getByLabel('Capability').selectOption(Capability.PAYMENT_RECORD);
  await dialog.getByLabel('Reason').fill('Not on the counter any more');
  await dialog.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Bilal Accountant already has this change in force.')).toBeVisible();
});

test('permissions: refusals STAFF_NOT_ACTIVE, SELF_ACTION_FORBIDDEN, capability_not_held stay in the dialog', async ({ page }) => {
  await mockApi(page, {
    me: PRINCIPAL_ME,
    staff: [staffRow('st1', 'Bilal Accountant')],
    permissions: officePermissions([]),
    replies: {
      'POST /users/u7/grants': [
        { status: 409, body: errorBody('STAFF_NOT_ACTIVE', 'No.', { reason: 'no_staff_role' }) },
        { status: 409, body: errorBody('SELF_ACTION_FORBIDDEN', 'No.') },
        {
          status: 403,
          body: errorBody('PERMISSION_DENIED', 'No.', {
            reason: 'capability_not_held',
            capabilities: [Capability.PAYMENT_VERIFY],
          }),
        },
      ],
    },
  });
  await page.goto('/staff/st1');
  await page.getByRole('tab', { name: 'Permissions' }).click();
  await page.getByRole('button', { name: 'Grant or revoke' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Capability').selectOption(Capability.PAYMENT_VERIFY);
  await dialog.getByLabel('Reason').fill('Cover for leave');
  const grant = dialog.getByRole('button', { name: 'Grant', exact: true });
  await grant.click();
  await expect(dialog.getByText('This person has no staff role at present. Give them a role first.')).toBeVisible();
  await grant.click();
  await expect(dialog.getByText('You cannot change your own permissions. Ask another principal.')).toBeVisible();
  await grant.click();
  await expect(dialog.getByText('You can only give capabilities you hold yourself: Verify payments.')).toBeVisible();
  await expect(dialog).toBeVisible();
});

test('permissions: ending a grant asks for a reason; a key the caller lacks cannot be ended', async ({ page }) => {
  const requests = await mockApi(page, {
    me: PRINCIPAL_ME,
    staff: [staffRow('st1', 'Bilal Accountant')],
    permissions: officePermissions(),
  });
  await page.goto('/staff/st1');
  await page.getByRole('tab', { name: 'Permissions' }).click();
  await page.getByRole('listitem', { name: 'Grant: Verify payments' }).getByRole('button', { name: 'End' }).click();
  const dialog = page.getByRole('dialog', { name: 'End the grant of “Verify payments”?' });
  await dialog.getByLabel('Reason').fill('Accountant is back');
  await dialog.getByRole('button', { name: 'End' }).click();
  await expect(dialog).toBeHidden();
  expect(calls(requests, 'POST', '/grants/g1/end')[0].postDataJSON()).toEqual({ reason: 'Accountant is back' });

  await page.unrouteAll();
  await mockApi(page, {
    me: LIMITED_PRINCIPAL_ME,
    staff: [staffRow('st1', 'Bilal Accountant')],
    permissions: officePermissions(),
  });
  await page.reload();
  await page.getByRole('tab', { name: 'Permissions' }).click();
  const row = page.getByRole('listitem', { name: 'Grant: Verify payments' });
  await expect(row.getByText('Only someone who holds this capability can end it.')).toBeVisible();
  await expect(row.getByRole('button', { name: 'End' })).toHaveCount(0);
});

test('permissions: a suspended member shows nothing in force and no add control', async ({ page }) => {
  await mockApi(page, {
    me: PRINCIPAL_ME,
    staff: [staffRow('st1', 'Bilal Accountant', { status: 'suspended' })],
    permissions: { ...officePermissions(), staffStatus: 'suspended', staffCapacity: false, effective: [] },
  });
  await page.goto('/staff/st1');
  await page.getByRole('tab', { name: 'Permissions' }).click();
  await expect(page.getByText(/This staff member is not active, so nothing is in force/)).toBeVisible();
  await expect(page.getByText('Nothing in force')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Grant or revoke' })).toHaveCount(0);
});

test('permissions: three columns at 1280 px, stacked without sideways scroll on a tablet', async ({ page }) => {
  await mockApi(page, {
    me: PRINCIPAL_ME,
    staff: [staffRow('st1', 'Bilal Accountant')],
    permissions: officePermissions(),
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/staff/st1');
  await page.getByRole('tab', { name: 'Permissions' }).click();
  const tops = async () =>
    Promise.all(
      ['Role defaults', 'Grants and revokes', 'In force'].map(async (name) =>
        Math.round((await page.getByRole('region', { name: new RegExp(name) }).boundingBox())?.y ?? -1),
      ),
    );
  await expect(page.getByRole('region', { name: /In force/ })).toBeVisible();
  const wide = await tops();
  expect(new Set(wide).size).toBe(1);

  await page.setViewportSize({ width: 820, height: 1180 });
  await expect.poll(async () => new Set(await tops()).size).toBe(3);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

// ---- Staff member → Login and roles: one "Give a role" dialog ----

test('assign: a custom role is given from the one role select; CUSTOM_ROLE_ARCHIVED refetches the choices', async ({ page }) => {
  const requests = await mockApi(page, {
    me: PRINCIPAL_ME,
    staff: [staffRow('st1', 'Bilal Accountant')],
    roles: [customRole('cr1', 'Accounts clerk')],
    replies: {
      'POST /users/u7/roles': [{ status: 409, body: errorBody('CUSTOM_ROLE_ARCHIVED', 'Archived.') }],
    },
  });
  await page.goto('/staff/st1');
  await page.getByRole('tab', { name: 'Login and roles' }).click();
  await expect(page.getByRole('button', { name: 'Give a custom role' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Give a role' }).click();
  const dialog = page.getByRole('dialog', { name: 'Give a role to Bilal Accountant' });
  const select = dialog.getByLabel('Role');
  await expect(select.locator('optgroup[label="System roles"] option')).toHaveText(['Principal', 'Teacher']);
  await expect(select.locator('optgroup[label="Custom roles"] option')).toHaveText(['Accounts clerk (2 capabilities)']);
  await select.selectOption({ label: 'Accounts clerk (2 capabilities)' });
  await dialog.getByLabel('Reason').fill('Takes over the fee counter');
  const listCalls = calls(requests, 'GET', '/custom-roles').length;
  await dialog.getByRole('button', { name: 'Give role' }).click();
  await expect(dialog.getByText('This custom role is archived. It can no longer be changed or given.')).toBeVisible();
  await expect.poll(() => calls(requests, 'GET', '/custom-roles').length).toBeGreaterThan(listCalls);

  await dialog.getByRole('button', { name: 'Give role' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Bilal Accountant now holds Accounts clerk.')).toBeVisible();
  const body = calls(requests, 'POST', '/users/u7/roles')[1].postDataJSON();
  expect(body).toEqual({ customRoleId: 'cr1', reason: 'Takes over the fee counter' });
  expect(new URL(calls(requests, 'GET', '/custom-roles')[0].url()).searchParams.get('status')).toBe('active');
});

test('assign: ROLE_ALREADY_ASSIGNED counts as done', async ({ page }) => {
  await mockApi(page, {
    me: PRINCIPAL_ME,
    staff: [staffRow('st1', 'Bilal Accountant')],
    roles: [customRole('cr1', 'Accounts clerk')],
    replies: {
      'POST /users/u7/roles': { status: 409, body: errorBody('ROLE_ALREADY_ASSIGNED', 'Held.') },
    },
  });
  await page.goto('/staff/st1');
  await page.getByRole('tab', { name: 'Login and roles' }).click();
  await page.getByRole('button', { name: 'Give a role' }).click();
  const dialog = page.getByRole('dialog', { name: 'Give a role to Bilal Accountant' });
  await dialog.getByLabel('Role').selectOption({ label: 'Accounts clerk (2 capabilities)' });
  await dialog.getByLabel('Reason').fill('Takes over the fee counter');
  await dialog.getByRole('button', { name: 'Give role' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Bilal Accountant already holds this role.')).toBeVisible();
});

test('stale view: removing a role refetches the permissions view', async ({ page }) => {
  const userRole: UserRoleDto = {
    id: 'ur1',
    userId: 'u7',
    systemRole: 'office_staff',
    customRoleId: null,
    customRoleName: null,
    assignedBy: 'u-principal',
    assignedAt: STAMP,
    endedAt: null,
    endedBy: null,
  };
  const before = officePermissions([]);
  const after: UserPermissionsDto = { ...before, staffCapacity: false, roles: [], effective: [] };
  const requests = await mockApi(page, {
    me: PRINCIPAL_ME,
    staff: [staffRow('st1', 'Bilal Accountant')],
    replies: {
      'GET /users/u7/roles': { status: 200, body: page1([userRole]) },
      'POST /user-roles/ur1/remove': { status: 200, body: { ...userRole, endedAt: STAMP, endedBy: 'u-principal' } },
      'GET /users/u7/permissions': [
        { status: 200, body: before },
        { status: 200, body: after },
      ],
    },
  });
  await page.goto('/staff/st1');
  await page.getByRole('tab', { name: 'Permissions' }).click();
  await expect(page.getByRole('region', { name: /Role defaults/ }).getByText('Office staff', { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'Login and roles' }).click();
  await page.getByRole('row', { name: /Office staff/ }).getByRole('button', { name: 'Remove' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason').fill('Moved to teaching');
  await dialog.getByRole('button', { name: 'Remove role' }).click();
  await expect(dialog).toBeHidden();

  // Well inside the 30 s staleTime: only the invalidation makes this refetch.
  await page.getByRole('tab', { name: 'Permissions' }).click();
  await expect(page.getByText('This login carries no staff role at present, so nothing is in force.')).toBeVisible();
  await expect(page.getByRole('region', { name: /Role defaults/ }).getByText('No role')).toBeVisible();
  expect(calls(requests, 'GET', '/users/u7/permissions').length).toBeGreaterThanOrEqual(2);
});

test('permissions: a principal has no grant or revoke action, and says why', async ({ page }) => {
  await mockApi(page, {
    me: PRINCIPAL_ME,
    staff: [staffRow('st1', 'Zara Deputy', { systemRoles: ['principal'] })],
    permissions: {
      ...officePermissions([]),
      roles: [
        {
          userRoleId: 'ur1',
          systemRole: 'principal',
          customRoleId: null,
          customRoleName: null,
          customRoleStatus: null,
          capabilities: Object.values(Capability),
        },
      ],
    },
  });
  await page.goto('/staff/st1');
  await page.getByRole('tab', { name: 'Permissions' }).click();
  await expect(
    page.getByText('Principals hold every permission; their permissions cannot be changed individually.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Grant or revoke' })).toHaveCount(0);
});

test('permissions: granting a key held for assigned sections warns it becomes school-wide', async ({ page }) => {
  const teacherScoped: UserPermissionsDto = {
    ...officePermissions([]),
    effective: [
      {
        capability: Capability.MARKS_ENTER,
        group: 'academics',
        scope: 'assigned_sections',
        sources: [{ kind: 'system_role', systemRole: 'teacher', customRoleId: null, customRoleName: null, grantId: null }],
      },
    ],
  };
  await mockApi(page, {
    me: PRINCIPAL_ME,
    staff: [staffRow('st1', 'Bilal Accountant')],
    permissions: teacherScoped,
  });
  await page.goto('/staff/st1');
  await page.getByRole('tab', { name: 'Permissions' }).click();
  await page.getByRole('button', { name: 'Grant or revoke' }).click();
  const dialog = page.getByRole('dialog');
  const warning = dialog.getByText(/A grant gives it to them for the whole school/);
  await dialog.getByLabel('Capability').selectOption(Capability.MARKS_ENTER);
  await expect(warning).toBeVisible();
  await dialog.getByLabel('Change').selectOption('revoke');
  await expect(warning).toHaveCount(0);
  await dialog.getByLabel('Change').selectOption('grant');
  await dialog.getByLabel('Capability').selectOption(Capability.PAYMENT_VOID);
  await expect(warning).toHaveCount(0);
});

test('custom-role-only staff: the login card names the custom role', async ({ page }) => {
  await mockApi(page, {
    me: PRINCIPAL_ME,
    staff: [staffRow('st1', 'Bilal Accountant', { systemRoles: [], customRoleNames: ['Accounts clerk'] })],
  });
  await page.goto('/staff/st1');
  await page.getByRole('tab', { name: 'Login and roles' }).click();
  await expect(page.getByText('Has a login, as Accounts clerk.')).toBeVisible();
});
