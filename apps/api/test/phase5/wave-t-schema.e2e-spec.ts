// Phase 5 wave T in the database (migrations 20261014120000_wave_t_enums and
// 20261014120100_wave_t_transport_biometric; phase-5-extended.md §3.2 "Transport", "Biometric",
// R326-R331, R344-R348): every CHECK, partial unique, exclusion, trigger and composite foreign key
// of vehicles, transport_routes, transport_route_amounts, transport_stops, transport_assignments,
// device_punches, staff_attendance_disputes and staff_attendance.device_punch_id, written
// directly. Each statement is raw SQL inside one transaction that is rolled back, behind its own
// savepoint, so nothing here changes or removes a row even if a guard were missing (an exemption
// in guardrails/no-truncate.spec.ts). The last block maps a few refusals through the error mapper
// with committed rows of a school of its own.
import { ErrorCode } from '@asms/shared';
import { Client, type DatabaseError } from 'pg';
import { mapDatabaseError } from '../../src/common/errors/prisma-errors';
import { createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import { createAcademicYear, createClass, createSection, createStudent, day, enrol } from '../support/students';

const DELETABLE_NEVER = [
  'vehicles',
  'transport_routes',
  'transport_route_amounts',
  'transport_stops',
  'transport_assignments',
  'staff_attendance_disputes',
];
const APPEND_ONLY = ['device_punches'];
const ID = '4210112345671';

describe('wave T schema: transport, device punches and disputes (raw SQL)', () => {
  const db = testDb();
  let pg: Client;
  let seq = 0;
  let punchSeq = 0;
  let school: TestSchool;
  let schoolId: bigint;
  let otherStaffId: bigint;
  let otherSchoolId: bigint;
  let otherUserId: bigint;
  let principal: TestSchoolUser;
  let office: TestSchoolUser;
  let teacher: TestSchoolUser;
  let suspended: TestSchoolUser;
  let yearId: bigint;
  let nextYearId: bigint;
  let student1: bigint;
  let student2: bigint;
  let enrolment1: bigint;
  let enrolment2: bigint;
  let nextYearEnrolment1: bigint;

  const refusedBy = async (sql: string, params: unknown[] = []): Promise<string | null> => {
    const savepoint = `guard_${seq++}`;
    await pg.query(`SAVEPOINT ${savepoint}`);
    try {
      await pg.query(sql, params);
      return null;
    } catch (error) {
      const e = error as DatabaseError;
      return e.constraint ?? e.detail?.replace(/^constraint: /, '') ?? e.message;
    } finally {
      await pg.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    }
  };

  const truncateRefused = async (table: string): Promise<string | null> => {
    const refusal = await refusedBy(`TRUNCATE ${table}`);
    if (refusal === null || !/lock timeout/i.test(refusal)) return refusal;
    const guard = await pg.query(
      `SELECT 1 FROM pg_trigger WHERE tgrelid = $1::regclass AND (tgtype & 32) <> 0 AND NOT tgisinternal`,
      [table],
    );
    return (guard.rowCount ?? 0) > 0 ? `${table}: guarded (busy)` : null;
  };

  const one = async (sql: string, params: unknown[] = []): Promise<bigint> => {
    const { rows } = await pg.query<{ id: string }>(sql, params);
    return BigInt(rows[0]!.id);
  };

  // ---- builders, inside the open transaction (kept until the final rollback)

  const vehicle = (registration = `LEA-${seq++}`): Promise<bigint> =>
    one(
      `INSERT INTO vehicles (school_id, registration, capacity, driver_staff_id, created_by)
       VALUES ($1, $2, 30, $3, $4) RETURNING id`,
      [schoolId, registration, teacher.staffId, office.userId],
    );

  const route = (vehicleId: bigint | null = null, name = `Route ${seq++}`): Promise<bigint> =>
    one(
      `INSERT INTO transport_routes (school_id, name, vehicle_id, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
      [schoolId, name, vehicleId, office.userId],
    );

  const stop = (routeId: bigint, sortOrder: number, name = `Stop ${seq++}`): Promise<bigint> =>
    one(
      `INSERT INTO transport_stops (school_id, route_id, sort_order, name, pickup_time)
       VALUES ($1, $2, $3, $4, '07:15') RETURNING id`,
      [schoolId, routeId, sortOrder, name],
    );

  const assign = (
    routeId: bigint,
    o: { stopId?: bigint | null; student?: bigint; enrolment?: bigint; startsOn?: string } = {},
  ): Promise<bigint> =>
    one(
      `INSERT INTO transport_assignments (school_id, student_id, academic_year_id, enrolment_id, route_id, stop_id, starts_on, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [schoolId, o.student ?? student1, yearId, o.enrolment ?? enrolment1, routeId, o.stopId ?? null, o.startsOn ?? '2026-05-01', office.userId],
    );

  const endAssignment = (id: bigint, endsOn = '2026-06-30') =>
    pg.query(
      `UPDATE transport_assignments SET ended_at = now(), ended_by = $2, end_reason = 'Moved house', ends_on = $3 WHERE id = $1`,
      [id, office.userId, endsOn],
    );

  const archive = (routeId: bigint) =>
    pg.query(
      `UPDATE transport_routes SET status = 'archived', archived_at = now(), archived_by = $2, archive_reason = 'Closed' WHERE id = $1`,
      [routeId, office.userId],
    );

  const retire = (vehicleId: bigint) =>
    pg.query(
      `UPDATE vehicles SET status = 'retired', retired_at = now(), retired_by = $2, retire_reason = 'Sold' WHERE id = $1`,
      [vehicleId, office.userId],
    );

  const punch = (
    o: { staffId?: bigint | null; deviceUserId?: string; at?: string; outcome?: string } = {},
  ): Promise<bigint> =>
    one(
      `INSERT INTO device_punches (school_id, staff_id, device_user_id, punched_at, direction, outcome)
       VALUES ($1, $2, $3, $4::timestamptz, 'in', $5::punch_outcome) RETURNING id`,
      [
        schoolId,
        o.staffId === undefined ? teacher.staffId : o.staffId,
        o.deviceUserId ?? `T${schoolId}`,
        o.at ?? new Date(Date.UTC(2026, 8, 1, 3) + ++punchSeq * 60_000).toISOString(),
        o.outcome ?? 'marked',
      ],
    );

  /** A manual mark of `staffId` on `date`, made by the office. */
  const manualMark = (staffId: bigint, date: string): Promise<bigint> =>
    one(
      `INSERT INTO staff_attendance (school_id, staff_id, date, status, marked_by) VALUES ($1, $2, $3, 'present', $4) RETURNING id`,
      [schoolId, staffId, date, office.userId],
    );

  const dispute = (attendanceId: bigint, member: TestSchoolUser): Promise<bigint> =>
    one(
      `INSERT INTO staff_attendance_disputes (school_id, attendance_id, staff_id, raised_by, requested_status, reason)
       VALUES ($1, $2, $3, $4, 'present', 'I was in school that day') RETURNING id`,
      [schoolId, attendanceId, member.staffId, member.userId],
    );

  beforeAll(async () => {
    school = await createSchool();
    schoolId = school.id;
    const other = await createSchool();
    const otherUser = await createSchoolUser(db, other, { systemRole: 'teacher' });
    otherSchoolId = other.id;
    otherStaffId = otherUser.staffId;
    otherUserId = otherUser.userId;
    principal = await createSchoolUser(db, school, { systemRole: 'principal' });
    office = await createSchoolUser(db, school, { systemRole: 'office_staff' });
    teacher = await createSchoolUser(db, school, { systemRole: 'teacher' });
    suspended = await createSchoolUser(db, school, { systemRole: 'teacher', staffStatus: 'suspended' });
    const year = await createAcademicYear(db, school, { startsOn: '2026-04-01', endsOn: '2027-03-31' });
    yearId = year.id;
    const klass = await createClass(db, school, year);
    const section = await createSection(db, school, klass);
    const nextYear = await createAcademicYear(db, school, { startsOn: '2027-04-01', endsOn: '2028-03-31' });
    nextYearId = nextYear.id;
    const nextSection = await createSection(db, school, await createClass(db, school, nextYear));
    const s1 = await createStudent(db, school, { admittedOn: '2026-04-01' });
    const s2 = await createStudent(db, school, { admittedOn: '2026-04-01' });
    student1 = s1.id;
    student2 = s2.id;
    enrolment1 = (await enrol(db, school, s1, section, { startedOn: '2026-04-01' })).id;
    enrolment2 = (await enrol(db, school, s2, section, { startedOn: '2026-04-01' })).id;
    nextYearEnrolment1 = (
      await enrol(db, school, s1, nextSection, { status: 'left', startedOn: '2027-04-01', endedOn: '2027-04-30' })
    ).id;
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query('BEGIN');
    await pg.query(`SET LOCAL lock_timeout = '5s'`);
    await pg.query(`UPDATE staff SET device_user_id = $3 WHERE school_id = $1 AND id = $2`, [schoolId, teacher.staffId, `T${schoolId}`]);
    await pg.query(`UPDATE staff SET device_user_id = $3 WHERE school_id = $1 AND id = $2`, [schoolId, suspended.staffId, `S${schoolId}`]);
  });

  afterAll(async () => {
    await pg.query('ROLLBACK');
    await pg.end();
    await closeTestDb();
  });

  // ---------------------------------------------------------------------------- vehicles

  describe('vehicles (R329, R331)', () => {
    it('a vehicle is born active; registration, capacity and the retire group are checked', async () => {
      expect(await refusedBy(
        `INSERT INTO vehicles (school_id, registration, capacity, status, retired_at, retired_by, retire_reason, created_by)
         VALUES ($1, 'LEB-1', 20, 'retired', now(), $2, 'Sold', $2)`,
        [schoolId, office.userId],
      )).toBe('vehicles_born_active');
      const id = await vehicle();
      const cases: [string, unknown[], string][] = [
        [`UPDATE vehicles SET registration = ' LEB-2' WHERE id = $1`, [id], 'vehicles_registration_check'],
        [`UPDATE vehicles SET registration = $2 WHERE id = $1`, [id, ID], 'vehicles_registration_no_id_check'],
        [`UPDATE vehicles SET capacity = 0 WHERE id = $1`, [id], 'vehicles_capacity_check'],
        [`UPDATE vehicles SET capacity = 121 WHERE id = $1`, [id], 'vehicles_capacity_check'],
        [`UPDATE vehicles SET status = 'retired' WHERE id = $1`, [id], 'vehicles_retired_check'],
        [`UPDATE vehicles SET status = 'retired', retired_at = now(), retired_by = $2, retire_reason = $3 WHERE id = $1`, [id, office.userId, `Sold ${ID}`], 'vehicles_retire_reason_no_id_check'],
        [`UPDATE vehicles SET status = 'retired', retired_at = now(), retired_by = $2, retire_reason = ' ' WHERE id = $1`, [id, office.userId], 'vehicles_retire_reason_check'],
        [`UPDATE vehicles SET driver_staff_id = $2 WHERE id = $1`, [id, otherStaffId], 'vehicles_driver_staff_id_fkey'],
      ];
      for (const [sql, params, constraint] of cases) expect(await refusedBy(sql, params)).toBe(constraint);
      expect(await refusedBy(`UPDATE vehicles SET capacity = 120, driver_staff_id = NULL WHERE id = $1`, [id])).toBeNull();
    });

    it('§3.2: one active vehicle per registration, case-insensitively; retiring frees it', async () => {
      const first = await vehicle('LEC-777');
      expect(await refusedBy(
        `INSERT INTO vehicles (school_id, registration, capacity, created_by) VALUES ($1, 'lec-777', 20, $2)`,
        [schoolId, office.userId],
      )).toBe('vehicles_live_registration_key');
      await retire(first);
      expect(await refusedBy(
        `INSERT INTO vehicles (school_id, registration, capacity, created_by) VALUES ($1, 'lec-777', 20, $2)`,
        [schoolId, office.userId],
      )).toBeNull();
    });

    it('a retired vehicle is history: no edit, no return, the retire group frozen', async () => {
      const id = await vehicle();
      await retire(id);
      expect(await refusedBy(`UPDATE vehicles SET capacity = 10 WHERE id = $1`, [id])).toBe('vehicles_capacity_frozen');
      expect(await refusedBy(`UPDATE vehicles SET driver_staff_id = NULL WHERE id = $1`, [id])).toBe('vehicles_driver_staff_id_frozen');
      expect(await refusedBy(`UPDATE vehicles SET status = 'active' WHERE id = $1`, [id])).toBe('vehicles_status_transition');
      expect(await refusedBy(`UPDATE vehicles SET retire_reason = 'Scrapped' WHERE id = $1`, [id])).toBe('vehicles_retire_reason_frozen');
      expect(await refusedBy(`UPDATE vehicles SET created_by = $2 WHERE id = $1`, [id, principal.userId])).toBe('vehicles_created_by_immutable');
    });

    it('VEHICLE_IN_USE: a vehicle an active route names is not retired; once the route is archived it is', async () => {
      const id = await vehicle();
      const routeId = await route(id);
      expect(await refusedBy(
        `UPDATE vehicles SET status = 'retired', retired_at = now(), retired_by = $2, retire_reason = 'Sold' WHERE id = $1`,
        [id, office.userId],
      )).toBe('vehicles_in_use');
      await archive(routeId);
      expect(await refusedBy(
        `UPDATE vehicles SET status = 'retired', retired_at = now(), retired_by = $2, retire_reason = 'Sold' WHERE id = $1`,
        [id, office.userId],
      )).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------- routes

  describe('transport_routes (R329)', () => {
    it('a route is born active, named, unique among active routes case-insensitively', async () => {
      expect(await refusedBy(
        `INSERT INTO transport_routes (school_id, name, status, archived_at, archived_by, archive_reason, created_by)
         VALUES ($1, 'Gulberg', 'archived', now(), $2, 'Closed', $2)`,
        [schoolId, office.userId],
      )).toBe('transport_routes_born_active');
      const id = await route(null, 'Model Town');
      expect(await refusedBy(
        `INSERT INTO transport_routes (school_id, name, created_by) VALUES ($1, 'model town', $2)`,
        [schoolId, office.userId],
      )).toBe('transport_routes_live_name_key');
      const cases: [string, unknown[], string][] = [
        [`UPDATE transport_routes SET name = 'Model Town ' WHERE id = $1`, [id], 'transport_routes_name_check'],
        [`UPDATE transport_routes SET name = $2 WHERE id = $1`, [id, ID], 'transport_routes_name_no_id_check'],
        [`UPDATE transport_routes SET status = 'archived' WHERE id = $1`, [id], 'transport_routes_archived_check'],
        [`UPDATE transport_routes SET status = 'archived', archived_at = now(), archived_by = $2, archive_reason = $3 WHERE id = $1`, [id, office.userId, ID], 'transport_routes_archive_reason_no_id_check'],
      ];
      for (const [sql, params, constraint] of cases) expect(await refusedBy(sql, params)).toBe(constraint);
      await archive(id);
      expect(await refusedBy(
        `INSERT INTO transport_routes (school_id, name, created_by) VALUES ($1, 'model town', $2)`,
        [schoolId, office.userId],
      )).toBeNull();
    });

    it('VEHICLE_RETIRED: a route names only an active vehicle of the school, on insert and on a change', async () => {
      const retired = await vehicle();
      await retire(retired);
      expect(await refusedBy(
        `INSERT INTO transport_routes (school_id, name, vehicle_id, created_by) VALUES ($1, 'Johar Town', $2, $3)`,
        [schoolId, retired, office.userId],
      )).toBe('transport_routes_vehicle_active');
      const id = await route(await vehicle());
      expect(await refusedBy(`UPDATE transport_routes SET vehicle_id = $2 WHERE id = $1`, [id, retired])).toBe('transport_routes_vehicle_active');
      expect(await refusedBy(`UPDATE transport_routes SET vehicle_id = NULL WHERE id = $1`, [id])).toBeNull();
      const otherVehicle = await one(
        `INSERT INTO vehicles (school_id, registration, capacity, created_by) VALUES ($1, 'OTHER-1', 20, $2) RETURNING id`,
        [otherSchoolId, otherUserId],
      );
      expect(await refusedBy(`UPDATE transport_routes SET vehicle_id = $2 WHERE id = $1`, [id, otherVehicle])).toBe('transport_routes_vehicle_id_fkey');
    });

    it('R329: a route with a live assignment is not archived; an archived route is history', async () => {
      const id = await route();
      const assignment = await assign(id);
      expect(await refusedBy(
        `UPDATE transport_routes SET status = 'archived', archived_at = now(), archived_by = $2, archive_reason = 'Closed' WHERE id = $1`,
        [id, office.userId],
      )).toBe('transport_routes_has_assignments');
      await endAssignment(assignment);
      await archive(id);
      expect(await refusedBy(`UPDATE transport_routes SET name = 'Renamed' WHERE id = $1`, [id])).toBe('transport_routes_name_frozen');
      expect(await refusedBy(`UPDATE transport_routes SET vehicle_id = $2 WHERE id = $1`, [id, await vehicle()])).toBe('transport_routes_vehicle_id_frozen');
      expect(await refusedBy(`UPDATE transport_routes SET archive_reason = 'Other' WHERE id = $1`, [id])).toBe('transport_routes_archive_reason_frozen');
      expect(await refusedBy(`UPDATE transport_routes SET status = 'active' WHERE id = $1`, [id])).toBe('transport_routes_status_transition');
    });
  });

  // ---------------------------------------------------------------------------- amounts

  describe('transport_route_amounts (R327; voided once, before its period)', () => {
    const amountSql = `INSERT INTO transport_route_amounts (school_id, route_id, effective_period, amount, created_by)
       VALUES ($1, $2, $3, $4, $5)`;

    it('a period is YYYY-MM, an amount whole rupees >= 0, one per route and period', async () => {
      const id = await route();
      expect(await refusedBy(amountSql, [schoolId, id, '2026-13', 2500, office.userId])).toBe('transport_route_amounts_period_check');
      expect(await refusedBy(amountSql, [schoolId, id, '2026-5 ', 2500, office.userId])).toBe('transport_route_amounts_period_check');
      expect(await refusedBy(amountSql, [schoolId, id, '2026-05', -1, office.userId])).toBe('transport_route_amounts_amount_check');
      expect(await refusedBy(amountSql, [schoolId, id, '2026-05', 0, office.userId])).toBeNull();
      await pg.query(amountSql, [schoolId, id, '2026-05', 2500, office.userId]);
      expect(await refusedBy(amountSql, [schoolId, id, '2026-05', 3000, office.userId])).toBe('transport_route_amounts_route_period_key');
      expect(await refusedBy(amountSql, [schoolId, id, '2026-06', 3000, office.userId])).toBeNull();
    });

    /** The school's current and next period, in its time zone (Asia/Karachi), as the guard reads them. */
    const periods = async (): Promise<{ current: string; next: string; past: string }> => {
      const { rows } = await pg.query<{ current: string; next: string; past: string }>(
        `SELECT to_char(t, 'YYYY-MM') AS current, to_char(t + interval '1 month', 'YYYY-MM') AS next,
                to_char(t - interval '1 month', 'YYYY-MM') AS past
           FROM (SELECT now() AT TIME ZONE s.timezone AS t FROM schools s WHERE s.id = $1) x`,
        [schoolId],
      );
      return rows[0]!;
    };
    const voidSql = `UPDATE transport_route_amounts SET voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1`;

    it('amounts are never edited or removed, and are born live; an archived route takes none', async () => {
      const id = await route();
      const amount = await one(`${amountSql} RETURNING id`, [schoolId, id, '2026-05', 2500, office.userId]);
      expect(await refusedBy(`UPDATE transport_route_amounts SET amount = 1 WHERE id = $1`, [amount])).toBe('transport_route_amounts_amount_immutable');
      expect(await refusedBy(`UPDATE transport_route_amounts SET effective_period = '2026-06' WHERE id = $1`, [amount])).toBe('transport_route_amounts_effective_period_immutable');
      expect(await refusedBy(
        `INSERT INTO transport_route_amounts (school_id, route_id, effective_period, amount, created_by, voided_at, voided_by, void_reason)
         VALUES ($1, $2, '2099-01', 100, $3, now(), $3, 'Typo')`,
        [schoolId, id, office.userId],
      )).toBe('transport_route_amounts_born_live');
      await archive(id);
      expect(await refusedBy(amountSql, [schoolId, id, '2026-07', 3000, office.userId])).toBe('transport_route_amounts_route_active');
    });

    it('a future amount is voided once and replaced for the same period; the void group is checked', async () => {
      const { next } = await periods();
      const id = await route();
      const mistaken = await one(`${amountSql} RETURNING id`, [schoolId, id, next, 25000, office.userId]);
      const cases: [string, unknown[], string][] = [
        [`UPDATE transport_route_amounts SET voided_at = now() WHERE id = $1`, [mistaken], 'transport_route_amounts_voided_check'],
        [voidSql, [mistaken, office.userId, ' Typo'], 'transport_route_amounts_void_reason_check'],
        [voidSql, [mistaken, office.userId, `Typo ${ID}`], 'transport_route_amounts_void_reason_no_id_check'],
      ];
      for (const [sql, params, constraint] of cases) expect(await refusedBy(sql, params)).toBe(constraint);
      await pg.query(voidSql, [mistaken, office.userId, 'Typed an extra zero']);
      expect(await refusedBy(amountSql, [schoolId, id, next, 2500, office.userId])).toBeNull();
      await pg.query(amountSql, [schoolId, id, next, 2500, office.userId]);
      // One live amount per period still: a second live row is refused.
      expect(await refusedBy(amountSql, [schoolId, id, next, 2600, office.userId])).toBe('transport_route_amounts_route_period_key');
      // Voided once: neither a second void nor an un-void.
      expect(await refusedBy(
        `UPDATE transport_route_amounts SET voided_at = now() + interval '1 minute', void_reason = 'Again' WHERE id = $1`,
        [mistaken],
      )).toBe('transport_route_amounts_voided_at_frozen');
      expect(await refusedBy(
        `UPDATE transport_route_amounts SET voided_at = NULL, voided_by = NULL, void_reason = NULL WHERE id = $1`,
        [mistaken],
      )).toBe('transport_route_amounts_voided_at_frozen');
    });

    it('TRANSPORT_AMOUNT_PERIOD_PAST: the current and a past period are never voided', async () => {
      const { current, past } = await periods();
      const id = await route();
      for (const period of [current, past]) {
        const amount = await one(`${amountSql} RETURNING id`, [schoolId, id, period, 2500, office.userId]);
        expect(await refusedBy(voidSql, [amount, office.userId, 'Wrong amount'])).toBe('transport_route_amounts_void_period_started');
      }
    });
  });

  // ---------------------------------------------------------------------------- stops

  describe('transport_stops', () => {
    it('order 1-100, a trimmed name, the end group together, born live', async () => {
      const id = await route();
      const stopId = await stop(id, 1);
      const cases: [string, unknown[], string][] = [
        [`UPDATE transport_stops SET sort_order = 0 WHERE id = $1`, [stopId], 'transport_stops_sort_order_check'],
        [`UPDATE transport_stops SET sort_order = 101 WHERE id = $1`, [stopId], 'transport_stops_sort_order_check'],
        [`UPDATE transport_stops SET name = '' WHERE id = $1`, [stopId], 'transport_stops_name_check'],
        [`UPDATE transport_stops SET name = $2 WHERE id = $1`, [stopId, `Gate ${ID}`], 'transport_stops_name_no_id_check'],
        [`UPDATE transport_stops SET ended_at = now() WHERE id = $1`, [stopId], 'transport_stops_ended_check'],
        [`UPDATE transport_stops SET ended_at = now(), ended_by = $2, end_reason = $3 WHERE id = $1`, [stopId, office.userId, ID], 'transport_stops_end_reason_no_id_check'],
        [`UPDATE transport_stops SET route_id = $2 WHERE id = $1`, [stopId, await route()], 'transport_stops_route_id_immutable'],
      ];
      for (const [sql, params, constraint] of cases) expect(await refusedBy(sql, params)).toBe(constraint);
      expect(await refusedBy(
        `INSERT INTO transport_stops (school_id, route_id, sort_order, name, ended_at, ended_by, end_reason)
         VALUES ($1, $2, 2, 'Canal', now(), $3, 'Gone')`,
        [schoolId, id, office.userId],
      )).toBe('transport_stops_born_live');
    });

    it('§3.2: live stops of a route have distinct orders, checked at commit, so a reorder swaps', async () => {
      const id = await route();
      const a = await stop(id, 1);
      const b = await stop(id, 2);
      // Deferred: the duplicate is found when the constraint is checked (here, made immediate).
      expect(await refusedBy(
        `SET CONSTRAINTS transport_stops_live_order_excl IMMEDIATE;
         INSERT INTO transport_stops (school_id, route_id, sort_order, name) VALUES (${schoolId}, ${id}, 1, 'Duplicate');`,
      )).toBe('transport_stops_live_order_excl');
      expect(await refusedBy(
        `UPDATE transport_stops SET sort_order = 2 WHERE id = ${a};
         UPDATE transport_stops SET sort_order = 1 WHERE id = ${b};
         SET CONSTRAINTS transport_stops_live_order_excl IMMEDIATE;`,
      )).toBeNull();
      await pg.query('SET CONSTRAINTS transport_stops_live_order_excl DEFERRED');
      // An ended stop frees its order; another route has its own.
      await pg.query(`UPDATE transport_stops SET ended_at = now(), ended_by = $2, end_reason = 'Moved' WHERE id = $1`, [a, office.userId]);
      expect(await refusedBy(
        `INSERT INTO transport_stops (school_id, route_id, sort_order, name) VALUES (${schoolId}, ${id}, 1, 'New first');
         INSERT INTO transport_stops (school_id, route_id, sort_order, name) VALUES (${schoolId}, ${await route()}, 2, 'Elsewhere');
         SET CONSTRAINTS transport_stops_live_order_excl IMMEDIATE;`,
      )).toBeNull();
      await pg.query('SET CONSTRAINTS transport_stops_live_order_excl DEFERRED');
    });

    it('TRANSPORT_STOP_IN_USE: a stop a live assignment names is not ended; an ended stop is history', async () => {
      const id = await route();
      const stopId = await stop(id, 1);
      const assignment = await assign(id, { stopId });
      const endStop = `UPDATE transport_stops SET ended_at = now(), ended_by = $2, end_reason = 'Road closed' WHERE id = $1`;
      expect(await refusedBy(endStop, [stopId, office.userId])).toBe('transport_stops_in_use');
      await endAssignment(assignment);
      await pg.query(endStop, [stopId, office.userId]);
      expect(await refusedBy(`UPDATE transport_stops SET name = 'Renamed' WHERE id = $1`, [stopId])).toBe('transport_stops_name_frozen');
      expect(await refusedBy(`UPDATE transport_stops SET pickup_time = '08:00' WHERE id = $1`, [stopId])).toBe('transport_stops_pickup_time_frozen');
    });

    it('the stops of an archived route are not written', async () => {
      const id = await route();
      const stopId = await stop(id, 1);
      await archive(id);
      expect(await refusedBy(`UPDATE transport_stops SET name = 'Renamed' WHERE id = $1`, [stopId])).toBe('transport_stops_route_active');
      expect(await refusedBy(
        `INSERT INTO transport_stops (school_id, route_id, sort_order, name) VALUES ($1, $2, 2, 'Late')`,
        [schoolId, id],
      )).toBe('transport_stops_route_active');
    });
  });

  // ---------------------------------------------------------------------------- assignments

  describe('transport_assignments (A8, R326, R329)', () => {
    it('A8, R326: one live assignment per student per year; ending it frees the student', async () => {
      const id = await route();
      const first = await assign(id);
      expect(await refusedBy(
        `INSERT INTO transport_assignments (school_id, student_id, academic_year_id, enrolment_id, route_id, starts_on, created_by)
         VALUES ($1, $2, $3, $4, $5, '2026-07-01', $6)`,
        [schoolId, student1, yearId, enrolment1, await route(), office.userId],
      )).toBe('transport_assignments_live_key');
      // Another student, and the same student in another year, are their own rows.
      expect(await refusedBy(
        `INSERT INTO transport_assignments (school_id, student_id, academic_year_id, enrolment_id, route_id, starts_on, created_by)
         VALUES ($1, $2, $3, $4, $5, '2026-05-01', $6), ($1, $7, $8, $9, $5, '2027-04-01', $6)`,
        [schoolId, student2, yearId, enrolment2, id, office.userId, student1, nextYearId, nextYearEnrolment1],
      )).toBeNull();
      await endAssignment(first);
      expect(await assign(await route(), { startsOn: '2026-07-01' })).toBeGreaterThan(0n);
    });

    it('the enrolment FK carries student and year: never another child or another year', async () => {
      const id = await route();
      const sql = `INSERT INTO transport_assignments (school_id, student_id, academic_year_id, enrolment_id, route_id, starts_on, created_by)
         VALUES ($1, $2, $3, $4, $5, $7, $6)`;
      // Another child's enrolment (student2 has no live row, so the FK is what refuses).
      expect(await refusedBy(sql, [schoolId, student2, yearId, enrolment1, id, office.userId, '2026-05-01'])).toBe('transport_assignments_enrolment_id_fkey');
      // The child's enrolment of another year.
      expect(await refusedBy(sql, [schoolId, student1, nextYearId, enrolment1, id, office.userId, '2027-05-01'])).toBe('transport_assignments_enrolment_id_fkey');
    });

    it('the stop FK carries the route: a stop of another route is refused', async () => {
      const id = await route();
      const elsewhere = await stop(await route(), 1);
      expect(await refusedBy(
        `INSERT INTO transport_assignments (school_id, student_id, academic_year_id, enrolment_id, route_id, stop_id, starts_on, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, '2026-05-01', $7)`,
        [schoolId, student2, yearId, enrolment2, id, elsewhere, office.userId],
      )).toBe('transport_assignments_stop_id_fkey');
    });

    it('R329: born live, on an active route and a live stop, starting inside the year', async () => {
      const id = await route();
      const insert = (o: { routeId?: bigint; stopId?: bigint | null; startsOn?: string; ended?: boolean }) =>
        refusedBy(
          `INSERT INTO transport_assignments (school_id, student_id, academic_year_id, enrolment_id, route_id, stop_id, starts_on,
             created_by, ended_at, ended_by, end_reason, ends_on)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            schoolId, student2, yearId, enrolment2, o.routeId ?? id, o.stopId ?? null, o.startsOn ?? '2026-05-01', office.userId,
            o.ended ? new Date() : null, o.ended ? office.userId : null, o.ended ? 'Done' : null, o.ended ? '2026-05-31' : null,
          ],
        );
      expect(await insert({ ended: true })).toBe('transport_assignments_born_live');
      expect(await insert({ startsOn: '2027-04-01' })).toBe('transport_assignments_in_year');
      expect(await insert({ startsOn: '2026-03-31' })).toBe('transport_assignments_in_year');
      const endedStop = await stop(id, 3);
      await pg.query(`UPDATE transport_stops SET ended_at = now(), ended_by = $2, end_reason = 'Closed' WHERE id = $1`, [endedStop, office.userId]);
      expect(await insert({ stopId: endedStop })).toBe('transport_assignments_stop_live');
      const archived = await route();
      await archive(archived);
      expect(await insert({ routeId: archived })).toBe('transport_assignments_route_active');
      expect(await insert({ startsOn: '2027-03-31' })).toBeNull();
    });

    it('R326: never edited; the end group travels together, once, never before starts_on - 1', async () => {
      // student2: student1 keeps the live assignment the test above left.
      const id = await assign(await route(), { student: student2, enrolment: enrolment2, startsOn: '2026-06-01' });
      const cases: [string, unknown[], string][] = [
        [`UPDATE transport_assignments SET route_id = $2 WHERE id = $1`, [id, await route()], 'transport_assignments_route_id_immutable'],
        [`UPDATE transport_assignments SET starts_on = '2026-06-02' WHERE id = $1`, [id], 'transport_assignments_starts_on_immutable'],
        [`UPDATE transport_assignments SET enrolment_id = $2 WHERE id = $1`, [id, enrolment1], 'transport_assignments_enrolment_id_immutable'],
        [`UPDATE transport_assignments SET ends_on = '2026-06-30' WHERE id = $1`, [id], 'transport_assignments_ended_check'],
        [`UPDATE transport_assignments SET ended_at = now(), ended_by = $2, end_reason = 'Left', ends_on = '2026-05-30' WHERE id = $1`, [id, office.userId], 'transport_assignments_ended_check'],
        [`UPDATE transport_assignments SET ended_at = now(), ended_by = $2, end_reason = $3, ends_on = '2026-06-30' WHERE id = $1`, [id, office.userId, `Left ${ID}`], 'transport_assignments_end_reason_no_id_check'],
        [`UPDATE transport_assignments SET ended_at = now(), ended_by = $2, end_reason = ' Left', ends_on = '2026-06-30' WHERE id = $1`, [id, office.userId], 'transport_assignments_end_reason_check'],
      ];
      for (const [sql, params, constraint] of cases) expect(await refusedBy(sql, params)).toBe(constraint);
      // Ended before it began: starts_on - 1 is the one earlier end allowed (never in force).
      expect(await refusedBy(
        `UPDATE transport_assignments SET ended_at = now(), ended_by = $2, end_reason = 'Cancelled', ends_on = '2026-05-31' WHERE id = $1`,
        [id, office.userId],
      )).toBeNull();
      await endAssignment(id);
      expect(await refusedBy(`UPDATE transport_assignments SET ends_on = '2026-07-31' WHERE id = $1`, [id])).toBe('transport_assignments_ends_on_frozen');
    });
  });

  // ---------------------------------------------------------------------------- device punches

  describe('device_punches (R345, R348, append-only)', () => {
    it('the device user id is printable ASCII without spaces, never an identity number', async () => {
      const sql = `INSERT INTO device_punches (school_id, device_user_id, punched_at, outcome) VALUES ($1, $2, '2026-09-01T03:00:00Z', 'unmapped')`;
      expect(await refusedBy(sql, [schoolId, 'has space'])).toBe('device_punches_device_user_id_check');
      expect(await refusedBy(sql, [schoolId, ''])).toBe('device_punches_device_user_id_check');
      expect(await refusedBy(sql, [schoolId, ID])).toBe('device_punches_device_user_id_no_id_check');
      expect(await refusedBy(sql, [schoolId, 'U-0042'])).toBeNull();
    });

    it('A11: unmapped exactly when no staff member is named; a named one holds the id; outcomes match the staff status', async () => {
      expect(await refusedBy(
        `INSERT INTO device_punches (school_id, staff_id, device_user_id, punched_at, outcome) VALUES ($1, $2, $3, now(), 'unmapped')`,
        [schoolId, teacher.staffId, `T${schoolId}`],
      )).toBe('device_punches_outcome_check');
      expect(await refusedBy(
        `INSERT INTO device_punches (school_id, staff_id, device_user_id, punched_at, outcome) VALUES ($1, NULL, 'U-1', now(), 'stored')`,
        [schoolId],
      )).toBe('device_punches_outcome_check');
      expect(await refusedBy(
        `INSERT INTO device_punches (school_id, staff_id, device_user_id, punched_at, outcome) VALUES ($1, $2, 'U-NOT-HIS', now(), 'stored')`,
        [schoolId, teacher.staffId],
      )).toBe('device_punches_staff_mapping');
      const insert = (staffId: bigint, deviceUserId: string, outcome: string) =>
        refusedBy(
          `INSERT INTO device_punches (school_id, staff_id, device_user_id, punched_at, outcome) VALUES ($1, $2, $3, now(), $4::punch_outcome)`,
          [schoolId, staffId, deviceUserId, outcome],
        );
      expect(await insert(suspended.staffId, `S${schoolId}`, 'marked')).toBe('device_punches_staff_status');
      expect(await insert(teacher.staffId, `T${schoolId}`, 'inactive')).toBe('device_punches_staff_status');
      expect(await insert(suspended.staffId, `S${schoolId}`, 'inactive')).toBeNull();
      expect(await insert(teacher.staffId, `T${schoolId}`, 'stored')).toBeNull();
      expect(await refusedBy(
        `INSERT INTO device_punches (school_id, staff_id, device_user_id, punched_at, outcome) VALUES ($1, $2, $3, now(), 'stored')`,
        [schoolId, otherStaffId, `T${schoolId}`],
      )).toBe('device_punches_staff_mapping');
    });

    it('R345: a replay is refused by the unique; a punch is never edited or removed', async () => {
      const id = await punch({ at: '2026-10-05T03:00:00Z' });
      expect(await refusedBy(
        `INSERT INTO device_punches (school_id, staff_id, device_user_id, punched_at, outcome) VALUES ($1, $2, $3, '2026-10-05T03:00:00Z', 'stored')`,
        [schoolId, teacher.staffId, `T${schoolId}`],
      )).toBe('device_punches_replay_key');
      expect(await refusedBy(`UPDATE device_punches SET outcome = 'stored' WHERE id = $1`, [id])).toBe('device_punches_append_only');
    });
  });

  // ---------------------------------------------------------------------------- staff_attendance

  describe('staff_attendance.device_punch_id (R345)', () => {
    const deviceMark = (staffId: bigint, date: string, punchId: bigint | null) =>
      refusedBy(
        `INSERT INTO staff_attendance (school_id, staff_id, date, status, source, marked_by, device_punch_id)
         VALUES ($1, $2, $3, 'present', 'device', NULL, $4)`,
        [schoolId, staffId, date, punchId],
      );

    it('§3.2: device = no marking user = a punch; manual = a marking user and no punch', async () => {
      const punchId = await punch({ at: '2026-10-06T03:00:00Z' });
      expect(await deviceMark(teacher.staffId, '2026-10-06', null)).toBe('staff_attendance_source_check');
      expect(await refusedBy(
        `INSERT INTO staff_attendance (school_id, staff_id, date, status, marked_by, device_punch_id) VALUES ($1, $2, '2026-10-06', 'present', $3, $4)`,
        [schoolId, teacher.staffId, office.userId, punchId],
      )).toBe('staff_attendance_source_check');
      expect(await deviceMark(teacher.staffId, '2026-10-06', punchId)).toBeNull();
    });

    it('the punch is the same staff member, received as marked, on the mark\'s own day in school time', async () => {
      const punchId = await punch({ at: '2026-10-07T03:00:00Z' });
      expect(await deviceMark(principal.staffId, '2026-10-07', punchId)).toBe('staff_attendance_device_punch_id_fkey');
      expect(await deviceMark(teacher.staffId, '2026-10-08', punchId)).toBe('staff_attendance_device_punch_date');
      const stored = await punch({ at: '2026-10-09T03:00:00Z', outcome: 'stored' });
      expect(await deviceMark(teacher.staffId, '2026-10-09', stored)).toBe('staff_attendance_device_punch_marked');
      // 20:00 UTC on the 9th is the 10th in Karachi.
      const late = await punch({ at: '2026-10-09T20:00:00Z' });
      expect(await deviceMark(teacher.staffId, '2026-10-09', late)).toBe('staff_attendance_device_punch_date');
      expect(await deviceMark(teacher.staffId, '2026-10-10', late)).toBeNull();
    });

    it('the punch of a mark is frozen; a dispute approval amends the status through the history path', async () => {
      const punchId = await punch({ at: '2026-10-12T03:00:00Z' });
      const mark = await one(
        `INSERT INTO staff_attendance (school_id, staff_id, date, status, source, device_punch_id)
         VALUES ($1, $2, '2026-10-12', 'present', 'device', $3) RETURNING id`,
        [schoolId, teacher.staffId, punchId],
      );
      expect(await refusedBy(`UPDATE staff_attendance SET device_punch_id = NULL WHERE id = $1`, [mark])).toBe('staff_attendance_device_punch_id_immutable');
      expect(await refusedBy(
        `SELECT set_config('asms.actor_user_id', '${office.userId}', true), set_config('asms.change_reason', 'Dispute approved', true);
         UPDATE staff_attendance SET status = 'late' WHERE id = ${mark};`,
      )).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------- disputes

  describe('staff_attendance_disputes (R346, R347)', () => {
    it('born pending, raised from the staff member\'s own login, with a reason', async () => {
      const mark = await manualMark(teacher.staffId, '2026-11-02');
      const sql = `INSERT INTO staff_attendance_disputes (school_id, attendance_id, staff_id, raised_by, requested_status, reason, status)
         VALUES ($1, $2, $3, $4, 'present', $5, $6::dispute_status)`;
      expect(await refusedBy(sql, [schoolId, mark, teacher.staffId, teacher.userId, 'Here', 'approved'])).toBe('staff_attendance_disputes_born_pending');
      expect(await refusedBy(sql, [schoolId, mark, teacher.staffId, office.userId, 'Here', 'pending'])).toBe('staff_attendance_disputes_raised_by_self');
      expect(await refusedBy(sql, [schoolId, mark, teacher.staffId, teacher.userId, ' Here', 'pending'])).toBe('staff_attendance_disputes_reason_check');
      expect(await refusedBy(sql, [schoolId, mark, teacher.staffId, teacher.userId, `Here ${ID}`, 'pending'])).toBe('staff_attendance_disputes_reason_no_id_check');
      // The FK carries the staff member: a dispute names the disputer's own mark.
      expect(await refusedBy(sql, [schoolId, mark, office.staffId, office.userId, 'Here', 'pending'])).toBe('staff_attendance_disputes_attendance_id_fkey');
      expect(await refusedBy(sql, [schoolId, mark, teacher.staffId, teacher.userId, 'Here', 'pending'])).toBeNull();
    });

    it('one pending dispute per mark; a decided one frees the mark', async () => {
      const mark = await manualMark(teacher.staffId, '2026-11-03');
      const first = await dispute(mark, teacher);
      expect(await refusedBy(
        `INSERT INTO staff_attendance_disputes (school_id, attendance_id, staff_id, raised_by, requested_status, reason)
         VALUES ($1, $2, $3, $4, 'late', 'Again')`,
        [schoolId, mark, teacher.staffId, teacher.userId],
      )).toBe('staff_attendance_disputes_pending_key');
      await pg.query(
        `UPDATE staff_attendance_disputes SET status = 'rejected', decided_by = $2, decided_at = now(), decision_reason = 'Register says absent' WHERE id = $1`,
        [first, office.userId],
      );
      expect(await dispute(mark, teacher)).toBeGreaterThan(0n);
    });

    it('R346: the decider is never the staff member, a sole principal included', async () => {
      const mark = await manualMark(principal.staffId, '2026-11-04');
      const id = await dispute(mark, principal);
      expect(await refusedBy(
        `UPDATE staff_attendance_disputes SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1`,
        [id, principal.userId],
      )).toBe('staff_attendance_disputes_not_self');
      expect(await refusedBy(
        `UPDATE staff_attendance_disputes SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1`,
        [id, office.userId],
      )).toBeNull();
    });

    it('the decision and withdrawal groups are checked, set once, and final', async () => {
      const mark = await manualMark(teacher.staffId, '2026-11-05');
      const id = await dispute(mark, teacher);
      const cases: [string, unknown[], string][] = [
        [`UPDATE staff_attendance_disputes SET status = 'approved' WHERE id = $1`, [id], 'staff_attendance_disputes_decided_check'],
        [`UPDATE staff_attendance_disputes SET status = 'rejected', decided_by = $2, decided_at = now() WHERE id = $1`, [id, office.userId], 'staff_attendance_disputes_decided_check'],
        [`UPDATE staff_attendance_disputes SET decision_reason = 'Early note' WHERE id = $1`, [id], 'staff_attendance_disputes_decided_check'],
        [`UPDATE staff_attendance_disputes SET status = 'withdrawn' WHERE id = $1`, [id], 'staff_attendance_disputes_withdrawn_check'],
        [`UPDATE staff_attendance_disputes SET status = 'withdrawn', withdrawn_by = $2, withdrawn_at = now() WHERE id = $1`, [id, office.userId], 'staff_attendance_disputes_withdrawn_by_self'],
        [`UPDATE staff_attendance_disputes SET status = 'approved', decided_by = $2, decided_at = now(), decision_reason = $3 WHERE id = $1`, [id, office.userId, ID], 'staff_attendance_disputes_decision_reason_no_id_check'],
        [`UPDATE staff_attendance_disputes SET reason = 'Changed' WHERE id = $1`, [id], 'staff_attendance_disputes_reason_immutable'],
        [`UPDATE staff_attendance_disputes SET requested_status = 'absent' WHERE id = $1`, [id], 'staff_attendance_disputes_requested_status_immutable'],
      ];
      for (const [sql, params, constraint] of cases) expect(await refusedBy(sql, params)).toBe(constraint);
      await pg.query(
        `UPDATE staff_attendance_disputes SET status = 'withdrawn', withdrawn_by = $2, withdrawn_at = now() WHERE id = $1`,
        [id, teacher.userId],
      );
      expect(await refusedBy(
        `UPDATE staff_attendance_disputes SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1`,
        [id, office.userId],
      )).toBe('staff_attendance_disputes_status_transition');
      expect(await refusedBy(`UPDATE staff_attendance_disputes SET withdrawn_at = now() + interval '1 minute' WHERE id = $1`, [id])).toBe('staff_attendance_disputes_withdrawn_at_frozen');
      const approved = await dispute(await manualMark(teacher.staffId, '2026-11-06'), teacher);
      await pg.query(
        `UPDATE staff_attendance_disputes SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1`,
        [approved, office.userId],
      );
      expect(await refusedBy(`UPDATE staff_attendance_disputes SET decision_reason = 'Late note' WHERE id = $1`, [approved])).toBe('staff_attendance_disputes_decision_reason_frozen');
      expect(await refusedBy(`UPDATE staff_attendance_disputes SET status = 'rejected' WHERE id = $1`, [approved])).toBe(
        'staff_attendance_disputes_status_transition',
      );
    });
  });

  // ---------------------------------------------------------------------------- rule 4

  it.each(DELETABLE_NEVER)('rule 4: %s rows are never deleted', async (table) => {
    expect(await refusedBy(`DELETE FROM ${table} WHERE school_id = $1`, [schoolId])).toBe(`${table}_no_delete`);
  });

  it.each(APPEND_ONLY)('rule 4: %s is append-only', async (table) => {
    expect(await refusedBy(`DELETE FROM ${table} WHERE school_id = $1`, [schoolId])).toBe(`${table}_append_only`);
  });

  it.each([...DELETABLE_NEVER, ...APPEND_ONLY])('rule 4: %s is never truncated', async (table) => {
    expect(await truncateRefused(table)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------- the error mapper

describe('wave T schema: refusals reach the error mapper', () => {
  let db: ReturnType<typeof testDb>;
  beforeAll(() => {
    db = testDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const mapped = async (write: Promise<unknown>) => {
    try {
      await write;
      return 'accepted';
    } catch (error) {
      const api = mapDatabaseError(error);
      return api ? { status: api.status, code: api.code } : String(error);
    }
  };

  it('a second live assignment is TRANSPORT_ASSIGNMENT_LIVE; archiving its route is TRANSPORT_ROUTE_HAS_ASSIGNMENTS', async () => {
    const school = await createSchool();
    const office = await createSchoolUser(db, school, { systemRole: 'office_staff' });
    const year = await createAcademicYear(db, school, { startsOn: '2026-04-01', endsOn: '2027-03-31' });
    const section = await createSection(db, school, await createClass(db, school, year));
    const student = await createStudent(db, school, { admittedOn: '2026-04-01' });
    const enrolment = await enrol(db, school, student, section, { startedOn: '2026-04-01' });
    const route = await db.transportRoute.create({ data: { schoolId: school.id, name: 'North', createdBy: office.userId } });
    const row = {
      schoolId: school.id, studentId: student.id, academicYearId: year.id, enrolmentId: enrolment.id,
      routeId: route.id, startsOn: day('2026-05-01'), createdBy: office.userId,
    };
    await db.transportAssignment.create({ data: row });
    expect(await mapped(db.transportAssignment.create({ data: row }))).toEqual({ status: 409, code: ErrorCode.TRANSPORT_ASSIGNMENT_LIVE });
    expect(await mapped(db.transportRoute.updateMany({
      where: { schoolId: school.id, id: route.id },
      data: { status: 'archived', archivedAt: new Date(), archivedBy: office.userId, archiveReason: 'Closed' },
    }))).toEqual({ status: 409, code: ErrorCode.TRANSPORT_ROUTE_HAS_ASSIGNMENTS });
    expect(await mapped(db.transportRoute.create({ data: { schoolId: school.id, name: 'NORTH', createdBy: office.userId } }))).toEqual({
      status: 409,
      code: ErrorCode.TRANSPORT_ROUTE_NAME_TAKEN,
    });
  });

  it('a second pending dispute is ATTENDANCE_DISPUTE_PENDING_EXISTS; deciding your own is SELF_ACTION_FORBIDDEN', async () => {
    const school = await createSchool();
    const office = await createSchoolUser(db, school, { systemRole: 'office_staff' });
    const teacher = await createSchoolUser(db, school, { systemRole: 'teacher' });
    const mark = await db.staffAttendance.create({
      data: { schoolId: school.id, staffId: teacher.staffId, date: day('2026-11-02'), status: 'absent', markedBy: office.userId },
    });
    const row = {
      schoolId: school.id, attendanceId: mark.id, staffId: teacher.staffId, raisedBy: teacher.userId,
      requestedStatus: 'present' as const, reason: 'I was teaching period one',
    };
    const first = await db.staffAttendanceDispute.create({ data: row });
    expect(await mapped(db.staffAttendanceDispute.create({ data: row }))).toEqual({
      status: 409,
      code: ErrorCode.ATTENDANCE_DISPUTE_PENDING_EXISTS,
    });
    expect(await mapped(db.staffAttendanceDispute.updateMany({
      where: { schoolId: school.id, id: first.id },
      data: { status: 'approved', decidedBy: teacher.userId, decidedAt: new Date() },
    }))).toEqual({ status: 409, code: ErrorCode.SELF_ACTION_FORBIDDEN });
  });
});
