import { fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { MyDriverRouteDto, MyTransportDto } from '../api/contracts';
import { ChildrenScreen } from '../family/ChildrenScreen';
import { StudentIndexScreen } from '../family/StudentIndexScreen';
import { errorBody, resetDevice } from '../test/fake-api';
import { guardianMe, meFixture, teacherMe } from '../test/fixtures';
import { eventually, renderSignedIn, setOnline } from '../test/screen';
import { boardings, ridersLine, spanLine, stopLine } from './transport';
import { FamilyTransportScreen, MyRoutesCard, MyRoutesScreen } from './TransportScreens';

// Phase 5 slice 41 (contracts/slice-41.md §3, R330): a family's route — route, stop, pickup time
// and driver name — and a staff driver's routes with the riders by stop. Online only.

const CURRENT: NonNullable<MyTransportDto['current']> = {
  routeName: 'Model Town',
  stopName: 'Link Road',
  pickupTime: '07:05',
  driverName: 'Rashid Driver',
  startsOn: '2026-04-01',
  endsOn: null,
};

const ROUTE: MyDriverRouteDto = {
  id: '7',
  name: 'Model Town',
  vehicleRegistration: 'LES-1234',
  stops: [
    { id: '1', sortOrder: 1, name: 'Link Road', pickupTime: '07:05' },
    { id: '2', sortOrder: 2, name: 'Main Boulevard', pickupTime: null },
  ],
  students: [
    { name: 'Ali Raza', stopId: '1' },
    { name: 'Sara Khan', stopId: '1' },
    { name: 'Bilal Ahmed', stopId: null },
  ],
};

beforeEach(async () => {
  await resetDevice();
  setOnline(true);
});

describe('transport model', () => {
  test('stop and span lines', () => {
    expect(stopLine(CURRENT)).toBe('Link Road · pickup 07:05');
    expect(stopLine({ stopName: 'Link Road', pickupTime: null })).toBe('Link Road');
    expect(stopLine({ stopName: null, pickupTime: null })).toBeNull();
    expect(spanLine(CURRENT, '2026-10-06')).toBe('From 1 Apr 2026');
    expect(spanLine({ startsOn: '2026-11-01', endsOn: '2026-12-31' }, '2026-10-06')).toBe('Starts 1 Nov 2026 to 31 Dec 2026');
  });

  test('a driver sees each stop in order with who boards there, the stopless riders last', () => {
    expect(boardings(ROUTE)).toEqual([
      { title: 'Link Road', detail: '07:05', names: ['Ali Raza', 'Sara Khan'] },
      { title: 'Main Boulevard', detail: null, names: [] },
      { title: 'No stop chosen', detail: null, names: ['Bilal Ahmed'] },
    ]);
    expect(ridersLine(ROUTE)).toBe('3 riders');
    expect(ridersLine({ ...ROUTE, students: [ROUTE.students[0]!] })).toBe('1 rider');
  });
});

describe('family transport', () => {
  test("the child's route, stop, pickup time and driver", async () => {
    await renderSignedIn(<FamilyTransportScreen source={{ kind: 'child', studentId: '501' }} />, guardianMe(), {
      'GET /api/v1/me/children/501/transport': () => ({ status: 200, body: { current: CURRENT } }),
    });
    expect(await screen.findByTestId('familyTransport.route')).toHaveTextContent(/Model Town/);
    expect(screen.getByTestId('familyTransport.stop')).toHaveTextContent('Link Road · pickup 07:05');
    expect(screen.getByTestId('familyTransport.driver')).toHaveTextContent('Driver: Rashid Driver');
  });

  test("the student's own: no route reads as such; a failure offers a retry", async () => {
    let fail = true;
    await renderSignedIn(<FamilyTransportScreen source={{ kind: 'own' }} />, meFixture({ capacities: ['student'], roles: ['student'], staffId: null }), {
      'GET /api/v1/me/student/transport': () =>
        fail ? { status: 500, body: errorBody('INTERNAL_ERROR', 'Something went wrong.') } : { status: 200, body: { current: null } },
    });
    const retry = await screen.findByText(/Try again/i);
    fail = false;
    fireEvent.press(retry);
    expect(await screen.findByText('No school transport')).toBeTruthy();
  });

  test('offline: needs a connection, nothing cached', async () => {
    setOnline(false);
    const { fake } = await renderSignedIn(<FamilyTransportScreen source={{ kind: 'child', studentId: '501' }} />, guardianMe());
    expect(await screen.findByText('Needs a connection')).toBeTruthy();
    expect(fake.calls.filter((r) => r.path.includes('/transport'))).toEqual([]);
  });

  test("the child card and the student index open Transport", async () => {
    await renderSignedIn(<ChildrenScreen />, guardianMe(), {
      'GET /api/v1/me/children/501/attendance': () => ({ status: 200, body: { days: [], summary: null } }),
    });
    fireEvent.press(await screen.findByTestId('children.card.501.transport'));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/children/[studentId]/transport', params: { studentId: '501' } });
    screen.unmount();
    await renderSignedIn(<StudentIndexScreen />, meFixture({ capacities: ['student'], roles: ['student'], staffId: null }));
    fireEvent.press(await screen.findByTestId('student.transport'));
    expect(router.push).toHaveBeenCalledWith('/student/transport');
  });
});

describe('driver', () => {
  test('the Home card appears only for a driver and opens My routes', async () => {
    await renderSignedIn(<MyRoutesCard />, teacherMe(), {
      'GET /api/v1/me/staff/transport-routes': () => ({ status: 200, body: [ROUTE] }),
    });
    fireEvent.press(await screen.findByTestId('home.myRoutes.open'));
    expect(router.push).toHaveBeenCalledWith('/home/my-routes');
  });

  test('no route: no card', async () => {
    const { fake } = await renderSignedIn(<MyRoutesCard />, teacherMe(), {
      'GET /api/v1/me/staff/transport-routes': () => ({ status: 200, body: [] }),
    });
    await eventually(() => expect(fake.calls.some((r) => r.path === '/api/v1/me/staff/transport-routes')).toBe(true));
    expect(screen.queryByTestId('home.myRoutes')).toBeNull();
  });

  test('My routes lists the stops in order with who boards there', async () => {
    await renderSignedIn(<MyRoutesScreen secure />, teacherMe(), {
      'GET /api/v1/me/staff/transport-routes': () => ({ status: 200, body: [ROUTE] }),
    });
    const route = await screen.findByTestId('myRoutes.route.7');
    expect(route).toHaveTextContent(/LES-1234 · 3 riders/);
    expect(screen.getByTestId('myRoutes.route.7.stop.0')).toHaveTextContent(/Link Road · 07:05.*Ali Raza, Sara Khan/);
    expect(screen.getByTestId('myRoutes.route.7.stop.1')).toHaveTextContent(/Nobody boards here/);
    expect(screen.getByTestId('myRoutes.route.7.stop.2')).toHaveTextContent(/No stop chosen.*Bilal Ahmed/);
  });
});
