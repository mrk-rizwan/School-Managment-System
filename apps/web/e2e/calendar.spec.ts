import { Capability, SYSTEM_ROLE_DEFAULTS } from '@asms/shared';
import { expect as baseExpect, test, type Page, type Request } from '@playwright/test';
import type { ApiErrorEnvelope } from '../lib/api/errors';
import type { HolidayDto, TeachingDaysDto } from '../lib/api/school-calendar-contract';
import type { MeDto } from '../lib/api/school-contract';

// The school calendar: month view, holiday list, create/edit/publish/cancel
// (contracts/slice-10.md §4, §5.1, §13) against a mocked API answered in the browser.

const expect = baseExpect.configure({ timeout: 15_000 });
const STAMP = '2026-09-20T05:00:00.000Z';

const PRINCIPAL_ME: MeDto = {
  id: 'u-principal',
  fullName: 'Amina Principal',
  email: 'amina@example.test',
  hasVerifiedEmail: true,
  passwordIsDefault: false,
  school: { id: 's1', name: 'Green Valley School', shortCode: 'greenvalley', status: 'active' },
  roles: ['principal'],
  capabilities: Object.values(Capability).sort(),
  sessionExpiresAt: '2026-11-02T05:00:00.000Z',
  capacities: ['staff'],
  assignments: [],
  staffId: null,
  children: [],
};
const TEACHER_ME: MeDto = {
  ...PRINCIPAL_ME,
  id: 'u-teacher',
  roles: ['teacher'],
  capabilities: [...SYSTEM_ROLE_DEFAULTS.teacher].sort(),
};

const holiday = (id: string, name: string, startsOn: string, endsOn: string, extra: Partial<HolidayDto> = {}): HolidayDto => ({
  id,
  startsOn,
  endsOn,
  name,
  description: null,
  kind: 'school',
  appliesToStaff: true,
  status: 'published',
  publishedAt: STAMP,
  publishedBy: 'u-principal',
  publishedByName: 'Amina Principal',
  cancelledAt: null,
  cancelledBy: null,
  cancelledByName: null,
  cancelReason: null,
  announcementId: null,
  createdAt: STAMP,
  updatedAt: STAMP,
  ...extra,
});
const draft = { status: 'draft', publishedAt: null, publishedBy: null, publishedByName: null } as const;

const MIDTERM = holiday('h1', 'Mid-term break', '2026-10-19', '2026-10-21');
const SPORTS = holiday('h2', 'Sports day', '2026-10-28', '2026-10-28', draft);
const RAIN = holiday('h3', 'Rain closure', '2026-10-07', '2026-10-07', {
  status: 'cancelled',
  cancelledAt: STAMP,
  cancelReason: 'Rain stopped',
});

type ErrorBody = ApiErrorEnvelope['error'];
const errorBody = (code: ErrorBody['code'], message: string, details: ErrorBody['details'] = null) => ({
  error: { code, message, details, requestId: 'req-test' },
});

type Reply = { status: number; body: unknown };
type MockState = {
  me: MeDto;
  holidays: HolidayDto[];
  replies?: Record<string, Reply | Reply[]>;
};

async function mockApi(page: Page, state: MockState) {
  // Copies, so a test's publish or cancel never leaks into the next test's fixtures.
  state.holidays = state.holidays.map((h) => ({ ...h }));
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
    if (method === 'GET' && path === '/calendar/teaching-days') {
      const dateFrom = url.searchParams.get('dateFrom')!;
      const body: TeachingDaysDto = {
        dateFrom,
        dateTo: url.searchParams.get('dateTo')!,
        teachingDays: dateFrom === '2026-10-01' ? 23 : 26,
        weeklyOffDays: [0],
        holidays: [],
      };
      return json(200, body);
    }
    if (path === '/holidays' && method === 'GET') {
      const status = url.searchParams.get('status');
      const rows = state.holidays.filter((h) => !status || h.status === status);
      return json(200, { data: rows, page: 1, limit: 25, total: rows.length });
    }
    if (path === '/holidays' && method === 'POST') {
      const b = request.postDataJSON() as Partial<HolidayDto>;
      const created = holiday('h-new', b.name!, b.startsOn!, b.endsOn ?? b.startsOn!, { ...draft, kind: b.kind! });
      state.holidays.push(created);
      return json(201, created);
    }
    const one = path.match(/^\/holidays\/([^/]+)(?:\/(publish|cancel))?$/);
    if (one) {
      const found = state.holidays.find((h) => h.id === one[1]);
      if (!found) return json(404, errorBody('NOT_FOUND', 'Not found.'));
      if (method === 'GET') return json(200, found);
      if (method === 'PATCH') Object.assign(found, request.postDataJSON());
      if (one[2] === 'publish') Object.assign(found, { status: 'published', publishedAt: STAMP });
      if (one[2] === 'cancel') {
        Object.assign(found, { status: 'cancelled', cancelReason: (request.postDataJSON() as { reason: string }).reason });
      }
      found.updatedAt = new Date().toISOString();
      return json(200, found);
    }
    return json(500, errorBody('INTERNAL_ERROR', `Unmocked ${method} ${path}`));
  });
  return requests;
}

async function open(page: Page, path = '/calendar') {
  // Today is fixed so the month view opens on October 2026.
  await page.clock.setFixedTime(new Date('2026-10-04T05:00:00Z'));
  await page.goto(path);
  await page.waitForLoadState('networkidle');
}

const calls = (requests: Request[], method: string, path: string) =>
  requests.filter((r) => r.method() === method && new URL(r.url()).pathname === `/api/v1${path}`);

test('month: off days greyed, ranges shown, drafts marked, cancelled hidden until asked; teaching days', async ({ page }) => {
  const requests = await mockApi(page, { me: PRINCIPAL_ME, holidays: [MIDTERM, SPORTS, RAIN] });
  await open(page);

  await expect(page.getByRole('heading', { name: 'October 2026' })).toBeVisible();
  await expect(page.getByTestId('teaching-days')).toHaveText('23 teaching days in October 2026');
  await expect(page.locator('[data-date="2026-10-04"]')).toHaveAttribute('data-off', 'true');
  await expect(page.locator('[data-date="2026-10-05"]')).not.toHaveAttribute('data-off', 'true');
  // A three-day range appears on each of its days.
  for (const date of ['2026-10-19', '2026-10-20', '2026-10-21']) {
    await expect(page.locator(`[data-date="${date}"]`).getByRole('button', { name: /Mid-term break/ })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: /Sports day, .*Draft/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Rain closure/ })).toHaveCount(0);
  await page.getByLabel('Show cancelled').check();
  await expect(page.getByRole('button', { name: /Rain closure, .*Cancelled/ })).toBeVisible();

  const holidayQuery = new URL(calls(requests, 'GET', '/holidays')[0].url()).searchParams;
  expect(holidayQuery.get('dateFrom')).toBe('2026-10-01');
  expect(holidayQuery.get('dateTo')).toBe('2026-10-31');

  await page.getByRole('button', { name: 'Previous month' }).click();
  await expect(page.getByTestId('teaching-days')).toContainText('(informational for past months)');

  await page.getByRole('button', { name: 'This month' }).click();
  await page.locator('[data-date="2026-10-20"]').getByRole('button', { name: /Mid-term break/ }).click();
  const detail = page.getByRole('dialog', { name: 'Mid-term break' });
  await expect(detail).toContainText('Published');
  await expect(detail).toContainText('by Amina Principal');
});

test('create a draft, then publish it with the notice wording', async ({ page }) => {
  const requests = await mockApi(page, { me: PRINCIPAL_ME, holidays: [] });
  await open(page);
  await page.getByRole('button', { name: 'New holiday' }).click();
  const form = page.getByRole('dialog', { name: 'New holiday' });
  await form.getByLabel('Name').fill('Iqbal Day');
  await form.getByLabel('First day').fill('2026-11-09');
  await form.getByRole('button', { name: 'Create draft' }).click();
  await expect(form.getByText('Choose the kind of holiday.')).toBeVisible();
  await form.getByLabel('Kind').selectOption('public');
  await form.getByLabel('Staff are off too').uncheck();
  await form.getByRole('button', { name: 'Create draft' }).click();
  await expect(form).toBeHidden();
  expect(calls(requests, 'POST', '/holidays')[0].postDataJSON()).toEqual({
    name: 'Iqbal Day',
    startsOn: '2026-11-09',
    kind: 'public',
    appliesToStaff: false,
  });

  await page.getByRole('tab', { name: 'Holidays' }).click();
  await page.getByRole('button', { name: 'Actions for Iqbal Day' }).click();
  await page.getByRole('menuitem', { name: 'Publish' }).click();
  const publish = page.getByRole('dialog', { name: 'Publish Iqbal Day' });
  await expect(publish.getByTestId('publish-notice')).toHaveText(
    'Every parent and staff member will be told by WhatsApp, SMS or the app. Dates cannot be changed after publishing.',
  );
  await publish.getByRole('button', { name: 'Publish' }).click();
  await expect(publish).toBeHidden();
  expect(calls(requests, 'POST', '/holidays/h-new/publish')).toHaveLength(1);
});

test('publish: a holiday already past says no notice is sent; a cancelled one is refused', async ({ page }) => {
  await mockApi(page, {
    me: PRINCIPAL_ME,
    holidays: [holiday('h9', 'Flood closure', '2026-09-10', '2026-09-11', draft)],
    replies: {
      'POST /holidays/h9/publish': {
        status: 409,
        body: errorBody('ILLEGAL_STATUS_TRANSITION', 'Not allowed.', { from: 'cancelled', to: 'published' }),
      },
    },
  });
  await open(page);
  await page.getByRole('tab', { name: 'Holidays' }).click();
  await page.getByRole('button', { name: 'Actions for Flood closure' }).click();
  await page.getByRole('menuitem', { name: 'Publish' }).click();
  const publish = page.getByRole('dialog', { name: 'Publish Flood closure' });
  await expect(publish.getByTestId('publish-notice')).toContainText('No notice is sent for dates already past.');
  await publish.getByRole('button', { name: 'Publish' }).click();
  await expect(publish.getByText('A cancelled holiday cannot be published again.', { exact: false })).toBeVisible();
});

test('create: an overlap names the other holiday and opens it; a retried create opens the existing one', async ({ page }) => {
  await mockApi(page, {
    me: PRINCIPAL_ME,
    holidays: [MIDTERM],
    replies: {
      'POST /holidays': [
        { status: 409, body: errorBody('HOLIDAY_DATES_TAKEN', 'Taken.', { holidayId: 'h1' }) },
        { status: 409, body: errorBody('HOLIDAY_DATES_TAKEN', 'Taken.', { holidayId: 'h1' }) },
      ],
    },
  });
  await open(page);
  await page.getByRole('button', { name: 'New holiday' }).click();
  const form = page.getByRole('dialog', { name: 'New holiday' });
  await form.getByLabel('Name').fill('Autumn break');
  await form.getByLabel('First day').fill('2026-10-20');
  await form.getByLabel('Kind').selectOption('school');
  await form.getByRole('button', { name: 'Create draft' }).click();
  await expect(form.getByTestId('holiday-overlap')).toContainText('Overlaps Mid-term break (19 Oct 2026 – 21 Oct 2026).');
  await form.getByRole('button', { name: 'Open Mid-term break' }).click();
  await expect(page.getByRole('dialog', { name: 'Mid-term break' })).toBeVisible();
  await page.keyboard.press('Escape');

  // The same name and dates as the row named: the create had succeeded.
  await page.getByRole('button', { name: 'New holiday' }).click();
  const again = page.getByRole('dialog', { name: 'New holiday' });
  await again.getByLabel('Name').fill('Mid-term break');
  await again.getByLabel('First day').fill('2026-10-19');
  await again.getByLabel('Last day (optional)').fill('2026-10-21');
  await again.getByLabel('Kind').selectOption('school');
  await again.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByText('This holiday was already created.')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Mid-term break' })).toBeVisible();
});

test('edit: a published holiday changes only its description; HOLIDAY_NOT_DRAFT is explained', async ({ page }) => {
  const requests = await mockApi(page, {
    me: PRINCIPAL_ME,
    holidays: [MIDTERM],
    replies: {
      'PATCH /holidays/h1': [
        { status: 409, body: errorBody('HOLIDAY_NOT_DRAFT', 'Not a draft.') },
      ],
    },
  });
  await open(page);
  await page.getByRole('tab', { name: 'Holidays' }).click();
  await page.getByRole('button', { name: 'Actions for Mid-term break' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const form = page.getByRole('dialog', { name: 'Edit Mid-term break' });
  await expect(form).toContainText('Cancel it and create a new one to change the dates.');
  await expect(form.getByLabel('Name')).toBeDisabled();
  await expect(form.getByLabel('First day')).toBeDisabled();
  await form.getByLabel('Description (optional)').fill('Classes resume on Thursday');
  await form.getByRole('button', { name: 'Save changes' }).click();
  await expect(form.getByText(/its dates, name and kind cannot change/)).toBeVisible();
  await form.getByRole('button', { name: 'Save changes' }).click();
  await expect(form).toBeHidden();
  const bodies = calls(requests, 'PATCH', '/holidays/h1').map((r) => r.postDataJSON());
  expect(bodies[1]).toEqual({ description: 'Classes resume on Thursday' });
});

test('cancel: a published future holiday warns that everyone told is told again; a reason is required', async ({ page }) => {
  const requests = await mockApi(page, { me: PRINCIPAL_ME, holidays: [MIDTERM, SPORTS] });
  await open(page);
  await page.getByRole('tab', { name: 'Holidays' }).click();
  await page.getByRole('button', { name: 'Actions for Mid-term break' }).click();
  await page.getByRole('menuitem', { name: 'Cancel holiday' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel Mid-term break' });
  await expect(dialog).toContainText('Everyone who was told will receive a cancellation.');
  await expect(dialog.getByRole('button', { name: 'Cancel holiday' })).toBeDisabled();
  await dialog.getByLabel('Reason').fill('Exams moved');
  await dialog.getByRole('button', { name: 'Cancel holiday' }).click();
  await expect(dialog).toBeHidden();
  expect(calls(requests, 'POST', '/holidays/h1/cancel')[0].postDataJSON()).toEqual({ reason: 'Exams moved' });

  await page.getByRole('button', { name: 'Actions for Sports day' }).click();
  await page.getByRole('menuitem', { name: 'Cancel holiday' }).click();
  await expect(page.getByRole('dialog', { name: 'Cancel Sports day' })).toContainText('The draft is withdrawn. Nothing is sent.');
});

test('teacher: reads the published calendar with no draft filter and no write controls', async ({ page }) => {
  // The API filters drafts out for anyone without holiday.manage (§1).
  await mockApi(page, { me: TEACHER_ME, holidays: [MIDTERM] });
  await open(page);
  await expect(page.getByRole('button', { name: /Mid-term break/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'New holiday' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Holidays' }).click();
  await expect(page.getByLabel('Status').locator('option')).toHaveText(['Any', 'Published', 'Cancelled']);
  await expect(page.getByRole('button', { name: 'Actions for Mid-term break' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Mid-term break' }).click();
  const detail = page.getByRole('dialog', { name: 'Mid-term break' });
  await expect(detail.getByRole('button', { name: 'Edit' })).toHaveCount(0);
});

test('states: no access, empty list and a failed load', async ({ page }) => {
  await mockApi(page, {
    me: TEACHER_ME,
    holidays: [],
    replies: {
      'GET /calendar/teaching-days': { status: 403, body: errorBody('PERMISSION_DENIED', 'Not allowed.') },
      'GET /holidays': [
        { status: 403, body: errorBody('PERMISSION_DENIED', 'Not allowed.') },
        ...Array.from({ length: 3 }, () => ({ status: 500, body: errorBody('INTERNAL_ERROR', 'The server failed.') })),
      ],
    },
  });
  await open(page);
  await expect(page.getByText('You do not have access')).toBeVisible();
  await page.getByRole('tab', { name: 'Holidays' }).click();
  await expect(page.getByText('Something went wrong')).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('No holidays yet')).toBeVisible();
});
