// Slice 41 test support (contracts/slice-41.md): a priced school in the 2026-27 session with two
// sections of one class, tuition at 3,000, the seeded Transport head, a van and a route at 2,000 a
// month set through the API, the HTTP helpers, and pupils assigned through the API on a moved
// school clock (SchoolClock overridden: an assignment starts no earlier than the clock's month).
import type { NestExpressApplication } from '@nestjs/platform-express';
import type request from 'supertest';
import { newIdempotencyKey } from '@asms/shared';
import { classWithSection, db, financeSchool, pupil, session2026, structure, type FinanceHeads, type Pupil } from '../fees/charges-support';
import { API, ORIGIN, paymentsHttp, type Session } from '../payments/payments-support';
import type { fixedClock } from '../payroll/support';
import type { TestSchool } from '../support/schools';
import { createSection, type TestAcademicYear, type TestSection } from '../support/students';

export interface ErrorBody {
  error: { code: string; details: { fields?: { path: string; code: string }[] } & Record<string, unknown> | null };
}
export const errorOf = (res: request.Response) => (res.body as ErrorBody).error;
export const fieldOf = (res: request.Response) => errorOf(res).details?.fields?.[0];

export interface Route {
  id: string;
  name: string;
  status: string;
  vehicle: { id: string; registration: string; capacity: number; driverName: string | null } | null;
  riders: number;
  currentAmount: number | null;
  nextAmount: { amount: number; effectivePeriod: string } | null;
  stopCount: number;
  stops: { id: string; sortOrder: number; name: string; pickupTime: string | null }[];
  amounts: { id: string; effectivePeriod: string; amount: number; voidedAt: string | null; voidable: boolean }[];
}

export interface Assignment {
  id: string;
  studentId: string;
  studentName: string;
  className: string | null;
  sectionName: string | null;
  routeId: string;
  routeName: string;
  stopId: string | null;
  stopName: string | null;
  pickupTime: string | null;
  startsOn: string;
  endsOn: string | null;
  status: string;
  endReason: string | null;
  capacityWarning?: { capacity: number; riders: number } | null;
}

export interface TransportWorld {
  school: TestSchool;
  heads: FinanceHeads & { transport: bigint };
  year: TestAcademicYear;
  classId: bigint;
  section: TestSection;
  section2: TestSection;
  principal: Session;
  office: Session;
  teacher: Session;
  driver: Session;
  vehicleId: string;
  route: Route;
}

type Clock = ReturnType<typeof fixedClock>;

export function transportHttp(app: () => NestExpressApplication, clock: Clock) {
  const h = paymentsHttp(app);
  const patch = (path: string, body: object, s: { cookie: string }) =>
    h.http().patch(`${API}${path}`).set('Cookie', s.cookie).set('Origin', ORIGIN).send(body);

  /** The world (see the header), its clock on `2026-04-01`. Vehicle capacity `capacity`. */
  async function world(opts: { capacity?: number } = {}): Promise<TransportWorld> {
    clock.state.today = '2026-04-01';
    const fs = await financeSchool();
    const principal = await h.signIn(fs.school, 'principal');
    const office = await h.signIn(fs.school, 'office_staff');
    const teacher = await h.signIn(fs.school, 'teacher');
    const driver = await h.signIn(fs.school, 'teacher');
    const year = await session2026(fs.school);
    const { classId, section } = await classWithSection(fs.school, year, 'Class 3');
    const section2 = await createSection(db(), fs.school, { id: classId, academicYearId: year.id }, { name: 'B' });
    await structure(fs.school, { academicYearId: year.id, classId, feeHeadId: fs.heads.tuition, amount: 3000, effectiveFrom: '2026-04' }, principal.user.userId);
    const transport = (await db().feeHead.findFirstOrThrow({ where: { schoolId: fs.school.id, category: 'transport' } })).id;
    const vehicle = await h
      .post('/vehicles', { registration: 'LES-1234', capacity: opts.capacity ?? 12, driverStaffId: driver.user.staffId.toString() }, office, newIdempotencyKey())
      .expect(201);
    const vehicleId = (vehicle.body as { id: string }).id;
    const created = await h
      .post(
        '/transport-routes',
        {
          name: 'Model Town',
          vehicleId,
          stops: [
            { sortOrder: 1, name: 'Link Road', pickupTime: '07:05' },
            { sortOrder: 2, name: 'Main Boulevard', pickupTime: '07:15' },
          ],
        },
        office,
        newIdempotencyKey(),
      )
      .expect(201);
    const route = created.body as Route;
    await h.post(`/transport-routes/${route.id}/amounts`, { amount: 2000, effectivePeriod: '2026-04' }, office).expect(201);
    return {
      ...fs,
      heads: { ...fs.heads, transport },
      year,
      classId,
      section,
      section2,
      principal,
      office,
      teacher,
      driver,
      vehicleId,
      route: (await h.get(`/transport-routes/${route.id}`, office).expect(200)).body as Route,
    };
  }

  /** A pupil of section A from 1 April (or `startedOn`). */
  const child = (w: TransportWorld, fullName: string, startedOn = '2026-04-01', guardianId?: bigint): Promise<Pupil> =>
    pupil(w.school, w.section, { startedOn, fullName, ...(guardianId === undefined ? {} : { guardianId }) });

  /** POST /transport-routes/:id/assignments with the clock on `startsOn`. */
  const assign = (w: TransportWorld, p: Pupil, startsOn: string, opts: { stopId?: string; routeId?: string; key?: string } = {}) => {
    clock.state.today = startsOn;
    return h.post(
      `/transport-routes/${opts.routeId ?? w.route.id}/assignments`,
      { studentId: p.studentId.toString(), startsOn, ...(opts.stopId === undefined ? {} : { stopId: opts.stopId }) },
      w.office,
      opts.key ?? newIdempotencyKey(),
    );
  };
  const assigned = async (w: TransportWorld, p: Pupil, startsOn: string, opts: { stopId?: string; routeId?: string } = {}): Promise<Assignment> => {
    const res = await assign(w, p, startsOn, opts);
    if (res.status !== 201) throw new Error(`assignment refused ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body as Assignment;
  };
  const end = (w: TransportWorld, id: string, endedOn: string, reason = 'Family moved house') =>
    h.post(`/transport-assignments/${id}/end`, { endedOn, reason }, w.office);

  /** The school's transport charges, oldest first. */
  const transportCharges = (w: TransportWorld, studentId?: bigint) =>
    db().charge.findMany({
      where: { schoolId: w.school.id, feeHeadId: w.heads.transport, ...(studentId === undefined ? {} : { studentId }) },
      orderBy: [{ period: 'asc' }, { id: 'asc' }],
    });

  const audits = (w: { school: TestSchool }, action: string) =>
    db().auditLog.findMany({ where: { schoolId: w.school.id, action }, orderBy: { id: 'asc' } });

  return { ...h, patch, world, child, assign, assigned, end, transportCharges, audits };
}
