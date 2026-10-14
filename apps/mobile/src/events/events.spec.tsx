import { ApiError, ErrorCode } from '@asms/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import type {
  EventDto,
  EventRosterDto,
  EventRosterRowDto,
  MyEventDto,
  PaymentDto,
} from '../api/contracts';
import { queryClient } from '../api/query-client';
import { MyClassesScreen } from '../classes/MyClassesScreen';
import { ChildrenScreen } from '../family/ChildrenScreen';
import { StudentIndexScreen } from '../family/StudentIndexScreen';
import { LANES, ONLINE_ONLY_ACTIONS } from '../outbox/lanes';
import { errorBody, resetDevice, type FakeRequest } from '../test/fake-api';
import { guardianMe, teacherMe, TODAY } from '../test/fixtures';
import { eventually, renderSignedIn, setOnline } from '../test/screen';
import { FamilyEventsScreen, StaffEventScreen, StaffEventsScreen } from './EventScreens';
import {
  amountProblem,
  canCollect,
  chargeLine,
  changedRows,
  eventValue,
  eventWhen,
  eventWriteFailure,
} from './events';

// Phase 5 slice 38 (contracts/slice-38.md §2.6, §2.7, §2.9, §2.10, §6): the teacher's events,
// participation and event payments on a collection duty; the families' events. Online only.

const STARTS = '2026-11-14T05:00:00.000Z'; // 10:00 in Karachi
const ENDS = '2026-11-14T07:00:00.000Z'; // 12:00

const eventDto = (patch: Partial<EventDto> = {}): EventDto => ({
  id: '7',
  academicYearId: '3',
  academicYearName: '2026–27',
  type: 'trip',
  title: 'Museum trip',
  startsAt: STARTS,
  endsAt: ENDS,
  venue: 'Lahore Museum',
  details: 'Bring a packed lunch.',
  status: 'published',
  charge: { amount: 300, dueOn: '2026-11-14' },
  sections: [{ sectionId: '12', sectionName: 'A', classId: '20', className: 'Class 5' }],
  duties: [],
  announcementId: '55',
  cancelAnnouncementId: null,
  campaignId: '66',
  campaignStatus: 'generated',
  createdByName: 'Principal',
  createdAt: '2026-10-09T05:00:00.000Z',
  completedAt: null,
  cancelledAt: null,
  cancelReason: null,
  myDuties: ['collection'],
  ...patch,
});

const rosterRow = (n: number, patch: Partial<EventRosterRowDto> = {}): EventRosterRowDto => ({
  studentId: `50${n}`,
  enrolmentId: `10${n}`,
  fullName: ['Ali Raza', 'Sara Khan', 'Bilal Ahmed'][n - 1] ?? `Student ${n}`,
  admissionNo: `A-${n}`,
  rollNo: n,
  sectionId: '12',
  sectionName: 'A',
  className: 'Class 5',
  participation: null,
  recordedAt: null,
  charge: { chargeId: `90${n}`, amount: 300, outstanding: 300, status: 'unpaid' },
  ...patch,
});

const roster = (rows: EventRosterRowDto[], status: EventRosterDto['status'] = 'published') => ({
  eventId: '7',
  status,
  rows,
});

const page = <T,>(data: T[]) => ({ data, total: data.length, page: 1, limit: 50 });

const payment = (patch: Partial<PaymentDto> = {}): PaymentDto => ({
  id: '880',
  academicYearId: '3',
  advanceForStudentId: null,
  allocatedAmount: 300,
  amount: 300,
  claimId: null,
  duplicateOfPaymentId: null,
  handoverId: null,
  method: 'cash',
  payerGuardianId: '61',
  payerName: 'Imran Raza',
  possibleDuplicate: false,
  receipt: {
    id: '990',
    academicYearId: '3',
    amount: 300,
    issuedAt: '2026-10-10T05:00:00.000Z',
    issuedByName: 'Nadia Teacher',
    lines: [],
    paymentId: '880',
    receiptLabel: '2026-27/0042',
    receiptNo: 42,
    voidedAt: null,
  },
  receivedOn: TODAY,
  recordedByName: 'Nadia Teacher',
  recordedByUserId: '41',
  reference: null,
  reversals: [],
  status: 'verified',
  students: [{ studentId: '501', fullName: 'Ali Raza', amount: 300 }],
  unallocatedAmount: 0,
  verifiedAt: '2026-10-10T05:00:00.000Z',
  voidedAt: null,
  ...patch,
});

const myEvent = (patch: Partial<MyEventDto> = {}): MyEventDto => ({
  id: '7',
  type: 'ptm',
  title: 'Parent-teacher meeting',
  startsAt: STARTS,
  endsAt: ENDS,
  venue: 'School hall',
  details: null,
  status: 'published',
  charge: null,
  ...patch,
});

const studentMe = () =>
  guardianMe({
    id: '81',
    fullName: 'Ali Raza',
    roles: ['student'],
    capacities: ['student'],
    children: [],
  });

/** The detail screen's three reads, with the roster and payments given. */
const detailRoutes = (
  event: EventDto,
  rows: EventRosterRowDto[],
  payments: PaymentDto[] = [],
  extra: Record<string, (r: FakeRequest) => { status: number; body?: unknown }> = {},
) => ({
  'GET /api/v1/events/7': () => ({ status: 200, body: event }),
  'GET /api/v1/events/7/participation': () => ({
    status: 200,
    body: roster(rows, event.status),
  }),
  'GET /api/v1/events/7/payments': () => ({ status: 200, body: page(payments) }),
  ...extra,
});

beforeEach(async () => {
  await resetDevice();
  setOnline(true);
});
afterEach(() => queryClient.clear());

describe('the event model (pure)', () => {
  test('when: one day with both times, else both ends', () => {
    expect(eventWhen({ startsAt: STARTS, endsAt: ENDS })).toBe('14 Nov 2026, 10:00–12:00');
    expect(eventWhen({ startsAt: STARTS, endsAt: '2026-11-15T07:00:00.000Z' })).toMatch(
      /14 Nov 2026.*10:00 to 15 Nov 2026.*12:00/,
    );
  });

  test("the list's value: duties while open, the state when over", () => {
    expect(eventValue({ status: 'published', myDuties: ['collection', 'supervision'] })).toBe(
      'Collection, Supervision',
    );
    expect(eventValue({ status: 'published', myDuties: [] })).toBeNull();
    expect(eventValue({ status: 'completed', myDuties: ['collection'] })).toBe('Completed');
  });

  test('collecting needs a published, charged event and a collection duty', () => {
    expect(canCollect(eventDto())).toBe(true);
    expect(canCollect(eventDto({ myDuties: ['supervision'] }))).toBe(false);
    expect(canCollect(eventDto({ charge: null }))).toBe(false);
    expect(canCollect(eventDto({ status: 'completed' }))).toBe(false);
  });

  test('charge lines in whole rupees', () => {
    expect(chargeLine(null)).toBeNull();
    expect(chargeLine({ amount: 1500, outstanding: 1500 })).toBe('Rs 1,500 owed');
    expect(chargeLine({ amount: 1500, outstanding: 500 })).toBe('Rs 500 of Rs 1,500 owed');
    expect(chargeLine({ amount: 1500, outstanding: 0 })).toBe('Rs 1,500 · Paid');
  });

  test('only changed rows are sent', () => {
    const rows = [rosterRow(1, { participation: 'attended' }), rosterRow(2), rosterRow(3)];
    expect(changedRows(rows, { '501': 'attended', '502': 'absent' })).toEqual([
      { studentId: '502', status: 'absent' },
    ]);
  });

  test('the amount: present, above nothing, at most what is owed', () => {
    expect(amountProblem('', 300)).toBe('Enter the amount received.');
    expect(amountProblem('0', 300)).toBe('Enter more than Rs 0.');
    expect(amountProblem('301', 300)).toBe('At most Rs 300 is owed.');
    expect(amountProblem('300', 300)).toBeNull();
  });

  test("the server's refusals in words; a network failure is not definite", () => {
    const exceeds = new ApiError(
      409,
      ErrorCode.EVENT_PAYMENT_EXCEEDS_CHARGE,
      'x',
      {
        eventId: '7',
        outstanding: 100,
      },
      null,
    );
    expect(eventWriteFailure(exceeds)).toEqual({
      message: 'More than is owed: Rs 100 is outstanding now.',
      definite: true,
    });
    const own = new ApiError(
      409,
      ErrorCode.SELF_ACTION_FORBIDDEN,
      'x',
      { reason: 'own_child' },
      null,
    );
    expect(eventWriteFailure(own).message).toMatch(/your own child/);
    expect(eventWriteFailure(new TypeError('Network request failed')).definite).toBe(false);
  });

  test('both writes are online-only and neither is an outbox lane', () => {
    expect(ONLINE_ONLY_ACTIONS).toEqual(
      expect.arrayContaining(['record_event_participation', 'record_event_payment']),
    );
    for (const lane of Object.values(LANES)) expect(lane.path).not.toMatch(/\/events/);
  });
});

describe("the teacher's events", () => {
  test('Classes offers Events', async () => {
    await renderSignedIn(<MyClassesScreen />, teacherMe());
    fireEvent.press(await screen.findByTestId('classes.events'));
    expect(router.push).toHaveBeenCalledWith('/classes/events');
  });

  test('the list asks for mine; a row shows type, time and duties and opens the event', async () => {
    const { fake } = await renderSignedIn(<StaffEventsScreen />, teacherMe(), {
      'GET /api/v1/events': () => ({ status: 200, body: page([eventDto()]) }),
    });
    const row = await screen.findByTestId('events.row.7');
    expect(row).toHaveTextContent(/Museum trip/);
    expect(row).toHaveTextContent(/Trip · 14 Nov 2026, 10:00–12:00/);
    expect(row).toHaveTextContent(/Collection/);
    expect(fake.calls.find((c) => c.path === '/api/v1/events')?.query.get('mine')).toBe('true');
    fireEvent.press(row);
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/classes/events/[id]',
      params: { id: '7' },
    });
  });

  test('none says so; an error offers a retry', async () => {
    await renderSignedIn(<StaffEventsScreen />, teacherMe(), {
      'GET /api/v1/events': () => ({ status: 200, body: page([]) }),
    });
    expect(await screen.findByText('No events for you')).toBeOnTheScreen();
    screen.unmount();
    queryClient.clear();
    await renderSignedIn(<StaffEventsScreen />, teacherMe(), {
      'GET /api/v1/events': () => ({ status: 500, body: {} }),
    });
    expect(await screen.findByTestId('state.retry')).toBeOnTheScreen();
  });

  test('offline: needs a connection and asks nothing', async () => {
    setOnline(false);
    const { fake } = await renderSignedIn(<StaffEventsScreen />, teacherMe());
    expect(await screen.findByText('Needs a connection')).toBeOnTheScreen();
    screen.unmount();
    await renderSignedIn(<StaffEventScreen id="7" />, teacherMe());
    expect(await screen.findByText('Needs a connection')).toBeOnTheScreen();
    expect(fake.calls.some((c) => c.path.includes('/events'))).toBe(false);
  });
});

describe('an event on a duty', () => {
  test('details and duties; marks a student and saves only the change', async () => {
    const rows = [rosterRow(1), rosterRow(2, { participation: 'absent' })];
    const { fake } = await renderSignedIn(
      <StaffEventScreen id="7" />,
      teacherMe(),
      detailRoutes(eventDto({ myDuties: ['supervision'] }), rows, [], {
        'POST /api/v1/events/7/record-participation': () => ({
          status: 200,
          body: roster([rosterRow(1, { participation: 'attended' }), rows[1]!]),
        }),
      }),
    );
    expect(await screen.findByTestId('event.when')).toHaveTextContent('14 Nov 2026, 10:00–12:00');
    expect(screen.getByTestId('event.duties')).toHaveTextContent('Your duties: Supervision');
    expect(screen.getByTestId('event.charge')).toHaveTextContent(/Rs 300 a student/);
    expect(await screen.findByTestId('event.row.501')).toHaveTextContent(/Roll 1 · Class 5 A/);
    expect(screen.getByTestId('event.save')).toBeDisabled();
    fireEvent.press(screen.getByTestId('event.row.501.status.attended'));
    expect(screen.getByTestId('event.save')).toHaveTextContent('Save participation (1 changed)');
    fireEvent.press(screen.getByTestId('event.save'));
    expect(await screen.findByTestId('event.message')).toHaveTextContent('Participation saved.');
    const post = fake.calls.find((c) => c.path === '/api/v1/events/7/record-participation');
    expect(post?.body).toEqual({ rows: [{ studentId: '501', status: 'attended' }] });
    // Not a collector: no payments read, no collect button.
    expect(fake.calls.some((c) => c.path === '/api/v1/events/7/payments')).toBe(false);
    expect(screen.queryByTestId('event.row.501.collect')).toBeNull();
  });

  test('a class teacher with no duty: "Your classes take part"; the server\'s refusal is shown', async () => {
    const { fake } = await renderSignedIn(
      <StaffEventScreen id="7" />,
      teacherMe(),
      detailRoutes(eventDto({ myDuties: [] }), [rosterRow(1)], [], {
        'POST /api/v1/events/7/record-participation': () => ({
          status: 409,
          body: errorBody(ErrorCode.EVENT_NOT_PUBLISHED, 'x'),
        }),
      }),
    );
    expect(await screen.findByTestId('event.duties')).toHaveTextContent('Your classes take part.');
    fireEvent.press(await screen.findByTestId('event.row.501.status.excused'));
    const reads = fake.calls.filter((c) => c.path === '/api/v1/events/7').length;
    fireEvent.press(screen.getByTestId('event.save'));
    expect(await screen.findByTestId('event.save.failure')).toHaveTextContent(
      'This event is no longer open: it was completed or cancelled. Nothing was saved.',
    );
    // The refusal reads the event again, so a completed or cancelled event turns read-only.
    await waitFor(() =>
      expect(fake.calls.filter((c) => c.path === '/api/v1/events/7').length).toBeGreaterThan(reads),
    );
  });

  test('a completed event: participation read-only, nothing to collect', async () => {
    await renderSignedIn(
      <StaffEventScreen id="7" />,
      teacherMe(),
      detailRoutes(eventDto({ status: 'completed' }), [
        rosterRow(1, { participation: 'attended' }),
      ]),
    );
    expect(await screen.findByTestId('event.row.501')).toHaveTextContent(/Attended/);
    expect(screen.getByText('Completed: participation is closed.')).toBeOnTheScreen();
    expect(screen.queryByTestId('event.save')).toBeNull();
    expect(screen.queryByTestId('event.row.501.collect')).toBeNull();
  });

  test("a roster outside the caller's scope is an error with a retry", async () => {
    await renderSignedIn(<StaffEventScreen id="7" />, teacherMe(), {
      'GET /api/v1/events/7': () => ({ status: 200, body: eventDto({ myDuties: [] }) }),
    });
    expect(await screen.findByTestId('state.retry')).toBeOnTheScreen();
    expect(screen.getByTestId('event.details')).toBeOnTheScreen();
  });
});

describe('collecting on a collection duty', () => {
  test('lists own payments; records cash with a key, today, at most what is owed', async () => {
    const rows = [
      rosterRow(1),
      rosterRow(2, { charge: { chargeId: '902', amount: 300, outstanding: 0, status: 'paid' } }),
      rosterRow(3, { charge: null }),
    ];
    const { fake } = await renderSignedIn(
      <StaffEventScreen id="7" />,
      teacherMe(),
      detailRoutes(
        eventDto(),
        rows,
        [
          payment({
            id: '870',
            students: [{ studentId: '502', fullName: 'Sara Khan', amount: 300 }],
          }),
        ],
        {
          'POST /api/v1/events/7/payments': () => ({ status: 201, body: payment({ amount: 200 }) }),
        },
      ),
    );
    expect(await screen.findByTestId('event.payment.870')).toHaveTextContent(/Sara Khan/);
    expect(screen.getByTestId('event.payment.870')).toHaveTextContent(/Rs 300/);
    expect(screen.getByTestId('event.row.502')).toHaveTextContent(/Rs 300 · Paid/);
    expect(screen.queryByTestId('event.row.502.collect')).toBeNull();
    expect(screen.queryByTestId('event.row.503.collect')).toBeNull();
    // Security L2: a row without its dues (charge null) shows no money and no stray text.
    expect(screen.getByTestId('event.row.503')).not.toHaveTextContent(/owed|Paid|null/);

    fireEvent.press(screen.getByTestId('event.row.501.collect'));
    const amount = await screen.findByTestId('event.collect.amount');
    expect(amount.props.value).toBe('300');
    fireEvent.changeText(amount, '400');
    expect(screen.getByTestId('event.collect.amount.error')).toHaveTextContent(
      'At most Rs 300 is owed.',
    );
    expect(screen.getByTestId('event.collect.save')).toBeDisabled();
    fireEvent.changeText(amount, 'Rs 2,00');
    fireEvent.changeText(screen.getByTestId('event.collect.reference'), ' Book 4 ');
    fireEvent.press(screen.getByTestId('event.collect.save'));
    await eventually(() =>
      expect(screen.getByTestId('event.message')).toHaveTextContent(
        'Receipt 2026-27/0042: Rs 200 from Ali Raza recorded.',
      ),
    );
    const post = fake.calls.find(
      (c) => c.method === 'POST' && c.path === '/api/v1/events/7/payments',
    );
    expect(post?.body).toEqual({
      studentId: '501',
      amount: 200,
      receivedOn: TODAY,
      reference: 'Book 4',
    });
    expect(post?.headers.get('Idempotency-Key')).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(screen.queryByTestId('event.collectSheet')).toBeNull();
  });

  test('more than is owed now: the outstanding is said and a retry carries a new key', async () => {
    const keys: (string | null)[] = [];
    let first = true;
    await renderSignedIn(
      <StaffEventScreen id="7" />,
      teacherMe(),
      detailRoutes(eventDto(), [rosterRow(1)], [], {
        'POST /api/v1/events/7/payments': (r) => {
          keys.push(r.headers.get('Idempotency-Key'));
          if (first) {
            first = false;
            return {
              status: 409,
              body: errorBody(ErrorCode.EVENT_PAYMENT_EXCEEDS_CHARGE, 'Too much', {
                eventId: '7',
                outstanding: 100,
              }),
            };
          }
          return { status: 201, body: payment({ amount: 100 }) };
        },
      }),
    );
    fireEvent.press(await screen.findByTestId('event.row.501.collect'));
    fireEvent.press(await screen.findByTestId('event.collect.save'));
    await eventually(() =>
      expect(screen.getByTestId('event.collect.failure')).toHaveTextContent(
        'More than is owed: Rs 100 is outstanding now.',
      ),
    );
    fireEvent.changeText(screen.getByTestId('event.collect.amount'), '100');
    fireEvent.press(screen.getByTestId('event.collect.save'));
    await eventually(() => expect(screen.getByTestId('event.message')).toHaveTextContent(/Rs 100/));
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("the collector's own child is refused in words", async () => {
    await renderSignedIn(
      <StaffEventScreen id="7" />,
      teacherMe(),
      detailRoutes(eventDto(), [rosterRow(1)], [], {
        'POST /api/v1/events/7/payments': () => ({
          status: 409,
          body: errorBody(ErrorCode.SELF_ACTION_FORBIDDEN, 'own child', { reason: 'own_child' }),
        }),
      }),
    );
    fireEvent.press(await screen.findByTestId('event.row.501.collect'));
    fireEvent.press(await screen.findByTestId('event.collect.save'));
    await eventually(() =>
      expect(screen.getByTestId('event.collect.failure')).toHaveTextContent(
        /You cannot collect for your own child/,
      ),
    );
  });
});

describe("a family's events", () => {
  test("the child's card and the student's page offer Events", async () => {
    await renderSignedIn(<ChildrenScreen secure />, guardianMe(), {
      'GET /api/v1/me/children/501/attendance': () => ({ status: 404, body: {} }),
    });
    fireEvent.press(await screen.findByTestId('children.card.501.events'));
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/children/[studentId]/events',
      params: { studentId: '501' },
    });
    screen.unmount();
    await renderSignedIn(<StudentIndexScreen />, studentMe());
    fireEvent.press(await screen.findByTestId('student.events'));
    expect(router.push).toHaveBeenCalledWith('/student/events');
  });

  test("the child's events: details and the child's own charge", async () => {
    const { fake } = await renderSignedIn(
      <FamilyEventsScreen source={{ kind: 'child', studentId: '501' }} />,
      guardianMe(),
      {
        'GET /api/v1/me/children/501/events': () => ({
          status: 200,
          body: page([
            myEvent({
              id: '8',
              type: 'trip',
              title: 'Museum trip',
              venue: 'Lahore Museum',
              details: 'Bring a packed lunch.',
              charge: { amount: 300, outstanding: 100, status: 'partially_paid' },
            }),
            myEvent({ status: 'completed' }),
          ]),
        }),
      },
    );
    const trip = await screen.findByTestId('familyEvents.event.8');
    expect(trip).toHaveTextContent(/Museum trip/);
    expect(trip).toHaveTextContent(/14 Nov 2026, 10:00–12:00/);
    expect(trip).toHaveTextContent(/Lahore Museum/);
    expect(trip).toHaveTextContent(/Bring a packed lunch/);
    expect(screen.getByTestId('familyEvents.event.8.charge')).toHaveTextContent(
      'Charge: Rs 100 of Rs 300 owed',
    );
    expect(screen.getByTestId('familyEvents.event.7')).toHaveTextContent(
      /Parent-teacher meeting · Held/,
    );
    expect(screen.queryByTestId('familyEvents.event.7.charge')).toBeNull();
    expect(fake.calls.some((c) => c.path.includes('/me/student/'))).toBe(false);
  });

  test('the student: bound to /me/student; none says so', async () => {
    const { fake } = await renderSignedIn(
      <FamilyEventsScreen source={{ kind: 'own' }} />,
      studentMe(),
      { 'GET /api/v1/me/student/events': () => ({ status: 200, body: page([]) }) },
    );
    expect(await screen.findByText('No events yet')).toBeOnTheScreen();
    expect(fake.calls.some((c) => c.path === '/api/v1/me/student/events')).toBe(true);
  });

  test('an error offers a retry; offline needs a connection', async () => {
    await renderSignedIn(<FamilyEventsScreen source={{ kind: 'own' }} />, studentMe(), {
      'GET /api/v1/me/student/events': () => ({ status: 500, body: {} }),
    });
    expect(await screen.findByTestId('state.retry')).toBeOnTheScreen();
    screen.unmount();
    queryClient.clear();
    setOnline(false);
    await renderSignedIn(
      <FamilyEventsScreen source={{ kind: 'child', studentId: '501' }} />,
      guardianMe(),
    );
    expect(await screen.findByText('Needs a connection')).toBeOnTheScreen();
  });
});
