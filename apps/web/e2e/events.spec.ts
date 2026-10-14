import { expect as baseExpect, test } from '@playwright/test';
import { EV_DRAFT, EV_PAYMENT, EV_PUBLISHED, EV_REPORT, EV_ROSTER } from './support/events';
import { TT_STAFF } from './support/timetable';
import { PRINCIPAL_ME, TEACHER_ME, TODAY, calls, errorBody, mockSchoolApi, open, page1, type Handler } from './support/wave-e';

// Phase 5 slice 38 (contracts/slice-38.md §6): the event list in its four states, the draft form
// (validation, then a create with an Idempotency-Key and the times sent as Karachi instants), the
// detail with Publish and Cancel, participation saved by a duty holder, a collector's cash payment
// (refused over what is owed, then recorded), and the report.

const expect = baseExpect.configure({ timeout: 15_000 });
const KEY = /^[A-Za-z0-9_-]{16,64}$/;

const handler: Handler = ({ method, path }) => {
  if (method !== 'GET') return undefined;
  if (path === '/events') return { status: 200, body: page1([EV_PUBLISHED, EV_DRAFT]) };
  if (path === '/events/ev1') return { status: 200, body: EV_DRAFT };
  if (path === '/events/ev2') return { status: 200, body: EV_PUBLISHED };
  if (path === '/events/ev1/participation') return { status: 404, body: errorBody('NOT_FOUND', 'Not found.') };
  if (path === '/events/ev2/participation') return { status: 200, body: EV_ROSTER };
  if (path === '/events/ev2/payments') return { status: 200, body: page1([EV_PAYMENT]) };
  if (path === '/events/ev2/report') return { status: 200, body: EV_REPORT };
  if (path === '/staff') return { status: 200, body: page1(TT_STAFF) };
  return undefined;
};

test('the list shows the events with New for a holiday.manage holder, and the sidebar entry', async ({ page }) => {
  const { requests, unmocked } = await mockSchoolApi(page, { me: PRINCIPAL_ME, handler });
  await open(page, '/events');
  await expect(page.getByRole('link', { name: 'Museum trip' })).toHaveAttribute('href', '/events/ev2');
  const draftRow = page.getByRole('row').filter({ hasText: 'Parent-teacher meeting' });
  await expect(draftRow).toContainText('Draft');
  await expect(draftRow).toContainText('Rs 1,500');
  await expect(draftRow).toContainText('Class 5 A');
  await expect(page.getByRole('link', { name: 'New event' })).toHaveAttribute('href', '/events/new');
  await expect(page.getByRole('link', { name: 'Events', exact: true })).toBeVisible();
  // A filter goes to the API.
  await page.getByLabel('Type').selectOption('trip');
  await expect
    .poll(() => calls(requests, 'GET', '/events').map((r) => new URL(r.url()).searchParams.get('type')))
    .toContain('trip');
  expect(unmocked).toEqual([]);
});

test('the list: a teacher sees no New, then empty, failed and loading states', async ({ page }) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  const { requests } = await mockSchoolApi(page, {
    me: TEACHER_ME,
    replies: {
      'GET /events': [
        { status: 200, body: page1([]) },
        { status: 500, body: errorBody('INTERNAL_ERROR', 'The server failed.') },
      ],
    },
  });
  await open(page, '/events');
  await expect(page.getByText('No events yet')).toBeVisible();
  await expect(page.getByText('Published events appear here.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'New event' })).toHaveCount(0);
  // A teacher is not offered the draft filter.
  await expect(page.getByLabel('Status').locator('option', { hasText: 'Draft' })).toHaveCount(0);

  await page.getByLabel('Type').selectOption('trip');
  await expect(page.getByText('Something went wrong')).toBeVisible();
  const filtered = calls(requests, 'GET', '/events').at(-1)!;
  expect(new URL(filtered.url()).searchParams.get('type')).toBe('trip');

  await page.route(/\/api\/v1\/events\?/, async (route) => {
    await held;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(page1([EV_PUBLISHED])) });
  });
  await page.goto('/events');
  await expect(page.getByRole('status', { name: 'Loading' }).last()).toBeVisible();
  release();
  await expect(page.getByRole('link', { name: 'Museum trip' })).toBeVisible();
});

test('the new-event form refuses incomplete input, then creates a draft with an Idempotency-Key', async ({ page }) => {
  const { requests, unmocked } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler,
    replies: { 'POST /events': { status: 201, body: EV_DRAFT } },
  });
  await open(page, '/events/new');
  await expect(page.getByRole('heading', { name: 'New event' })).toBeVisible();
  await expect(page.getByLabel('Academic year')).toHaveValue('y1');

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Give the event a title.')).toBeVisible();
  await expect(page.getByText('Choose the date.')).toBeVisible();
  await expect(page.getByText('Say where it happens.')).toBeVisible();

  await page.getByLabel('Title').fill('Parent-teacher meeting');
  await page.getByLabel('Date').fill('2026-11-14');
  await page.getByLabel('Starts at').fill('10:00');
  await page.getByLabel('Ends at').fill('09:00');
  await page.getByLabel('Venue').fill('School hall');
  await page.getByLabel('Charge families for this event').check();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Cannot end before it starts.')).toBeVisible();
  await expect(page.getByText(/Enter a whole number of rupees/)).toBeVisible();
  expect(calls(requests, 'POST', '/events')).toHaveLength(0);

  await page.getByLabel('Starts at').fill('09:00');
  await page.getByLabel('Ends at').fill('12:00');
  await page.getByLabel('Amount (Rs)').fill('1500');
  await page.getByLabel('Class 5 A').check();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page).toHaveURL(/\/events\/ev1$/);

  const [create] = calls(requests, 'POST', '/events');
  expect(create!.headers()['idempotency-key']).toMatch(KEY);
  expect(create!.postDataJSON()).toEqual({
    academicYearId: 'y1',
    type: 'ptm',
    title: 'Parent-teacher meeting',
    startsAt: '2026-11-14T09:00:00+05:00',
    endsAt: '2026-11-14T12:00:00+05:00',
    venue: 'School hall',
    sectionIds: ['sec-a'],
    charge: { amount: 1500 },
  });
  expect(unmocked).toEqual([]);
});

test('editing a draft sends only what changed; a published event cannot be edited', async ({ page }) => {
  const { requests, unmocked } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler,
    replies: { 'PATCH /events/ev1': { status: 200, body: { ...EV_DRAFT, venue: 'Main hall', endsAt: '2026-11-14T08:00:00.000Z' } } },
  });
  await open(page, '/events/ev1/edit');
  await expect(page.getByRole('heading', { name: 'Edit event' })).toBeVisible();
  // School time: 04:00Z is 09:00 in Karachi.
  await expect(page.getByLabel('Starts at')).toHaveValue('09:00');
  await expect(page.getByLabel('Academic year')).toBeDisabled();
  await page.getByLabel('Venue').fill('Main hall');
  await page.getByLabel('Ends at').fill('13:00');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page).toHaveURL(/\/events\/ev1$/);
  expect(calls(requests, 'PATCH', '/events/ev1')[0]!.postDataJSON()).toEqual({
    endsAt: '2026-11-14T13:00:00+05:00',
    venue: 'Main hall',
  });

  await open(page, '/events/ev2/edit');
  await expect(page.getByText('This event is published')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  expect(unmocked).toEqual([]);
});

test('a draft is published, then cancelled with a reason; a 404 roster hides the participation panel', async ({ page }) => {
  const published = { ...EV_DRAFT, status: 'published' as const, announcementId: 'a9' };
  const { requests, unmocked } = await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler,
    replies: {
      'POST /events/ev1/publish': { status: 200, body: published },
      'POST /events/ev1/cancel': {
        status: 200,
        body: { ...published, status: 'cancelled', cancelledAt: '2026-10-06T05:00:00.000Z', cancelReason: 'Rain expected', cancelAnnouncementId: 'a10' },
      },
    },
  });
  await open(page, '/events/ev1');
  await expect(page.getByRole('heading', { name: 'Parent-teacher meeting' })).toBeVisible();
  await expect(page.getByTestId('event-charge')).toContainText('Rs 1,500 per student');
  await expect(page.getByRole('link', { name: 'Edit' })).toHaveAttribute('href', '/events/ev1/edit');
  await expect(page.getByRole('form', { name: 'Add a duty' })).toBeVisible();

  await page.getByRole('button', { name: 'Publish…' }).click();
  await expect(page.getByRole('dialog')).toContainText('each student is charged Rs 1,500');
  await page.getByRole('dialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Edit' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Report', exact: true })).toHaveAttribute('href', '/events/ev1/report');
  expect(calls(requests, 'POST', '/events/ev1/publish')).toHaveLength(1);
  // The roster answered 404 (the API's "not yours"): no panel.
  await expect.poll(() => calls(requests, 'GET', '/events/ev1/participation').length).toBeGreaterThan(0);
  await expect(page.getByText('Participation', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Cancel event' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason').fill('Rain expected');
  await dialog.getByRole('button', { name: 'Cancel event' }).click();
  await expect(page.locator('[data-slot="badge"]', { hasText: 'Cancelled' })).toBeVisible();
  await expect(page.getByText(/: Rain expected$/)).toBeVisible();
  expect(calls(requests, 'POST', '/events/ev1/cancel')[0]!.postDataJSON()).toEqual({ reason: 'Rain expected' });
  await expect(page.getByRole('button', { name: 'Cancel event' })).toHaveCount(0);
  expect(unmocked).toEqual([]);
});

test('a refused publish shows the reason in words', async ({ page }) => {
  await mockSchoolApi(page, {
    me: PRINCIPAL_ME,
    handler,
    replies: { 'POST /events/ev1/publish': { status: 409, body: errorBody('EVENT_NO_SECTIONS', 'No sections.', { eventId: 'ev1' }) } },
  });
  await open(page, '/events/ev1');
  await page.getByRole('button', { name: 'Publish…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Choose at least one section' })).toContainText(
    'Choose at least one section before publishing.',
  );
});

test('a duty holder records participation: only the changed rows are sent', async ({ page }) => {
  const saved = { ...EV_ROSTER, rows: EV_ROSTER.rows.map((r) => (r.studentId === 's1' ? { ...r, participation: 'attended' as const } : r)) };
  const { requests, unmocked } = await mockSchoolApi(page, {
    me: TEACHER_ME,
    handler,
    replies: { 'POST /events/ev2/record-participation': { status: 200, body: saved } },
  });
  await open(page, '/events/ev2');
  await expect(page.getByRole('heading', { name: 'Museum trip' })).toBeVisible();
  // A teacher sees only their own duty, and no management actions.
  await expect(page.getByText('Your duties', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel event' })).toHaveCount(0);
  await expect(page.getByRole('form', { name: 'Add a duty' })).toHaveCount(0);

  await expect(page.getByTestId('participation-counts')).toContainText('2 on the roster · 1 attended');
  await expect(page.getByRole('button', { name: 'Save participation' })).toBeDisabled();
  await page.getByLabel('Participation of Ali Khan').selectOption('attended');
  await page.getByRole('button', { name: 'Save participation' }).click();
  await expect(page.getByTestId('participation-counts')).toContainText('2 attended');
  expect(calls(requests, 'POST', '/events/ev2/record-participation')[0]!.postDataJSON()).toEqual({
    rows: [{ studentId: 's1', status: 'attended' }],
  });
  expect(unmocked).toEqual([]);
});

test('a collector takes cash: over what is owed is refused, the API refusal is shown, then it is recorded', async ({ page }) => {
  const { requests, unmocked } = await mockSchoolApi(page, {
    me: TEACHER_ME,
    handler,
    replies: {
      'POST /events/ev2/payments': [
        { status: 409, body: errorBody('EVENT_PAYMENT_EXCEEDS_CHARGE', 'Too much.', { eventId: 'ev2', outstanding: 500 }) },
        { status: 201, body: { ...EV_PAYMENT, id: 'p2', amount: 500, students: [{ studentId: 's1', fullName: 'Ali Khan', amount: 500 }] } },
      ],
    },
  });
  await open(page, '/events/ev2');
  const payments = page.getByRole('table', { name: 'Event payments' });
  await expect(payments).toContainText('2026-27/0042');
  await expect(payments).toContainText('Sara Ahmed');

  const form = page.getByRole('form', { name: 'Take a payment' });
  // Only a child who still owes is offered.
  await expect(form.getByLabel('Student').locator('option')).toHaveCount(2);
  await form.getByLabel('Student').selectOption('s1');
  await expect(form.getByLabel('Amount (Rs)')).toHaveValue('1500');
  await form.getByLabel('Amount (Rs)').fill('2000');
  await expect(form.getByRole('alert')).toContainText('No more than Rs 1,500');
  await expect(form.getByRole('button', { name: 'Record cash' })).toBeDisabled();

  await form.getByLabel('Amount (Rs)').fill('1000');
  await form.getByRole('button', { name: 'Record cash' }).click();
  await expect(form.getByRole('alert')).toContainText('more than the child owes for this event (Rs 500)');
  await form.getByLabel('Amount (Rs)').fill('500');
  await form.getByRole('button', { name: 'Record cash' }).click();
  await expect(page.getByText('Rs 500 received, receipt 2026-27/0042.')).toBeVisible();

  const posts = calls(requests, 'POST', '/events/ev2/payments');
  expect(posts).toHaveLength(2);
  expect(posts[0]!.headers()['idempotency-key']).toMatch(KEY);
  expect(posts[1]!.postDataJSON()).toEqual({ studentId: 's1', amount: 500, receivedOn: TODAY });
  expect(unmocked).toEqual([]);
});

test('the report shows participants, collections, expenses and a negative net', async ({ page }) => {
  const { unmocked } = await mockSchoolApi(page, { me: PRINCIPAL_ME, handler });
  await open(page, '/events/ev2/report');
  await expect(page.getByRole('heading', { name: 'Report · Museum trip' })).toBeVisible();
  await expect(page.getByText('Collected', { exact: true })).toBeVisible();
  await expect(page.getByTestId('event-net')).toHaveText('-Rs 2,500');
  await expect(page.getByText('Rs 4,000')).toBeVisible();
  expect(unmocked).toEqual([]);
});

test('the report is refused to a teacher without the finance or calendar key', async ({ page }) => {
  await mockSchoolApi(page, { me: TEACHER_ME, handler });
  await open(page, '/events/ev2/report');
  await expect(page.getByText('You do not have access')).toBeVisible();
});
