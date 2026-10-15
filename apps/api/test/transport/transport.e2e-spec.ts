// Slice 41 over HTTP (phase-5-extended.md rule 37, R326, R329-R331; contracts/slice-41.md):
// vehicles, routes with their stops replaced as a whole, the assignment rules (one live per student
// per year, end-then-start, a reason to end, the stop and start checks), a retired vehicle and an
// archived route taking nothing new, capacity warning but never blocking, the student card in
// scope, the families' and the driver's reads, and the audit rows. The real AppModule and
// database, with the school's clock moved (SchoolClock overridden).
import { NestExpressApplication } from '@nestjs/platform-express';
import { ErrorCode, newIdempotencyKey } from '@asms/shared';
import { SchoolClock } from '../../src/common/school-clock';
import { createTestApp } from '../core/app';
import { guardianLogin, studentLogin } from '../diary/support';
import { db } from '../fees/charges-support';
import { fixedClock } from '../payroll/support';
import { closeTestDb } from '../support/schools';
import { createGuardian, createTeacherAssignment, linkGuardian } from '../support/students';
import { errorOf, fieldOf, transportHttp, type Assignment, type Route } from './support';

interface Vehicle {
  id: string;
  registration: string;
  capacity: number;
  driverStaffId: string | null;
  driverName: string | null;
  status: string;
  routeNames: string[];
}
interface PageOf<T> {
  data: T[];
  total: number;
}

describe('slice 41: transport (e2e)', () => {
  let app: NestExpressApplication;
  const clock = fixedClock('2026-04-01');
  const h = transportHttp(() => app, clock);
  const { get, post, patch } = h;

  beforeAll(async () => {
    app = await createTestApp({ overrides: [{ provide: SchoolClock, useValue: clock.value }] });
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  // ------------------------------------------------------------------------------ vehicles, routes

  it('R329: vehicles — one active per registration, a driver on staff, retire refused while a route uses it; teacher 403', async () => {
    const w = await h.world();
    const vehicles = (await get('/vehicles', w.office).expect(200)).body as PageOf<Vehicle>;
    expect(vehicles.data.map((v) => [v.registration, v.capacity, v.routeNames, v.driverName !== null])).toEqual([['LES-1234', 12, ['Model Town'], true]]);
    const dup = await post('/vehicles', { registration: ' les-1234 ', capacity: 20 }, w.office, newIdempotencyKey());
    expect([dup.status, errorOf(dup).code]).toEqual([409, ErrorCode.VEHICLE_REGISTRATION_TAKEN]);
    const badDriver = await post('/vehicles', { registration: 'LEB-77', capacity: 20, driverStaffId: '999999999' }, w.office, newIdempotencyKey());
    expect([badDriver.status, fieldOf(badDriver)?.path]).toEqual([422, 'driverStaffId']);
    const tooBig = await post('/vehicles', { registration: 'LEB-77', capacity: 121 }, w.office, newIdempotencyKey());
    expect(tooBig.status).toBe(422);
    expect((await post('/vehicles', { registration: 'LEB-77', capacity: 20 }, w.teacher, newIdempotencyKey())).status).toBe(403);

    const spare = (await post('/vehicles', { registration: 'LEB-77', capacity: 20 }, w.office, newIdempotencyKey()).expect(201)).body as Vehicle;
    const edited = (await patch(`/vehicles/${spare.id}`, { capacity: 8, driverStaffId: w.driver.user.staffId.toString() }, w.office).expect(200)).body as Vehicle;
    expect([edited.capacity, edited.driverStaffId]).toEqual([8, w.driver.user.staffId.toString()]);
    // An unchanged patch writes nothing.
    await patch(`/vehicles/${spare.id}`, { capacity: 8 }, w.office).expect(200);
    expect((await h.audits(w, 'vehicle.updated')).map((r) => r.metadata)).toEqual([{ fields: 'capacity,driverStaffId', capacity: 8, driverStaffId: w.driver.user.staffId.toString() }]);

    const inUse = await post(`/vehicles/${w.vehicleId}/retire`, { reason: 'Sold' }, w.office);
    expect([inUse.status, errorOf(inUse).code, errorOf(inUse).details?.routeId]).toEqual([409, ErrorCode.VEHICLE_IN_USE, w.route.id]);
    const retired = (await post(`/vehicles/${spare.id}/retire`, { reason: 'Engine failed' }, w.office).expect(200)).body as Vehicle;
    expect(retired.status).toBe('retired');
    const frozen = await patch(`/vehicles/${spare.id}`, { capacity: 9 }, w.office);
    expect([frozen.status, errorOf(frozen).code]).toEqual([409, ErrorCode.VEHICLE_RETIRED]);
    // R329: a retired vehicle takes no route.
    const onRetired = await patch(`/transport-routes/${w.route.id}`, { vehicleId: spare.id }, w.office);
    expect([onRetired.status, errorOf(onRetired).code]).toEqual([409, ErrorCode.VEHICLE_RETIRED]);
    // The registration is free again once retired.
    await post('/vehicles', { registration: 'LEB-77', capacity: 20 }, w.office, newIdempotencyKey()).expect(201);
    expect((await get('/vehicles?status=all', w.office).expect(200)).body).toMatchObject({ total: 3 });
    expect((await h.audits(w, 'vehicle.created')).length).toBe(3);
    expect((await h.audits(w, 'vehicle.retired')).map((r) => r.reason)).toEqual(['Engine failed']);
  });

  it('B8 (Phase 5 close): a driver who leaves is cleared from every active vehicle, audited with the reason', async () => {
    const w = await h.world();
    const driverId = w.driver.user.staffId.toString();
    const second = (await post('/vehicles', { registration: 'LEB-88', capacity: 20, driverStaffId: driverId }, w.office, newIdempotencyKey()).expect(201))
      .body as Vehicle;
    await post(`/staff/${driverId}/change-status`, { status: 'left', reason: 'Resigned' }, w.principal).expect(200);
    const vehicles = (await get('/vehicles', w.office).expect(200)).body as PageOf<Vehicle>;
    // Ordered by registration: LEB-88, then LES-1234.
    expect(vehicles.data.map((v) => [v.id, v.driverStaffId])).toEqual([
      [second.id, null],
      [w.vehicleId, null],
    ]);
    const updated = await h.audits(w, 'vehicle.updated');
    expect(updated.map((r) => [String(r.subjectId), r.reason, r.metadata]).sort()).toEqual(
      [w.vehicleId, second.id].sort().map((id) => [id, 'left', { fields: 'driverStaffId', driverStaffId: null, via: 'staff_left' }]),
    );
    const [changed] = await h.audits(w, 'staff.status_changed');
    expect((changed!.metadata as { vehiclesCleared: string }).vehiclesCleared.split(',').sort()).toEqual([w.vehicleId, second.id].sort());
  });

  it('stops are replaced as a whole: edited in place, added, reordered, ended with a reason; a stop in use stays', async () => {
    const w = await h.world();
    const [link, main] = w.route.stops;
    if (!link || !main) throw new Error('world has two stops');
    const swapped = (
      await patch(
        `/transport-routes/${w.route.id}`,
        {
          name: 'Model Town Morning',
          stops: [
            { id: main.id, sortOrder: 1, name: 'Main Boulevard', pickupTime: '07:00' },
            { id: link.id, sortOrder: 2, name: 'Link Road', pickupTime: '07:10' },
            { sortOrder: 3, name: 'Kalma Chowk' },
          ],
        },
        w.office,
      ).expect(200)
    ).body as Route;
    expect(swapped.name).toBe('Model Town Morning');
    expect(swapped.stops.map((s) => [s.id === main.id, s.sortOrder, s.name, s.pickupTime])).toEqual([
      [true, 1, 'Main Boulevard', '07:00'],
      [false, 2, 'Link Road', '07:10'],
      [false, 3, 'Kalma Chowk', null],
    ]);
    const [audit] = await h.audits(w, 'transport_route.updated');
    expect(audit?.metadata).toMatchObject({ fields: 'name', stopsAdded: 1, stopsEdited: 2, stopsEnded: 0 });

    const same = await patch(`/transport-routes/${w.route.id}`, { stops: [{ sortOrder: 1, name: 'A' }, { sortOrder: 1, name: 'B' }] }, w.office);
    expect([same.status, fieldOf(same)?.path]).toEqual([422, 'stops']);
    const foreign = await patch(`/transport-routes/${w.route.id}`, { stops: [{ id: '999999999', sortOrder: 1, name: 'A' }] }, w.office);
    expect([foreign.status, fieldOf(foreign)?.path]).toEqual([422, 'stops']);
    // Removing a stop needs a reason, and none may have a live rider.
    const keep = swapped.stops.filter((s) => s.name !== 'Kalma Chowk').map((s) => ({ id: s.id, sortOrder: s.sortOrder, name: s.name }));
    const noReason = await patch(`/transport-routes/${w.route.id}`, { stops: keep }, w.office);
    expect([noReason.status, fieldOf(noReason)?.path]).toEqual([422, 'reason']);
    const rider = await h.child(w, 'Hamza Tariq');
    await h.assigned(w, rider, '2026-04-01', { stopId: link.id });
    const inUse = await patch(`/transport-routes/${w.route.id}`, { stops: [{ id: main.id, sortOrder: 1, name: 'Main Boulevard' }], reason: 'Road closed' }, w.office);
    expect([inUse.status, errorOf(inUse).code, errorOf(inUse).details?.stopId]).toEqual([409, ErrorCode.TRANSPORT_STOP_IN_USE, link.id]);
    const ended = (await patch(`/transport-routes/${w.route.id}`, { stops: keep, reason: 'Road closed' }, w.office).expect(200)).body as Route;
    expect(ended.stops.map((s) => s.name)).toEqual(['Main Boulevard', 'Link Road']);
    expect((await h.audits(w, 'transport_route.updated')).at(-1)?.reason).toBe('Road closed');
  });

  it('R329: archive refused with live riders; an archived route takes no assignment, amount or edit; the name is free again', async () => {
    const w = await h.world();
    const a = await h.child(w, 'Hamza Tariq');
    const ride = await h.assigned(w, a, '2026-04-01');
    const busy = await post(`/transport-routes/${w.route.id}/archive`, { reason: 'Route merged' }, w.office);
    expect([busy.status, errorOf(busy).code]).toEqual([409, ErrorCode.TRANSPORT_ROUTE_HAS_ASSIGNMENTS]);
    await h.end(w, ride.id, '2026-04-30').expect(200);
    const archived = (await post(`/transport-routes/${w.route.id}/archive`, { reason: 'Route merged' }, w.office).expect(200)).body as Route;
    expect(archived.status).toBe('archived');
    expect((await h.audits(w, 'transport_route.archived')).map((r) => r.reason)).toEqual(['Route merged']);
    const b = await h.child(w, 'Hira Tariq');
    const late = await h.assign(w, b, '2026-04-01');
    expect([late.status, errorOf(late).code]).toEqual([409, ErrorCode.TRANSPORT_ROUTE_ARCHIVED]);
    const amount = await post(`/transport-routes/${w.route.id}/amounts`, { amount: 100, effectivePeriod: '2026-05' }, w.office);
    expect([amount.status, errorOf(amount).code]).toEqual([409, ErrorCode.TRANSPORT_ROUTE_ARCHIVED]);
    expect((await patch(`/transport-routes/${w.route.id}`, { name: 'X' }, w.office)).status).toBe(409);
    // The vehicle is free to retire now; the name to reuse.
    await post(`/vehicles/${w.vehicleId}/retire`, { reason: 'Sold' }, w.office).expect(200);
    await post('/transport-routes', { name: 'model town' }, w.office, newIdempotencyKey()).expect(201);
    expect((await get('/transport-routes?status=all', w.office).expect(200)).body).toMatchObject({ total: 2 });
    expect((await h.audits(w, 'transport_route.created')).length).toBe(2);
  });

  // ------------------------------------------------------------------------------- assignments

  it('R326: one live assignment per student per year, keyed replay, end-then-start, a reason to end; start and stop checks', async () => {
    const w = await h.world();
    const a = await h.child(w, 'Hamza Tariq');
    const key = newIdempotencyKey();
    const first = await h.assign(w, a, '2026-04-03', { key, stopId: w.route.stops[1]?.id });
    expect(first.status).toBe(201);
    const ride = first.body as Assignment;
    expect(ride).toMatchObject({ studentName: 'Hamza Tariq', className: 'Class 3', stopName: 'Main Boulevard', pickupTime: '07:15', status: 'live', endsOn: null, capacityWarning: null });
    const replay = await h.assign(w, a, '2026-04-03', { key, stopId: w.route.stops[1]?.id });
    expect([replay.status, replay.headers['idempotency-replayed'], (replay.body as Assignment).id]).toEqual([200, 'true', ride.id]);
    const twice = await h.assign(w, a, '2026-04-05');
    expect([twice.status, errorOf(twice).code, errorOf(twice).details?.assignmentId]).toEqual([409, ErrorCode.TRANSPORT_ASSIGNMENT_LIVE, ride.id]);
    expect((await h.audits(w, 'transport_assignment.started')).length).toBe(1);

    // Ending needs a reason; not before startsOn − 1, not after the year.
    clock.state.today = '2026-06-10';
    expect((await post(`/transport-assignments/${ride.id}/end`, { endedOn: '2026-06-10' }, w.office)).status).toBe(422);
    const tooEarly = await h.end(w, ride.id, '2026-04-01');
    expect([tooEarly.status, fieldOf(tooEarly)?.path]).toEqual([422, 'endedOn']);
    const tooLate = await h.end(w, ride.id, '2027-04-01');
    expect([tooLate.status, fieldOf(tooLate)?.path]).toEqual([422, 'endedOn']);
    const ended = (await h.end(w, ride.id, '2026-06-10').expect(200)).body as Assignment;
    expect([ended.status, ended.endsOn, ended.endReason]).toEqual(['ended', '2026-06-10', 'Family moved house']);
    expect((await h.end(w, ride.id, '2026-06-11')).status).toBe(409);
    expect((await h.audits(w, 'transport_assignment.ended')).map((r) => [r.reason, r.metadata])).toEqual([
      ['Family moved house', expect.objectContaining({ via: 'end', endsOn: '2026-06-10' })],
    ]);

    // A new start: after the last day, not before this month, a live stop of the route.
    const sameDay = await h.assign(w, a, '2026-06-10');
    expect([sameDay.status, fieldOf(sameDay)?.path]).toEqual([422, 'startsOn']);
    clock.state.today = '2026-07-02';
    const lastMonth = await post(`/transport-routes/${w.route.id}/assignments`, { studentId: a.studentId.toString(), startsOn: '2026-06-20' }, w.office, newIdempotencyKey());
    expect([lastMonth.status, fieldOf(lastMonth)?.path]).toEqual([422, 'startsOn']);
    const badStop = await h.assign(w, a, '2026-07-02', { stopId: '999999999' });
    expect([badStop.status, fieldOf(badStop)?.path]).toEqual([422, 'stopId']);
    await h.assigned(w, a, '2026-07-02');

    // No active enrolment: refused on studentId; another school's student: 404.
    const left = await h.child(w, 'Bilal Shah');
    await db().enrolment.updateMany({ where: { schoolId: w.school.id, id: left.enrolmentId }, data: { status: 'left', endedOn: new Date('2026-06-30T00:00:00.000Z') } });
    const gone = await h.assign(w, left, '2026-07-02');
    expect([gone.status, fieldOf(gone)?.path]).toEqual([422, 'studentId']);
    const other = await h.world();
    const stranger = await h.child(other, 'Sana Ali');
    expect((await h.assign(w, stranger, '2026-07-02')).status).toBe(404);
    expect((await post(`/transport-assignments/${ride.id}/end`, { endedOn: '2026-07-02', reason: 'Probe' }, other.office)).status).toBe(404);

    // The route's riders, live by default, ended on request, by name.
    const live = (await get(`/transport-routes/${w.route.id}/assignments`, w.office).expect(200)).body as PageOf<Assignment>;
    expect(live.data.map((r) => r.status)).toEqual(['live']);
    const all = (await get(`/transport-routes/${w.route.id}/assignments?includeEnded=true&studentName=hamza`, w.office).expect(200)).body as PageOf<Assignment>;
    expect(all.data.map((r) => r.status)).toEqual(['live', 'ended']);
  });

  it('R331: over capacity warns and is audited, never blocks', async () => {
    const w = await h.world({ capacity: 1 });
    const a = await h.child(w, 'Hamza Tariq');
    const b = await h.child(w, 'Hira Tariq');
    expect((await h.assigned(w, a, '2026-04-01')).capacityWarning).toBeNull();
    const over = await h.assigned(w, b, '2026-04-01');
    expect(over.capacityWarning).toEqual({ capacity: 1, riders: 2 });
    const [audit] = await h.audits(w, 'transport.capacity_exceeded');
    expect(audit?.metadata).toMatchObject({ routeId: w.route.id, vehicleId: w.vehicleId, capacity: 1, riders: 2 });
    // Lowering a vehicle's seats below its riders is allowed too.
    await patch(`/vehicles/${w.vehicleId}`, { capacity: 1 }, w.office).expect(200);
  });

  // ----------------------------------------------------------------------------------- reads

  it('the student card in scope: the office, the class teacher; another teacher 404', async () => {
    const w = await h.world();
    const a = await h.child(w, 'Hamza Tariq');
    const ride = await h.assigned(w, a, '2026-04-01');
    clock.state.today = '2026-05-31';
    await h.end(w, ride.id, '2026-05-31').expect(200);
    clock.state.today = '2026-06-01';
    const next = await h.assigned(w, a, '2026-06-01');
    const card = (await get(`/students/${a.studentId}/transport`, w.office).expect(200)).body as { current: Assignment | null; history: Assignment[] };
    expect([card.current?.id, card.history.map((r) => r.id)]).toEqual([next.id, [ride.id]]);
    await createTeacherAssignment(db(), w.school, { staffId: w.teacher.user.staffId }, { role: 'class_teacher', section: w.section, startsOn: '2026-04-01' });
    await get(`/students/${a.studentId}/transport`, w.teacher).expect(200);
    const outsider = await h.signIn(w.school, 'teacher');
    expect((await get(`/students/${a.studentId}/transport`, outsider)).status).toBe(404);
    expect((await get(`/transport-routes/${w.route.id}`, outsider)).status).toBe(403);
  });

  it("R330: families see their child's route, stop, pickup time and driver; the driver sees names and stops", async () => {
    const w = await h.world();
    await db().schoolSettings.updateMany({ where: { schoolId: w.school.id }, data: { studentLoginEnabled: true } });
    const guardian = await createGuardian(db(), w.school, { fullName: 'Tariq Mehmood' });
    const a = await h.child(w, 'Hamza Tariq', '2026-04-01', guardian.id);
    const b = await h.child(w, 'Hira Tariq');
    await db().studentGuardian.updateMany({ where: { schoolId: w.school.id }, data: { canLogin: true } });
    await h.assigned(w, a, '2026-04-01', { stopId: w.route.stops[0]?.id });
    const parent = await guardianLogin(db(), w.school, { id: guardian.id, cnic: null });
    const mine = (await get(`/me/children/${a.studentId}/transport`, parent).expect(200)).body as { current: Record<string, unknown> | null };
    const driverName = (await db().staff.findFirstOrThrow({ where: { schoolId: w.school.id, id: w.driver.user.staffId } })).fullName;
    expect(mine.current).toEqual({ routeName: 'Model Town', stopName: 'Link Road', pickupTime: '07:05', driverName, startsOn: '2026-04-01', endsOn: null });
    // Another family's child is 404; a child with no route reads null.
    expect((await get(`/me/children/${b.studentId}/transport`, parent)).status).toBe(404);
    const otherGuardian = await createGuardian(db(), w.school);
    await linkGuardian(db(), w.school, { id: b.studentId }, otherGuardian, { isPrimaryContact: false, canLogin: true });
    const otherParent = await guardianLogin(db(), w.school, { id: otherGuardian.id, cnic: null });
    expect(((await get(`/me/children/${b.studentId}/transport`, otherParent).expect(200)).body as { current: unknown }).current).toBeNull();
    const student = await studentLogin(db(), w.school, { id: a.studentId, bForm: null });
    expect(((await get('/me/student/transport', student).expect(200)).body as { current: { routeName: string } }).current.routeName).toBe('Model Town');

    // The driver: their routes, stops in order, riders by name and stop — nothing else.
    const routes = (await get('/me/staff/transport-routes', w.driver).expect(200)).body as {
      id: string;
      name: string;
      vehicleRegistration: string;
      stops: { name: string }[];
      students: Record<string, unknown>[];
    }[];
    expect(routes).toEqual([
      {
        id: w.route.id,
        name: 'Model Town',
        vehicleRegistration: 'LES-1234',
        stops: w.route.stops,
        students: [{ name: 'Hamza Tariq', stopId: w.route.stops[0]?.id }],
      },
    ]);
    // Any other staff member drives nothing.
    expect((await get('/me/staff/transport-routes', w.teacher).expect(200)).body).toEqual([]);
  });

  it('R329: a fee structure on the Transport head is refused (it is charged from the route)', async () => {
    const w = await h.world();
    const res = await post(
      '/fee-structures',
      { academicYearId: w.year.id.toString(), classId: w.classId.toString(), feeHeadId: w.heads.transport.toString(), amount: 1500, effectiveFrom: '2026-04' },
      w.principal,
      newIdempotencyKey(),
    );
    expect(res.status).toBe(422);
  });

  // ------------------------------------------------------------------------------ fix round

  it('POST /vehicles and POST /transport-routes need an Idempotency-Key; a replay answers 200 with the same row', async () => {
    const w = await h.world();
    const vehicle = { registration: 'LEB-99', capacity: 20 };
    const unkeyed = await post('/vehicles', vehicle, w.office);
    expect([unkeyed.status, fieldOf(unkeyed)?.path]).toEqual([422, 'Idempotency-Key']);
    const key = newIdempotencyKey();
    const first = await post('/vehicles', vehicle, w.office, key).expect(201);
    const replay = await post('/vehicles', vehicle, w.office, key);
    expect([replay.status, replay.headers['idempotency-replayed'], (replay.body as Vehicle).id]).toEqual([200, 'true', (first.body as Vehicle).id]);
    const reused = await post('/vehicles', { ...vehicle, capacity: 21 }, w.office, key);
    expect([reused.status, errorOf(reused).code]).toEqual([409, ErrorCode.IDEMPOTENCY_KEY_REUSED]);
    expect((await h.audits(w, 'vehicle.created')).length).toBe(2); // the world's van and this one

    const route = { name: 'Johar Town', stops: [{ sortOrder: 1, name: 'Canal Road' }] };
    const noKey = await post('/transport-routes', route, w.office);
    expect([noKey.status, fieldOf(noKey)?.path]).toEqual([422, 'Idempotency-Key']);
    const routeKey = newIdempotencyKey();
    const made = (await post('/transport-routes', route, w.office, routeKey).expect(201)).body as Route;
    const again = await post('/transport-routes', route, w.office, routeKey);
    expect([again.status, again.headers['idempotency-replayed'], (again.body as Route).id, (again.body as Route).stops.length]).toEqual([
      200,
      'true',
      made.id,
      1,
    ]);
    expect((await h.audits(w, 'transport_route.created')).length).toBe(2);
  });

  it('an end is never dated before the end of last month (the month may already be charged)', async () => {
    const w = await h.world();
    const a = await h.child(w, 'Hamza Tariq');
    const ride = await h.assigned(w, a, '2026-04-01');
    clock.state.today = '2026-06-10';
    const backdated = await h.end(w, ride.id, '2026-04-30');
    expect([backdated.status, fieldOf(backdated)?.path]).toEqual([422, 'endedOn']);
    expect(((await h.end(w, ride.id, '2026-05-31').expect(200)).body as Assignment).endsOn).toBe('2026-05-31');
  });

  it('the student card never shows an assignment that was never in force as current', async () => {
    const w = await h.world();
    const a = await h.child(w, 'Hamza Tariq');
    clock.state.today = '2026-04-01';
    const future = (
      await post(`/transport-routes/${w.route.id}/assignments`, { studentId: a.studentId.toString(), startsOn: '2026-04-20' }, w.office, newIdempotencyKey()).expect(201)
    ).body as Assignment;
    await h.end(w, future.id, '2026-04-19').expect(200);
    const card = (await get(`/students/${a.studentId}/transport`, w.office).expect(200)).body as { current: Assignment | null; history: Assignment[] };
    expect([card.current, card.history.map((r) => r.id)]).toEqual([null, [future.id]]);
  });

  it('R331: a replay answers the capacity warning from the live riders now', async () => {
    const w = await h.world({ capacity: 1 });
    const a = await h.child(w, 'Hamza Tariq');
    const b = await h.child(w, 'Hira Tariq');
    const first = await h.assigned(w, a, '2026-04-01');
    const key = newIdempotencyKey();
    expect(((await h.assign(w, b, '2026-04-01', { key }).expect(201)).body as Assignment).capacityWarning).toEqual({ capacity: 1, riders: 2 });
    const replay = await h.assign(w, b, '2026-04-01', { key });
    expect([replay.status, (replay.body as Assignment).capacityWarning]).toEqual([200, { capacity: 1, riders: 2 }]);
    await h.end(w, first.id, '2026-04-30').expect(200);
    expect(((await h.assign(w, b, '2026-04-01', { key }).expect(200)).body as Assignment).capacityWarning).toBeNull();
    // The replay audits nothing again.
    expect((await h.audits(w, 'transport.capacity_exceeded')).length).toBe(1);
  });
});
