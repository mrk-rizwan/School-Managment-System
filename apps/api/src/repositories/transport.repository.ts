import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { TransportRouteStatus, VehicleStatus } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Scope } from '../tenancy/scope';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';
import { studentInScope } from './student.repository';

// The tenant tables of transport (phase-5-extended.md rule 37, §3.2 "Transport", R326-R331;
// contracts/slice-41.md; migrations 20261014120100_wave_t_transport_biometric and
// 20261014120200_wave_t_amount_void): vehicles, transport_routes, transport_stops,
// transport_route_amounts and transport_assignments. The database freezes what the contract says is
// history (a retired vehicle, an archived route, an ended stop or assignment, a voided amount), keeps
// one live assignment per student per year and refuses an ended stop with riders; the service
// refuses first. Importable only from src/modules/transport/** (eslint transportRepository). The
// charge job reads assignments through TransportReadsRepository, never this file.

export interface VehicleRecord {
  id: bigint;
  registration: string;
  capacity: number;
  driverStaffId: bigint | null;
  driverName: string | null;
  status: VehicleStatus;
  routeNames: string[];
  retiredAt: Date | null;
  retireReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StopRecord {
  id: bigint;
  sortOrder: number;
  name: string;
  /** A TIME column: 1970-01-01 UTC. */
  pickupTime: Date | null;
}

export interface RouteAmountRecord {
  id: bigint;
  routeId: bigint;
  effectivePeriod: string;
  amount: number;
  createdByName: string | null;
  createdAt: Date;
  voidedAt: Date | null;
  voidReason: string | null;
}

export interface RouteRecord {
  id: bigint;
  name: string;
  status: TransportRouteStatus;
  vehicle: { id: bigint; registration: string; capacity: number; driverName: string | null } | null;
  riders: number;
  stopCount: number;
  archivedAt: Date | null;
  archiveReason: string | null;
  updatedAt: Date;
}

export interface AssignmentRecord {
  id: bigint;
  studentId: bigint;
  studentName: string;
  admissionNo: string;
  academicYearId: bigint;
  enrolmentId: bigint;
  /** The student's active enrolment's class and section, else the assignment's enrolment's. */
  className: string | null;
  sectionName: string | null;
  routeId: bigint;
  routeName: string;
  stopId: bigint | null;
  stopName: string | null;
  pickupTime: Date | null;
  startsOn: Date;
  endsOn: Date | null;
  endedAt: Date | null;
  endReason: string | null;
  endedByName: string | null;
  createdAt: Date;
  /** The route's vehicle's driver (the family view, R330). */
  driverName: string | null;
}

export interface NewVehicle {
  registration: string;
  capacity: number;
  driverStaffId: bigint | null;
  createdBy: bigint;
}

export interface NewStop {
  sortOrder: number;
  name: string;
  pickupTime: Date | null;
}

export interface NewAssignment {
  studentId: bigint;
  academicYearId: bigint;
  enrolmentId: bigint;
  routeId: bigint;
  stopId: bigint | null;
  startsOn: Date;
  createdBy: bigint;
}

export interface Ending {
  by: bigint;
  reason: string;
  now: Date;
}

const staffName = { select: { fullName: true } } as const;

const VEHICLE_SELECT = {
  id: true,
  registration: true,
  capacity: true,
  driverStaffId: true,
  status: true,
  retiredAt: true,
  retireReason: true,
  createdAt: true,
  updatedAt: true,
  driver: staffName,
  routes: { where: { status: 'active' }, select: { name: true }, orderBy: { name: 'asc' } },
} as const satisfies Prisma.VehicleSelect;

type VehicleRow = Prisma.VehicleGetPayload<{ select: typeof VEHICLE_SELECT }>;

const toVehicle = ({ driver, routes, ...row }: VehicleRow): VehicleRecord => ({
  ...row,
  driverName: driver?.fullName ?? null,
  routeNames: routes.map((r) => r.name),
});

const LIVE_STOP_ORDER: Prisma.TransportStopOrderByWithRelationInput[] = [{ sortOrder: 'asc' }, { id: 'asc' }];

const STOP_SELECT = { id: true, sortOrder: true, name: true, pickupTime: true } as const satisfies Prisma.TransportStopSelect;

const ROUTE_SELECT = {
  id: true,
  name: true,
  status: true,
  archivedAt: true,
  archiveReason: true,
  updatedAt: true,
  vehicle: { select: { id: true, registration: true, capacity: true, driver: staffName } },
  _count: { select: { assignments: { where: { endedAt: null } }, stops: { where: { endedAt: null } } } },
} as const satisfies Prisma.TransportRouteSelect;

type RouteRow = Prisma.TransportRouteGetPayload<{ select: typeof ROUTE_SELECT }>;

const toRoute = ({ vehicle, _count, ...row }: RouteRow): RouteRecord => ({
  ...row,
  vehicle:
    vehicle === null
      ? null
      : { id: vehicle.id, registration: vehicle.registration, capacity: vehicle.capacity, driverName: vehicle.driver?.fullName ?? null },
  riders: _count.assignments,
  stopCount: _count.stops,
});

const AMOUNT_SELECT = {
  id: true,
  routeId: true,
  effectivePeriod: true,
  amount: true,
  createdAt: true,
  voidedAt: true,
  voidReason: true,
  createdByUser: { select: { staff: staffName } },
} as const satisfies Prisma.TransportRouteAmountSelect;

type AmountRow = Prisma.TransportRouteAmountGetPayload<{ select: typeof AMOUNT_SELECT }>;

const toAmount = ({ createdByUser, ...row }: AmountRow): RouteAmountRecord => ({
  ...row,
  createdByName: createdByUser.staff?.fullName ?? null,
});

const ASSIGNMENT_SELECT = {
  id: true,
  studentId: true,
  academicYearId: true,
  enrolmentId: true,
  routeId: true,
  stopId: true,
  startsOn: true,
  endsOn: true,
  endedAt: true,
  endReason: true,
  createdAt: true,
  // The student through the snapshot enrolment (the composite key's only relation).
  enrolment: {
    select: {
      class: { select: { name: true } },
      section: { select: { name: true } },
      student: {
        select: {
          fullName: true,
          admissionNo: true,
          enrolments: {
            where: { status: 'active' },
            select: { class: { select: { name: true } }, section: { select: { name: true } } },
            take: 1,
          },
        },
      },
    },
  },
  route: { select: { name: true, vehicle: { select: { driver: staffName } } } },
  stop: { select: { name: true, pickupTime: true } },
  endedByUser: { select: { staff: staffName } },
} as const satisfies Prisma.TransportAssignmentSelect;

type AssignmentRow = Prisma.TransportAssignmentGetPayload<{ select: typeof ASSIGNMENT_SELECT }>;

const toAssignment = ({ enrolment, route, stop, endedByUser, ...row }: AssignmentRow): AssignmentRecord => {
  const { student } = enrolment;
  const current = student.enrolments[0] ?? enrolment;
  return {
    ...row,
    studentName: student.fullName,
    admissionNo: student.admissionNo,
    className: current.class.name,
    sectionName: current.section.name,
    routeName: route.name,
    stopName: stop?.name ?? null,
    pickupTime: stop?.pickupTime ?? null,
    endedByName: endedByUser?.staff?.fullName ?? null,
    driverName: route.vehicle?.driver?.fullName ?? null,
  };
};

@Injectable()
export class TransportRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  // ---------------------------------------------------------------------------------- vehicles

  async listVehicles(
    schoolId: SchoolId,
    q: { registration?: string; status?: VehicleStatus; skip: number; take: number },
  ): Promise<{ rows: VehicleRecord[]; total: number }> {
    const where: Prisma.VehicleWhereInput = {
      schoolId,
      ...(q.registration === undefined ? {} : { registration: { contains: q.registration, mode: 'insensitive' } }),
      ...(q.status === undefined ? {} : { status: q.status }),
    };
    const rows = await this.txHost.tx.vehicle.findMany({
      where,
      select: VEHICLE_SELECT,
      orderBy: [{ registration: 'asc' }, { id: 'asc' }],
      skip: q.skip,
      take: q.take,
    });
    const total = await this.txHost.tx.vehicle.count({ where });
    return { rows: rows.map(toVehicle), total };
  }

  async findVehicle(schoolId: SchoolId, id: bigint): Promise<VehicleRecord | null> {
    const row = await this.txHost.tx.vehicle.findFirst({ where: { schoolId, id }, select: VEHICLE_SELECT });
    return row && toVehicle(row);
  }

  async createVehicle(schoolId: SchoolId, data: NewVehicle): Promise<bigint> {
    const row = await this.txHost.tx.vehicle.create({ data: { schoolId, ...data }, select: { id: true } });
    return row.id;
  }

  /** The compare-and-set row lock readLocked takes (an active vehicle only). */
  async lockVehicleIfUnchanged(schoolId: SchoolId, row: Pick<VehicleRecord, 'id' | 'updatedAt'>): Promise<boolean> {
    const { count } = await this.txHost.tx.vehicle.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt, status: 'active' },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  /** An active vehicle's plain attributes; 0 when it is retired meanwhile. */
  async updateVehicle(
    schoolId: SchoolId,
    id: bigint,
    data: { registration?: string; capacity?: number; driverStaffId?: bigint | null },
  ): Promise<number> {
    const { count } = await this.txHost.tx.vehicle.updateMany({ where: { schoolId, id, status: 'active' }, data });
    return count;
  }

  /** The active vehicles that name the member as their driver (a leaving member's, B8). */
  async activeVehiclesDrivenBy(schoolId: SchoolId, staffId: bigint): Promise<bigint[]> {
    const rows = await this.txHost.tx.vehicle.findMany({
      where: { schoolId, driverStaffId: staffId, status: 'active' },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => r.id);
  }

  async retireVehicle(schoolId: SchoolId, id: bigint, end: Ending): Promise<number> {
    const { count } = await this.txHost.tx.vehicle.updateMany({
      where: { schoolId, id, status: 'active' },
      data: { status: 'retired', retiredAt: end.now, retiredBy: end.by, retireReason: end.reason },
    });
    return count;
  }

  /** The active routes naming this vehicle (VEHICLE_IN_USE). */
  activeRoutesOfVehicle(schoolId: SchoolId, vehicleId: bigint): Promise<{ id: bigint; name: string }[]> {
    return this.txHost.tx.transportRoute.findMany({
      where: { schoolId, vehicleId, status: 'active' },
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
    });
  }

  // ------------------------------------------------------------------------------------ routes

  async listRoutes(
    schoolId: SchoolId,
    q: { name?: string; status?: TransportRouteStatus; skip: number; take: number },
  ): Promise<{ rows: RouteRecord[]; total: number }> {
    const where: Prisma.TransportRouteWhereInput = {
      schoolId,
      ...(q.name === undefined ? {} : { name: { contains: q.name, mode: 'insensitive' } }),
      ...(q.status === undefined ? {} : { status: q.status }),
    };
    const rows = await this.txHost.tx.transportRoute.findMany({
      where,
      select: ROUTE_SELECT,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: q.skip,
      take: q.take,
    });
    const total = await this.txHost.tx.transportRoute.count({ where });
    return { rows: rows.map(toRoute), total };
  }

  async findRoute(schoolId: SchoolId, id: bigint): Promise<RouteRecord | null> {
    const row = await this.txHost.tx.transportRoute.findFirst({ where: { schoolId, id }, select: ROUTE_SELECT });
    return row && toRoute(row);
  }

  /** The compare-and-set row lock readLocked takes. */
  async lockRouteIfUnchanged(schoolId: SchoolId, row: Pick<RouteRecord, 'id' | 'updatedAt'>): Promise<boolean> {
    const { count } = await this.txHost.tx.transportRoute.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  async createRoute(schoolId: SchoolId, data: { name: string; vehicleId: bigint | null; createdBy: bigint }): Promise<bigint> {
    const row = await this.txHost.tx.transportRoute.create({ data: { schoolId, ...data }, select: { id: true } });
    return row.id;
  }

  async updateRoute(schoolId: SchoolId, id: bigint, data: { name?: string; vehicleId?: bigint | null }): Promise<number> {
    const { count } = await this.txHost.tx.transportRoute.updateMany({ where: { schoolId, id, status: 'active' }, data });
    return count;
  }

  async archiveRoute(schoolId: SchoolId, id: bigint, end: Ending): Promise<number> {
    const { count } = await this.txHost.tx.transportRoute.updateMany({
      where: { schoolId, id, status: 'active' },
      data: { status: 'archived', archivedAt: end.now, archivedBy: end.by, archiveReason: end.reason },
    });
    return count;
  }

  /** The route's live stops in order. */
  liveStops(schoolId: SchoolId, routeId: bigint): Promise<StopRecord[]> {
    return this.txHost.tx.transportStop.findMany({ where: { schoolId, routeId, endedAt: null }, select: STOP_SELECT, orderBy: LIVE_STOP_ORDER });
  }

  /** The live stops of several routes (the driver's list). */
  liveStopsOf(schoolId: SchoolId, routeIds: readonly bigint[]): Promise<(StopRecord & { routeId: bigint })[]> {
    if (routeIds.length === 0) return Promise.resolve([]);
    return this.txHost.tx.transportStop.findMany({
      where: { schoolId, routeId: { in: [...routeIds] }, endedAt: null },
      select: { ...STOP_SELECT, routeId: true },
      orderBy: [{ routeId: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
    });
  }

  async insertStops(schoolId: SchoolId, routeId: bigint, stops: readonly NewStop[]): Promise<void> {
    if (stops.length === 0) return;
    await this.txHost.tx.transportStop.createMany({ data: stops.map((s) => ({ schoolId, routeId, ...s })) });
  }

  /** A live stop edited in place (order, name, pickup time). */
  async updateStop(schoolId: SchoolId, routeId: bigint, id: bigint, data: NewStop): Promise<number> {
    const { count } = await this.txHost.tx.transportStop.updateMany({ where: { schoolId, routeId, id, endedAt: null }, data });
    return count;
  }

  async endStops(schoolId: SchoolId, routeId: bigint, ids: readonly bigint[], end: Ending): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await this.txHost.tx.transportStop.updateMany({
      where: { schoolId, routeId, id: { in: [...ids] }, endedAt: null },
      data: { endedAt: end.now, endedBy: end.by, endReason: end.reason },
    });
    return count;
  }

  /** The live stops among `ids` that a live assignment names (TRANSPORT_STOP_IN_USE). */
  async stopsInUse(schoolId: SchoolId, ids: readonly bigint[]): Promise<bigint[]> {
    if (ids.length === 0) return [];
    const rows = await this.txHost.tx.transportAssignment.findMany({
      where: { schoolId, endedAt: null, stopId: { in: [...ids] } },
      select: { stopId: true },
      distinct: ['stopId'],
    });
    return rows.flatMap((r) => (r.stopId === null ? [] : [r.stopId]));
  }

  // ----------------------------------------------------------------------------------- amounts

  /** Every amount of the routes (voided included), newest period first. */
  async amountsOf(schoolId: SchoolId, routeIds: readonly bigint[]): Promise<RouteAmountRecord[]> {
    if (routeIds.length === 0) return [];
    const rows = await this.txHost.tx.transportRouteAmount.findMany({
      where: { schoolId, routeId: { in: [...routeIds] } },
      select: AMOUNT_SELECT,
      orderBy: [{ effectivePeriod: 'desc' }, { id: 'desc' }],
    });
    return rows.map(toAmount);
  }

  async findAmount(schoolId: SchoolId, id: bigint): Promise<RouteAmountRecord | null> {
    const row = await this.txHost.tx.transportRouteAmount.findFirst({ where: { schoolId, id }, select: AMOUNT_SELECT });
    return row && toAmount(row);
  }

  async createAmount(
    schoolId: SchoolId,
    data: { routeId: bigint; effectivePeriod: string; amount: number; createdBy: bigint },
  ): Promise<bigint> {
    const row = await this.txHost.tx.transportRouteAmount.create({ data: { schoolId, ...data }, select: { id: true } });
    return row.id;
  }

  async voidAmount(schoolId: SchoolId, id: bigint, end: Ending): Promise<number> {
    const { count } = await this.txHost.tx.transportRouteAmount.updateMany({
      where: { schoolId, id, voidedAt: null },
      data: { voidedAt: end.now, voidedBy: end.by, voidReason: end.reason },
    });
    return count;
  }

  // ------------------------------------------------------------------------------- assignments

  /** A route's assignments in scope (live only unless `includeEnded`), by student name. */
  async listForRoute(
    schoolId: SchoolId,
    scope: Scope,
    routeId: bigint,
    q: { includeEnded: boolean; studentName?: string; skip: number; take: number },
  ): Promise<{ rows: AssignmentRecord[]; total: number }> {
    const where: Prisma.TransportAssignmentWhereInput = {
      schoolId,
      routeId,
      ...(q.includeEnded ? {} : { endedAt: null }),
      enrolment: {
        is: {
          student: {
            is: {
              AND: [
                studentInScope(scope),
                q.studentName === undefined ? {} : { fullName: { contains: q.studentName, mode: 'insensitive' } },
              ],
            },
          },
        },
      },
    };
    const rows = await this.txHost.tx.transportAssignment.findMany({
      where,
      select: ASSIGNMENT_SELECT,
      orderBy: [{ enrolment: { student: { fullName: 'asc' } } }, { startsOn: 'desc' }, { id: 'desc' }],
      skip: q.skip,
      take: q.take,
    });
    const total = await this.txHost.tx.transportAssignment.count({ where });
    return { rows: rows.map(toAssignment), total };
  }

  /** A student's assignments in scope, newest start first (at most `take`). */
  async listForStudent(schoolId: SchoolId, scope: Scope, studentId: bigint, take: number): Promise<AssignmentRecord[]> {
    const rows = await this.txHost.tx.transportAssignment.findMany({
      where: { schoolId, studentId, enrolment: { is: { student: { is: studentInScope(scope) } } } },
      select: ASSIGNMENT_SELECT,
      orderBy: [{ startsOn: 'desc' }, { id: 'desc' }],
      take,
    });
    return rows.map(toAssignment);
  }

  async findAssignment(schoolId: SchoolId, scope: Scope, id: bigint): Promise<AssignmentRecord | null> {
    const row = await this.txHost.tx.transportAssignment.findFirst({
      where: { schoolId, id, enrolment: { is: { student: { is: studentInScope(scope) } } } },
      select: ASSIGNMENT_SELECT,
    });
    return row && toAssignment(row);
  }

  /** The student's assignments of the year (live and ended), for the overlap and live checks. */
  yearAssignments(
    schoolId: SchoolId,
    studentId: bigint,
    academicYearId: bigint,
  ): Promise<{ id: bigint; startsOn: Date; endsOn: Date | null; endedAt: Date | null }[]> {
    return this.txHost.tx.transportAssignment.findMany({
      where: { schoolId, studentId, academicYearId },
      select: { id: true, startsOn: true, endsOn: true, endedAt: true },
      orderBy: { id: 'asc' },
    });
  }

  async createAssignment(schoolId: SchoolId, data: NewAssignment): Promise<bigint> {
    const row = await this.txHost.tx.transportAssignment.create({ data: { schoolId, ...data }, select: { id: true } });
    return row.id;
  }

  async endAssignment(schoolId: SchoolId, id: bigint, endsOn: Date, end: Ending): Promise<number> {
    const { count } = await this.txHost.tx.transportAssignment.updateMany({
      where: { schoolId, id, endedAt: null },
      data: { endsOn, endedAt: end.now, endedBy: end.by, endReason: end.reason },
    });
    return count;
  }

  /** The live assignments of these students (in one year when given): what leaving ends. */
  liveOf(
    schoolId: SchoolId,
    studentIds: readonly bigint[],
    academicYearId?: bigint,
  ): Promise<{ id: bigint; studentId: bigint; routeId: bigint; startsOn: Date }[]> {
    if (studentIds.length === 0) return Promise.resolve([]);
    return this.txHost.tx.transportAssignment.findMany({
      where: {
        schoolId,
        studentId: { in: [...studentIds] },
        endedAt: null,
        ...(academicYearId === undefined ? {} : { academicYearId }),
      },
      select: { id: true, studentId: true, routeId: true, startsOn: true },
      orderBy: { id: 'asc' },
    });
  }

  // ------------------------------------------------------------------------------ family, driver

  /**
   * The student's assignment shown to the family (R330): the newest whose end is today or later
   * (or none). The caller has checked the child against the capacity scope.
   */
  async currentForStudent(schoolId: SchoolId, scope: Scope, studentId: bigint, today: Date): Promise<AssignmentRecord | null> {
    const row = await this.txHost.tx.transportAssignment.findFirst({
      where: {
        schoolId,
        studentId,
        enrolment: { is: { student: { is: studentInScope(scope) } } },
        OR: [{ endsOn: null }, { endsOn: { gte: today } }],
      },
      select: ASSIGNMENT_SELECT,
      orderBy: [{ startsOn: 'asc' }, { id: 'asc' }],
    });
    return row && toAssignment(row);
  }

  /**
   * The active routes whose vehicle names the staff member as driver, with the riders whose
   * assignment ends today or later (R330: names and stops only). Deliberately unscoped by
   * student: the driver's standing comes from the vehicle row, not from a capability scope
   * (contracts/slice-41.md §4).
   */
  async driverRoutes(
    schoolId: SchoolId,
    staffId: bigint,
    today: Date,
  ): Promise<{ id: bigint; name: string; registration: string; riders: { name: string; stopId: bigint | null }[] }[]> {
    const rows = await this.txHost.tx.transportRoute.findMany({
      where: { schoolId, status: 'active', vehicle: { is: { schoolId, driverStaffId: staffId, status: 'active' } } },
      select: {
        id: true,
        name: true,
        vehicle: { select: { registration: true } },
        assignments: {
          where: { OR: [{ endsOn: null }, { endsOn: { gte: today } }] },
          select: { stopId: true, startsOn: true, endsOn: true, enrolment: { select: { student: { select: { fullName: true } } } } },
          orderBy: [{ enrolment: { student: { fullName: 'asc' } } }, { id: 'asc' }],
        },
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      registration: r.vehicle?.registration ?? '',
      riders: r.assignments
        .filter((a) => a.endsOn === null || a.endsOn >= a.startsOn)
        .map((a) => ({ name: a.enrolment.student.fullName, stopId: a.stopId })),
    }));
  }
}
