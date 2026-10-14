import { expect as baseExpect, test } from '@playwright/test';
import type {
  StudentTransportDto,
  TransportAssignmentDto,
  TransportRouteDetailDto,
  TransportRouteDto,
  VehicleDto,
} from '../lib/api/school-transport-contract';
import {
  OFFICE_ME,
  STAMP,
  TABLET,
  TEACHER_ME,
  calls,
  errorBody,
  expectNoSidewaysScroll,
  mockSchoolApi,
  open,
  page1,
  type Handler,
} from './support/wave-e';

// Transport (phase-5-extended.md slice 41, contracts/slice-41.md §3) against a mocked API: the
// routes list's empty, error and data states, a route's stops replaced as a whole, a monthly
// amount from next month, students assigned from a section list under one key each with the
// capacity warning shown, a rider ended with a reason, vehicles added and a refused retirement,
// the student page's Transport tab, the nav hidden without transport.manage, and tablet width.

const expect = baseExpect.configure({ timeout: 15_000 });
const KEY = /^[A-Za-z0-9_-]{16,64}$/;

const VEHICLE: VehicleDto = {
  id: 'v1',
  registration: 'LES-1234',
  capacity: 2,
  driverStaffId: 'st-d',
  driverName: 'Rashid Driver',
  status: 'active',
  routeNames: ['Model Town'],
  retiredAt: null,
  retireReason: null,
  createdAt: STAMP,
};

const ROUTE: TransportRouteDto = {
  id: 'r1',
  name: 'Model Town',
  status: 'active',
  vehicle: { id: 'v1', registration: 'LES-1234', capacity: 2, driverName: 'Rashid Driver' },
  riders: 1,
  currentAmount: 2000,
  nextAmount: { amount: 2500, effectivePeriod: '2026-11' },
  stopCount: 2,
  archivedAt: null,
  archiveReason: null,
};

const DETAIL: TransportRouteDetailDto = {
  ...ROUTE,
  stops: [
    { id: 'p1', sortOrder: 1, name: 'Link Road', pickupTime: '07:05' },
    { id: 'p2', sortOrder: 2, name: 'Main Boulevard', pickupTime: '07:15' },
  ],
  amounts: [
    { id: 'a2', routeId: 'r1', effectivePeriod: '2026-11', amount: 2500, createdByName: 'Bilal Office', createdAt: STAMP, voidedAt: null, voidReason: null, voidable: true },
    { id: 'a1', routeId: 'r1', effectivePeriod: '2026-04', amount: 2000, createdByName: 'Bilal Office', createdAt: STAMP, voidedAt: null, voidReason: null, voidable: false },
  ],
};

const rider = (extra: Partial<TransportAssignmentDto> = {}): TransportAssignmentDto => ({
  id: 'as1',
  studentId: 'stu1',
  studentName: 'Hamza Tariq',
  admissionNo: '0001',
  className: 'Class 5',
  sectionName: 'A',
  academicYearId: 'y1',
  routeId: 'r1',
  routeName: 'Model Town',
  stopId: 'p1',
  stopName: 'Link Road',
  pickupTime: '07:05',
  startsOn: '2026-04-01',
  endsOn: null,
  status: 'live',
  endReason: null,
  endedByName: null,
  createdAt: STAMP,
  ...extra,
});

const student = (id: string, fullName: string) => ({
  id,
  admissionNo: id.toUpperCase(),
  admittedOn: '2026-04-01',
  bFormMasked: null,
  createdAt: STAMP,
  current: null,
  dateOfBirth: '2016-01-01',
  documentsIncomplete: null,
  fullName,
  gender: 'male',
  hasBForm: false,
  status: 'active',
  updatedAt: STAMP,
  userId: null,
});

const routeHandler =
  (riders: TransportAssignmentDto[]): Handler =>
  ({ method, path, url }) => {
    if (method === 'GET' && path === '/transport-routes/r1') return { status: 200, body: DETAIL };
    if (method === 'GET' && path === '/transport-routes/r1/assignments') return { status: 200, body: page1(riders) };
    if (method === 'GET' && path === '/vehicles') return { status: 200, body: page1([VEHICLE]) };
    if (method === 'GET' && path === '/students' && url.searchParams.get('sectionId') === 'sec-a') {
      return { status: 200, body: page1([student('stu2', 'Hira Tariq'), student('stu3', 'Zainab Khan')]) };
    }
    return undefined;
  };

test.describe('Transport', () => {
  test('the routes list: empty, then a failure, then routes with riders and amounts', async ({ page }) => {
    let mode: 'empty' | 'error' | 'data' = 'empty';
    await mockSchoolApi(page, {
      me: OFFICE_ME,
      handler: ({ method, path }) => {
        if (method !== 'GET' || path !== '/transport-routes') return undefined;
        if (mode === 'empty') return { status: 200, body: page1([]) };
        if (mode === 'error') return { status: 500, body: errorBody('INTERNAL_ERROR', 'Something went wrong.') };
        return { status: 200, body: page1([ROUTE]) };
      },
    });
    await open(page, '/transport');
    await expect(page.getByRole('link', { name: 'Transport' })).toBeVisible();
    await expect(page.getByText('No routes yet')).toBeVisible();

    mode = 'error';
    await page.reload();
    await expect(page.getByRole('button', { name: /try again|retry/i })).toBeVisible();

    mode = 'data';
    await page.reload();
    const row = page.getByRole('row', { name: /Model Town/ });
    await expect(row).toContainText('LES-1234');
    await expect(row).toContainText('1 / 2');
    await expect(row).toContainText('Rs 2,000');
    await expect(row).toContainText('Rs 2,500 from November 2026');
    await expect(row.getByRole('link', { name: 'Model Town' })).toHaveAttribute('href', '/transport/r1');
  });

  test('stops are saved as a whole; a removed stop asks why', async ({ page }) => {
    const { requests, unmocked } = await mockSchoolApi(page, {
      me: OFFICE_ME,
      handler: routeHandler([rider()]),
      replies: { 'PATCH /transport-routes/r1': { status: 200, body: DETAIL } },
    });
    await open(page, '/transport/r1');
    const stops = page.getByTestId('transport.stops');
    await expect(stops.getByLabel('Stop 1 name')).toHaveValue('Link Road');
    await stops.getByRole('button', { name: 'Move stop 2 up' }).click();
    await expect(stops.getByLabel('Stop 1 name')).toHaveValue('Main Boulevard');
    await stops.getByRole('button', { name: 'Add stop' }).click();
    await stops.getByLabel('Stop 3 name').fill('Kalma Chowk');
    await stops.getByLabel('Stop 3 pickup time').fill('07:25');
    await stops.getByRole('button', { name: 'Remove stop 2' }).click();
    // Link Road removed: a reason is needed before saving.
    await expect(stops.getByRole('button', { name: 'Save stops' })).toBeDisabled();
    await stops.getByLabel(/Why remove Link Road/).fill('Road closed');
    await stops.getByRole('button', { name: 'Save stops' }).click();
    await expect(page.getByText('Stops saved.')).toBeVisible();
    expect(calls(requests, 'PATCH', '/transport-routes/r1')[0]!.postDataJSON()).toEqual({
      stops: [
        { id: 'p2', sortOrder: 1, name: 'Main Boulevard', pickupTime: '07:15' },
        { sortOrder: 2, name: 'Kalma Chowk', pickupTime: '07:25' },
      ],
      reason: 'Road closed',
    });
    expect(unmocked).toEqual([]);
  });

  test('a new amount starts next month; a stop in use is refused in words', async ({ page }) => {
    const { requests } = await mockSchoolApi(page, {
      me: OFFICE_ME,
      handler: routeHandler([rider()]),
      replies: {
        'POST /transport-routes/r1/amounts': { status: 201, body: DETAIL.amounts[0] },
        'PATCH /transport-routes/r1': {
          status: 409,
          body: errorBody('TRANSPORT_STOP_IN_USE', 'A student is still assigned to that stop.', { stopId: 'p1' }),
        },
      },
    });
    await open(page, '/transport/r1');
    const amounts = page.getByTestId('transport.amounts');
    await expect(amounts).toContainText('Rs 2,000 a month this month');
    await amounts.getByRole('button', { name: 'Set amount' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('From month')).toHaveValue('2026-11');
    await dialog.getByLabel('Amount (Rs)').fill('2600');
    await dialog.getByLabel('From month').fill('2026-12');
    await dialog.getByRole('button', { name: 'Set amount' }).click();
    await expect(page.getByText('Amount set.')).toBeVisible();
    expect(calls(requests, 'POST', '/transport-routes/r1/amounts')[0]!.postDataJSON()).toEqual({ amount: 2600, effectivePeriod: '2026-12' });

    const stops = page.getByTestId('transport.stops');
    await stops.getByRole('button', { name: 'Remove stop 1' }).click();
    await stops.getByLabel(/Why remove Link Road/).fill('Road closed');
    await stops.getByRole('button', { name: 'Save stops' }).click();
    await expect(stops.getByText('A student is still assigned to a stop you removed')).toBeVisible();
  });

  test('students are assigned from a section list, one key each; over capacity is shown; a rider is ended with a reason', async ({ page }) => {
    const { requests, unmocked } = await mockSchoolApi(page, {
      me: OFFICE_ME,
      handler: routeHandler([rider()]),
      replies: {
        'POST /transport-routes/r1/assignments': [
          { status: 201, body: { ...rider({ id: 'as2', studentId: 'stu2', studentName: 'Hira Tariq' }), capacityWarning: null } },
          { status: 201, body: { ...rider({ id: 'as3', studentId: 'stu3', studentName: 'Zainab Khan' }), capacityWarning: { capacity: 2, riders: 3 } } },
        ],
        'POST /transport-assignments/as1/end': { status: 200, body: rider({ status: 'ended', endsOn: '2026-10-06', endReason: 'Moved house' }) },
      },
    });
    await open(page, '/transport/r1');
    const riders = page.getByTestId('transport.riders');
    await expect(riders.getByRole('link', { name: 'Hamza Tariq' })).toHaveAttribute('href', '/students/stu1');
    await expect(riders).toContainText('Link Road · 07:05');

    await riders.getByRole('button', { name: 'Assign students' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Section').selectOption('sec-a');
    await dialog.getByLabel(/Hira Tariq/).check();
    await dialog.getByLabel(/Zainab Khan/).check();
    await dialog.getByLabel('Stop').selectOption('p2');
    await expect(dialog.getByLabel('First day')).toHaveValue('2026-10-06');
    await dialog.getByRole('button', { name: 'Assign 2' }).click();
    const outcomes = dialog.getByTestId('transport.assign.outcomes');
    await expect(outcomes).toContainText('Hira Tariq: Assigned');
    await expect(outcomes).toContainText('Zainab Khan: Assigned — 3 riders for 2 seats');
    const posts = calls(requests, 'POST', '/transport-routes/r1/assignments');
    expect(posts.map((p) => p.postDataJSON())).toEqual([
      { studentId: 'stu2', startsOn: '2026-10-06', stopId: 'p2' },
      { studentId: 'stu3', startsOn: '2026-10-06', stopId: 'p2' },
    ]);
    const keys = posts.map((p) => p.headers()['idempotency-key']);
    expect(keys.every((k) => KEY.test(k ?? ''))).toBe(true);
    expect(new Set(keys).size).toBe(2);
    await dialog.getByRole('button', { name: 'Done' }).click();

    await riders.getByRole('button', { name: 'End' }).click();
    const end = page.getByRole('dialog');
    await expect(end.getByLabel('Last day on the route')).toHaveValue('2026-10-06');
    await end.getByLabel('Reason').fill('Moved house');
    await end.getByRole('button', { name: 'End' }).click();
    await expect(page.getByText('Hamza Tariq no longer rides Model Town.')).toBeVisible();
    expect(calls(requests, 'POST', '/transport-assignments/as1/end')[0]!.postDataJSON()).toEqual({ endedOn: '2026-10-06', reason: 'Moved house' });
    expect(unmocked).toEqual([]);
  });

  test('vehicles: add one with a driver; retiring one a route uses is refused in words', async ({ page }) => {
    const { requests } = await mockSchoolApi(page, {
      me: OFFICE_ME,
      handler: ({ method, path }) => {
        if (method === 'GET' && path === '/vehicles') return { status: 200, body: page1([VEHICLE]) };
        if (method === 'GET' && path === '/staff') {
          return { status: 200, body: page1([{ id: 'st-d', fullName: 'Rashid Driver' }]) };
        }
        return undefined;
      },
      replies: {
        'POST /vehicles': { status: 201, body: { ...VEHICLE, id: 'v2', registration: 'LEB-77', routeNames: [] } },
        'POST /vehicles/v1/retire': { status: 409, body: errorBody('VEHICLE_IN_USE', 'An active route still uses this vehicle.', { vehicleId: 'v1', routeId: 'r1' }) },
      },
    });
    await open(page, '/transport/vehicles');
    const row = page.getByRole('row', { name: /LES-1234/ });
    await expect(row).toContainText('Rashid Driver');
    await page.getByRole('button', { name: 'Add vehicle' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Registration').fill('LEB-77');
    await dialog.getByLabel('Seats').fill('14');
    await dialog.getByLabel(/Driver/).selectOption('st-d');
    await dialog.getByRole('button', { name: 'Add vehicle' }).click();
    await expect(page.getByText('Vehicle LEB-77 added.')).toBeVisible();
    expect(calls(requests, 'POST', '/vehicles')[0]!.postDataJSON()).toEqual({ registration: 'LEB-77', capacity: 14, driverStaffId: 'st-d' });
    expect(calls(requests, 'POST', '/vehicles')[0]!.headers()['idempotency-key']).toMatch(KEY);

    await row.getByRole('button', { name: 'Retire' }).click();
    const retire = page.getByRole('dialog');
    await retire.getByLabel('Reason').fill('Sold the van');
    await retire.getByRole('button', { name: 'Retire' }).click();
    await expect(retire.getByText('A route still uses this vehicle.')).toBeVisible();
  });

  test('a new route is created under an Idempotency-Key and opens its page', async ({ page }) => {
    const { requests } = await mockSchoolApi(page, {
      me: OFFICE_ME,
      handler: (call) => {
        if (call.method === 'GET' && call.path === '/transport-routes') return { status: 200, body: page1([]) };
        if (call.method === 'GET' && call.path === '/vehicles') return { status: 200, body: page1([VEHICLE]) };
        return routeHandler([])(call);
      },
      replies: { 'POST /transport-routes': { status: 201, body: DETAIL } },
    });
    await open(page, '/transport');
    await page.getByRole('button', { name: 'New route' }).click();
    const dialog = page.getByRole('dialog', { name: 'New route' });
    await dialog.getByLabel('Name').fill('Model Town');
    await dialog.getByRole('button', { name: 'Create route' }).click();
    await expect(page).toHaveURL(/\/transport\/r1$/);
    const posted = calls(requests, 'POST', '/transport-routes');
    expect(posted).toHaveLength(1);
    expect(posted[0]!.postDataJSON()).toEqual({ name: 'Model Town' });
    expect(posted[0]!.headers()['idempotency-key']).toMatch(KEY);
  });

  test("the student page's Transport tab shows the route, stop and the earlier routes", async ({ page }) => {
    const transport: StudentTransportDto = {
      current: rider({ studentId: 'st1' }),
      history: [rider({ id: 'as0', routeName: 'Gulberg', startsOn: '2026-04-01', endsOn: '2026-06-30', status: 'ended', endReason: 'Changed route' })],
    };
    await mockSchoolApi(page, {
      me: OFFICE_ME,
      handler: ({ method, path }) => {
        if (method === 'GET' && path === '/students/st1') {
          return { status: 200, body: { ...student('st1', 'Hamza Tariq'), current: null, notes: null, photoDocumentId: null, guardians: [] } };
        }
        if (method === 'GET' && path === '/students/st1/transport') return { status: 200, body: transport };
        if (method === 'GET' && path.startsWith('/students/st1/')) return { status: 200, body: page1([]) };
        if (method === 'GET' && path === '/school/settings') return { status: 200, body: { studentLoginEnabled: true } };
        return undefined;
      },
    });
    await open(page, '/students/st1');
    await page.getByRole('tab', { name: 'Transport' }).click();
    const card = page.getByTestId('student.transport');
    await expect(card.getByRole('link', { name: 'Model Town' })).toHaveAttribute('href', '/transport/r1');
    await expect(card).toContainText('Link Road · 07:05');
    await expect(card).toContainText('Gulberg');
    await expect(card).toContainText('(Changed route)');
  });

  test('a teacher sees no Transport entry', async ({ page }) => {
    await mockSchoolApi(page, { me: TEACHER_ME });
    await open(page, '/my-attendance');
    await expect(page.getByRole('link', { name: 'Events' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Transport' })).toHaveCount(0);
  });

  test('tablet width: the route page does not scroll sideways', async ({ page }) => {
    await page.setViewportSize(TABLET);
    await mockSchoolApi(page, { me: OFFICE_ME, handler: routeHandler([rider()]) });
    await open(page, '/transport/r1');
    await expect(page.getByTestId('transport.riders')).toContainText('Hamza Tariq');
    await expectNoSidewaysScroll(page);
  });
});
