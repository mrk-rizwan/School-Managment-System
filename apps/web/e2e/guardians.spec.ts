import { Capability, SYSTEM_ROLE_DEFAULTS } from '@asms/shared';
import { expect as baseExpect, test, type Page, type Request } from '@playwright/test';
import type { ApiErrorEnvelope } from '../lib/api/errors';
import type { MeDto, UserDto } from '../lib/api/school-contract';
import type {
  GuardianDetailDto,
  GuardianLookupResultDto,
} from '../lib/api/school-guardians-contract';

// Guardian screens (contracts/slice-5.md §6) against a mocked API: every /api/v1/* request is
// answered in the browser by page.route. Payload and error types are the
// generated OpenAPI types (via the contract files).

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
const guardian = (id: string, fullName: string, extra: Partial<GuardianDetailDto> = {}): GuardianDetailDto => ({
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
  email: null,
  address: null,
  ...extra,
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
  guardians?: GuardianDetailDto[];
  lookup?: GuardianLookupResultDto;
  /** Answers the matching `METHOD /path` instead of the default behaviour. */
  replies?: Record<string, Reply>;
};

async function mockGuardiansApi(page: Page, state: MockState) {
  const guardians = state.guardians ?? [];
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
    if (canned) return json(canned.status, canned.body);

    if (method === 'GET' && path === '/me') return json(200, state.me);
    if (path === '/guardians' && method === 'GET') {
      return json(200, { data: guardians, page: 1, limit: 25, total: guardians.length });
    }
    if (path === '/guardians' && method === 'POST') {
      const b = request.postDataJSON() as Partial<GuardianDetailDto>;
      const created = guardian('g-new', b.fullName ?? '', {
        cnicMasked: null,
        hasCnic: false,
        phone: b.phone ?? null,
        hasPhone: Boolean(b.phone),
        contactCapability: b.contactCapability,
      });
      guardians.push(created);
      return json(201, created);
    }
    if (path === '/guardians/lookup' && method === 'POST') {
      return json(200, state.lookup ?? { data: [], truncated: false });
    }
    const match = path.match(/^\/guardians\/([^/]+)(?:\/(students|issue-login))?$/);
    if (match) {
      const found = guardians.find((g) => g.id === match[1]);
      if (!found) return json(404, errorBody('NOT_FOUND', 'Not found.'));
      if (!match[2] && method === 'GET') return json(200, found);
      if (!match[2] && method === 'PATCH') {
        Object.assign(found, request.postDataJSON(), { updatedAt: new Date().toISOString() });
        return json(200, found);
      }
      if (match[2] === 'students') return json(200, { data: [], page: 1, limit: 25, total: 0 });
      if (match[2] === 'issue-login' && method === 'POST') {
        found.userId = 'u-new';
        found.updatedAt = new Date().toISOString();
        const user: UserDto = {
          id: 'u-new',
          staffId: null,
          guardianId: found.id,
          studentId: null,
          fullName: found.fullName,
          systemRoles: [],
          customRoleNames: [],
          status: 'active',
          emailMasked: null,
          hasEmail: false,
          hasVerifiedEmail: false,
          passwordIsDefault: true,
          lastLoginAt: null,
          createdAt: STAMP,
        };
        return json(201, user);
      }
    }
    return json(500, errorBody('INTERNAL_ERROR', `Unmocked ${method} ${path}`));
  });
  return requests;
}

const calls = (requests: Request[], method: string, path: string) =>
  requests.filter((r) => r.method() === method && new URL(r.url()).pathname === `/api/v1${path}`);

// ---- List and lookup ----

test('list shows the flags; a CNIC typed in search goes to the lookup, never to the list', async ({
  page,
}) => {
  const requests = await mockGuardiansApi(page, {
    me: OFFICE_ME,
    guardians: [
      guardian('g1', 'Ahmed Khan'),
      guardian('g2', 'Bushra Bibi', { cnicMasked: null, hasCnic: false, phone: null, hasPhone: false, contactCapability: 'keypad' }),
    ],
    lookup: {
      data: [
        {
          guardian: guardian('g1', 'Ahmed Khan'),
          resolvedFromId: 'g0',
          students: [{ studentId: 's1', fullName: 'Ali', className: 'Class 5', relationship: 'father' }],
        },
      ],
      truncated: false,
    },
  });

  await page.goto('/guardians');
  const table = page.getByRole('table');
  await expect(table.getByRole('link', { name: 'Ahmed Khan' })).toBeVisible();
  const bushra = table.getByRole('row', { name: /Bushra Bibi/ });
  await expect(bushra.getByText('No CNIC')).toBeVisible();
  await expect(bushra.getByText('No phone')).toBeVisible();
  await expect(bushra.getByText('Keypad phone')).toBeVisible();
  expect(new URL(calls(requests, 'GET', '/guardians')[0].url()).searchParams.get('status')).toBe('active');

  await page.getByLabel('Search').fill('35201-1234567-1');
  await page.getByRole('button', { name: 'Use Find by CNIC' }).click();
  await expect(page.getByLabel('Search')).toHaveValue('');

  const dialog = page.getByRole('dialog', { name: 'Find guardian' });
  await expect(dialog.getByLabel('CNIC')).toHaveValue('35201-1234567-1');
  await dialog.getByRole('button', { name: 'Search' }).click();
  await expect(dialog.getByText('— father of Ali, Class 5')).toBeVisible();
  await expect(dialog.getByText('The matching record was merged into this one.')).toBeVisible();
  // The digits are cleared as soon as the request is sent.
  await expect(dialog.getByLabel('CNIC')).toHaveValue('');
  expect(calls(requests, 'POST', '/guardians/lookup')[0].postDataJSON()).toEqual({ cnic: '3520112345671' });

  // No list request ever carried the identity number.
  for (const r of calls(requests, 'GET', '/guardians')) {
    expect(new URL(r.url()).searchParams.get('q') ?? '').not.toMatch(/\d{5}/);
  }
});

test('a user without guardian.manage gets the no-permission state', async ({ page }) => {
  await mockGuardiansApi(page, {
    me: TEACHER_ME,
    replies: { 'GET /guardians': { status: 403, body: errorBody('PERMISSION_DENIED', 'Not allowed.') } },
  });
  await page.goto('/guardians');
  await expect(page.getByText('You do not have access')).toBeVisible();
  await expect(page.getByRole('link', { name: 'New guardian' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Find by CNIC or phone' })).toHaveCount(0);
});

// ---- Create ----

test('create: a user without guardian.manage gets the no-permission state, not the form', async ({
  page,
}) => {
  await mockGuardiansApi(page, { me: TEACHER_ME });
  await page.goto('/guardians/new');
  await expect(page.getByText('You do not have access')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'New guardian' })).toBeVisible();
  await expect(page.getByLabel('Full name')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add guardian' })).toHaveCount(0);
});

test('create: contact capability is required; a shared phone is shown before creating', async ({
  page,
}) => {
  const requests = await mockGuardiansApi(page, {
    me: OFFICE_ME,
    guardians: [guardian('g1', 'Ahmed Khan')],
    lookup: {
      data: [{ guardian: guardian('g1', 'Ahmed Khan'), resolvedFromId: null, students: [] }],
      truncated: false,
    },
  });

  await page.goto('/guardians/new');
  await page.getByLabel('Full name').fill('Fatima Khan');
  await page.getByLabel('Mobile phone (optional)').fill('0300 1234567');
  await expect(page.getByText('Will be saved as +923001234567.')).toBeVisible();
  await page.getByRole('button', { name: 'Add guardian' }).click();
  await expect(page.getByText('Choose how this guardian can be reached.')).toBeVisible();
  expect(calls(requests, 'POST', '/guardians/lookup')).toHaveLength(0);

  await page.getByRole('radio', { name: /WhatsApp/ }).check();
  await page.getByRole('button', { name: 'Add guardian' }).click();
  await expect(page.getByText('A guardian already uses this phone number.')).toBeVisible();
  expect(calls(requests, 'POST', '/guardians/lookup')[0].postDataJSON()).toEqual({ phone: '+923001234567' });
  expect(calls(requests, 'POST', '/guardians')).toHaveLength(0);

  await page.getByRole('button', { name: 'Add as a different person' }).click();
  await expect(page).toHaveURL(/\/guardians\/g-new$/);
  expect(calls(requests, 'POST', '/guardians')[0].postDataJSON()).toEqual({
    fullName: 'Fatima Khan',
    cnic: null,
    phone: '0300 1234567',
    email: null,
    contactCapability: 'whatsapp',
    address: null,
  });
  await expect(page.getByRole('heading', { name: 'Fatima Khan' })).toBeVisible();
});

test('create: an existing CNIC offers to open that guardian', async ({ page }) => {
  const requests = await mockGuardiansApi(page, {
    me: OFFICE_ME,
    replies: {
      'POST /guardians': {
        status: 409,
        body: errorBody('GUARDIAN_CNIC_EXISTS', 'A guardian with this CNIC already exists.', {
          guardianId: 'g9',
        }),
      },
    },
  });

  await page.goto('/guardians/new');
  await page.getByLabel('Full name').fill('Ahmed Khan');
  // Typed without dashes; the field adds them.
  await page.getByLabel('CNIC (optional)').fill('3520112345671');
  await expect(page.getByLabel('CNIC (optional)')).toHaveValue('35201-1234567-1');
  await page.getByRole('radio', { name: /Keypad phone/ }).check();
  await page.getByRole('button', { name: 'Add guardian' }).click();

  await expect(page.getByText('A guardian with this CNIC already exists.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open existing guardian' })).toHaveAttribute('href', '/guardians/g9');
  expect(calls(requests, 'POST', '/guardians')[0].postDataJSON()).toMatchObject({ cnic: '3520112345671' });
});

// ---- Detail ----

test('detail: CNIC is masked and locked once a login exists; only changes are sent', async ({ page }) => {
  const requests = await mockGuardiansApi(page, {
    me: PRINCIPAL_ME,
    guardians: [guardian('g1', 'Ahmed Khan', { userId: 'u7' })],
  });

  await page.goto('/guardians/g1');
  await expect(page.getByRole('heading', { name: 'Ahmed Khan' })).toBeVisible();
  await expect(page.getByText('35201-*****-1')).toBeVisible();
  await expect(page.getByText(/the CNIC is its username, so it cannot be changed/)).toBeVisible();
  await expect(page.getByLabel(/CNIC \(optional\)/)).toHaveCount(0);
  await expect(page.getByText('This guardian has a login.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Issue login' })).toHaveCount(0);
  await expect(page.getByText('No students linked')).toBeVisible();

  await page.getByLabel('Mobile phone (optional)').fill('03111234567');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Guardian saved.')).toBeVisible();
  expect(calls(requests, 'PATCH', '/guardians/g1')[0].postDataJSON()).toEqual({ phone: '03111234567' });
});

test('detail: a merged guardian is read-only and links to the survivor', async ({ page }) => {
  await mockGuardiansApi(page, {
    me: OFFICE_ME,
    guardians: [guardian('g1', 'Ahmed Khan', { status: 'merged', mergedIntoId: 'g2' })],
  });
  await page.goto('/guardians/g1');
  await expect(page.getByRole('link', { name: 'Open the current record' })).toHaveAttribute('href', '/guardians/g2');
  await expect(page.getByLabel('Full name')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
});

test('issue login: states the username and default password, then shows the login', async ({ page }) => {
  const requests = await mockGuardiansApi(page, {
    me: PRINCIPAL_ME,
    guardians: [guardian('g1', 'Ahmed Khan')],
  });

  await page.goto('/guardians/g1');
  await page.getByRole('button', { name: 'Issue login' }).click();
  const dialog = page.getByRole('dialog', { name: 'Issue a login to Ahmed Khan?' });
  await expect(dialog.getByText(/The username is the guardian’s CNIC without dashes/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Issue login' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('This guardian has a login.')).toBeVisible();
  const posts = calls(requests, 'POST', '/guardians/g1/issue-login');
  // R57: the reason is optional; left blank, none is sent and the API records where.
  expect(posts.map((r) => r.postDataJSON())).toEqual([{}]);
});

test('issue login: a refusal is shown in the dialog', async ({ page }) => {
  await mockGuardiansApi(page, {
    me: PRINCIPAL_ME,
    guardians: [guardian('g1', 'Ahmed Khan')],
    replies: {
      'POST /guardians/g1/issue-login': {
        status: 409,
        body: errorBody('USER_DISABLED', 'The existing login for this CNIC is disabled.'),
      },
    },
  });
  await page.goto('/guardians/g1');
  await page.getByRole('button', { name: 'Issue login' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Issue login' }).click();
  await expect(dialog.getByText('The existing login for this CNIC is disabled.')).toBeVisible();
});

test('issue login is not offered to office staff without user.account.manage', async ({ page }) => {
  await mockGuardiansApi(page, {
    me: { ...OFFICE_ME, capabilities: OFFICE_ME.capabilities.filter((c) => c !== Capability.USER_ACCOUNT_MANAGE) },
    guardians: [guardian('g1', 'Ahmed Khan')],
  });
  await page.goto('/guardians/g1');
  await expect(page.getByText('No login yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Issue login' })).toHaveCount(0);
});
