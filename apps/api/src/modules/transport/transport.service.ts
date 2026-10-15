import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { addMonths, ErrorCode } from '@asms/shared';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { readLocked } from '../../common/locking';
import { toPage, type Page } from '../../common/pagination';
import { SchoolClock } from '../../common/school-clock';
import { SchoolContext, type Actor } from '../../common/school-context';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { StaffRepository } from '../../repositories/staff.repository';
import {
  TransportRepository,
  type NewStop,
  type RouteRecord,
  type StopRecord,
  type VehicleRecord,
} from '../../repositories/transport.repository';
import type { SchoolId } from '../../tenancy/school-id';
import type {
  CreateTransportRouteDto,
  CreateVehicleDto,
  ListRoutesQueryDto,
  ListVehiclesQueryDto,
  SetRouteAmountDto,
  StopInputDto,
  TransportRouteAmountDto,
  TransportRouteDetailDto,
  TransportRouteDto,
  UpdateTransportRouteDto,
  UpdateVehicleDto,
  VehicleDto,
} from './transport.dto';
import { periodOf } from '../fees/charges.shared';
import { amountsAround, timeColumn, toAmountDto, toStopDto } from './transport.shared';

// Phase 5 slice 41 (phase-5-extended.md rule 37, §3.2 "Transport", R327, R329, R331;
// contracts/slice-41.md §2.1-§2.3): vehicles, routes with their stops replaced as a whole, and the
// route amounts. The database holds the same rules (the live uniques, the frozen history, the
// deferred stop-order exclusion, the in-use refusals); the service refuses first with the
// contract's codes and the constraint map answers a race loser.

const vehicleRetired = (vehicleId: bigint): ApiException =>
  new ApiException(409, ErrorCode.VEHICLE_RETIRED, 'The vehicle is retired.', { vehicleId: vehicleId.toString() });

const routeArchived = (routeId: bigint): ApiException =>
  new ApiException(409, ErrorCode.TRANSPORT_ROUTE_ARCHIVED, 'The route is archived.', { routeId: routeId.toString() });

/** The audit reason when a leaving member's vehicles lose their driver (B8). */
const STAFF_LEFT_REASON = 'left';

/** `POST /vehicles` and `POST /transport-routes` are keyed with no path id (as `POST /expenses`). */
const NO_PATH_ID = 0n;

export interface VehicleCreateOutcome {
  replayed: boolean;
  vehicle: VehicleDto;
}

export interface TransportRouteCreateOutcome {
  replayed: boolean;
  route: TransportRouteDetailDto;
}

const toVehicleDto = (v: VehicleRecord): VehicleDto => ({
  id: v.id.toString(),
  registration: v.registration,
  capacity: v.capacity,
  driverStaffId: v.driverStaffId?.toString() ?? null,
  driverName: v.driverName,
  status: v.status,
  routeNames: v.routeNames,
  retiredAt: v.retiredAt,
  retireReason: v.retireReason,
  createdAt: v.createdAt,
});

@Injectable()
export class TransportService {
  constructor(
    private readonly context: SchoolContext,
    private readonly transport: TransportRepository,
    private readonly staff: StaffRepository,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
    private readonly idempotency: IdempotentRequests,
  ) {}

  // ---------------------------------------------------------------------------------- vehicles

  async listVehicles(query: ListVehiclesQueryDto): Promise<Page<VehicleDto>> {
    const status = query.status ?? 'active';
    const { rows, total } = await this.transport.listVehicles(this.context.schoolId, {
      ...(query.registration === undefined ? {} : { registration: query.registration }),
      ...(status === 'all' ? {} : { status }),
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map(toVehicleDto), query, total);
  }

  /** Keyed (endpoint `vehicles`, no path id): a replay answers the vehicle as it is now. */
  async createVehicle(dto: CreateVehicleDto, rawKey: string | undefined): Promise<VehicleCreateOutcome> {
    const actor = this.context.actor();
    const outcome = await this.idempotency.withIdempotencyKey(actor, 'vehicles', NO_PATH_ID, dto, rawKey, (claim) =>
      this.createVehicleInTransaction(actor, dto, claim),
    );
    const id = outcome.replayed ? outcome.subjectId : outcome.value;
    return { replayed: outcome.replayed, vehicle: toVehicleDto(await this.requireVehicle(actor.schoolId, id)) };
  }

  @Transactional()
  private async createVehicleInTransaction(actor: Actor, dto: CreateVehicleDto, claim: IdempotencyClaim): Promise<bigint> {
    const recordSubject = await this.idempotency.claim(actor, 'vehicles', claim, 'vehicle');
    const { schoolId, userId } = actor;
    const driverStaffId = dto.driverStaffId === undefined ? null : await this.driver(schoolId, BigInt(dto.driverStaffId));
    const id = await this.transport.createVehicle(schoolId, {
      registration: dto.registration,
      capacity: dto.capacity,
      driverStaffId,
      createdBy: userId,
    });
    await recordSubject(id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'vehicle.created',
      subjectType: 'vehicle',
      subjectId: id,
      metadata: { registration: dto.registration, capacity: dto.capacity, driverStaffId: driverStaffId?.toString() ?? null },
    });
    return id;
  }

  /** R331: lowering the capacity below the riders is allowed; a retired vehicle is history. */
  @Transactional()
  async updateVehicle(id: bigint, dto: UpdateVehicleDto): Promise<VehicleDto> {
    const { schoolId, userId } = this.context.actor();
    const row = await this.requireVehicle(schoolId, id);
    if (row.status !== 'active') throw vehicleRetired(id);
    const data: { registration?: string; capacity?: number; driverStaffId?: bigint | null } = {};
    if (dto.registration !== undefined && dto.registration !== row.registration) data.registration = dto.registration;
    if (dto.capacity !== undefined && dto.capacity !== row.capacity) data.capacity = dto.capacity;
    if (dto.driverStaffId !== undefined) {
      const driverStaffId = dto.driverStaffId === null ? null : await this.driver(schoolId, BigInt(dto.driverStaffId));
      if (driverStaffId !== row.driverStaffId) data.driverStaffId = driverStaffId;
    }
    const fields = Object.keys(data);
    if (fields.length === 0) return toVehicleDto(row);
    if ((await this.transport.updateVehicle(schoolId, id, data)) !== 1) throw vehicleRetired(id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'vehicle.updated',
      subjectType: 'vehicle',
      subjectId: id,
      metadata: {
        fields: fields.join(','),
        ...(data.capacity === undefined ? {} : { capacity: data.capacity }),
        ...(data.driverStaffId === undefined ? {} : { driverStaffId: data.driverStaffId?.toString() ?? null }),
      },
    });
    return toVehicleDto(await this.requireVehicle(schoolId, id));
  }

  /**
   * B8 (Phase 5 close): a member who leaves stops being any active vehicle's driver, inside the
   * staff status change's transaction (no own @Transactional: it runs in the caller's), each
   * vehicle audited `vehicle.updated` with the reason `left`. Returns the vehicles cleared.
   */
  async clearDriverForLeaving(schoolId: SchoolId, staffId: bigint, actorUserId: bigint): Promise<bigint[]> {
    const cleared: bigint[] = [];
    for (const id of await this.transport.activeVehiclesDrivenBy(schoolId, staffId)) {
      if ((await this.transport.updateVehicle(schoolId, id, { driverStaffId: null })) !== 1) continue;
      await this.audit.record(schoolId, {
        actorUserId,
        action: 'vehicle.updated',
        subjectType: 'vehicle',
        subjectId: id,
        reason: STAFF_LEFT_REASON,
        metadata: { fields: 'driverStaffId', driverStaffId: null, via: 'staff_left' },
      });
      cleared.push(id);
    }
    return cleared;
  }

  /** R329: refused while an active route names the vehicle (VEHICLE_IN_USE). */
  @Transactional()
  async retireVehicle(id: bigint, reason: string): Promise<VehicleDto> {
    const { schoolId, userId } = this.context.actor();
    const row = await this.requireVehicle(schoolId, id);
    if (row.status !== 'active') throw vehicleRetired(id);
    const [route] = await this.transport.activeRoutesOfVehicle(schoolId, id);
    if (route !== undefined) {
      throw new ApiException(409, ErrorCode.VEHICLE_IN_USE, `The route "${route.name}" still uses this vehicle.`, {
        vehicleId: id.toString(),
        routeId: route.id.toString(),
      });
    }
    if ((await this.transport.retireVehicle(schoolId, id, { by: userId, reason, now: this.clock.now() })) !== 1) throw vehicleRetired(id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'vehicle.retired',
      subjectType: 'vehicle',
      subjectId: id,
      reason,
      metadata: { registration: row.registration },
    });
    return toVehicleDto(await this.requireVehicle(schoolId, id));
  }

  // ------------------------------------------------------------------------------------ routes

  async listRoutes(query: ListRoutesQueryDto): Promise<Page<TransportRouteDto>> {
    const schoolId = this.context.schoolId;
    const status = query.status ?? 'active';
    const { rows, total } = await this.transport.listRoutes(schoolId, {
      ...(query.name === undefined ? {} : { name: query.name }),
      ...(status === 'all' ? {} : { status }),
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const period = await this.currentPeriod(schoolId);
    const amounts = await this.transport.amountsOf(schoolId, rows.map((r) => r.id));
    return toPage(
      rows.map((r) => this.toRouteDto(r, amountsAround(amounts.filter((a) => a.routeId === r.id), period))),
      query,
      total,
    );
  }

  async getRoute(id: bigint): Promise<TransportRouteDetailDto> {
    const schoolId = this.context.schoolId;
    const route = await this.requireRoute(schoolId, id);
    const period = await this.currentPeriod(schoolId);
    const amounts = await this.transport.amountsOf(schoolId, [id]);
    const stops = await this.transport.liveStops(schoolId, id);
    return {
      ...this.toRouteDto(route, amountsAround(amounts, period)),
      stops: stops.map(toStopDto),
      amounts: amounts.map((a) => toAmountDto(a, period)),
    };
  }

  /** Keyed (endpoint `transport_routes`, no path id): a replay answers the route as it is now. */
  async createRoute(dto: CreateTransportRouteDto, rawKey: string | undefined): Promise<TransportRouteCreateOutcome> {
    const actor = this.context.actor();
    const outcome = await this.idempotency.withIdempotencyKey(actor, 'transport_routes', NO_PATH_ID, dto, rawKey, (claim) =>
      this.createRouteInTransaction(actor, dto, claim),
    );
    const id = outcome.replayed ? outcome.subjectId : outcome.value;
    return { replayed: outcome.replayed, route: await this.getRoute(id) };
  }

  @Transactional()
  private async createRouteInTransaction(actor: Actor, dto: CreateTransportRouteDto, claim: IdempotencyClaim): Promise<bigint> {
    const recordSubject = await this.idempotency.claim(actor, 'transport_routes', claim, 'transport_route');
    const { schoolId, userId } = actor;
    const vehicleId = dto.vehicleId === undefined ? null : await this.activeVehicle(schoolId, BigInt(dto.vehicleId));
    const stops = dto.stops ?? [];
    if (stops.some((s) => s.id !== undefined)) {
      throw fieldRefused('stops', ErrorCode.INVALID_VALUE, 'A new route has no stops to keep: leave id out');
    }
    assertDistinctOrders(stops);
    const id = await this.transport.createRoute(schoolId, { name: dto.name, vehicleId, createdBy: userId });
    await this.transport.insertStops(schoolId, id, stops.map(newStop));
    await recordSubject(id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'transport_route.created',
      subjectType: 'transport_route',
      subjectId: id,
      metadata: { name: dto.name, vehicleId: vehicleId?.toString() ?? null, stops: stops.length },
    });
    return id;
  }

  /**
   * §2.2: name, vehicle and the live stops as a whole — listed with an id are edited in place,
   * without one added, the rest ended (a reason; none may have a live rider).
   */
  @Transactional()
  async updateRoute(id: bigint, dto: UpdateTransportRouteDto): Promise<TransportRouteDetailDto> {
    const { schoolId, userId } = this.context.actor();
    const route = await readLocked(
      () => this.transport.findRoute(schoolId, id),
      (row) => this.transport.lockRouteIfUnchanged(schoolId, row),
    );
    if (route.status !== 'active') throw routeArchived(id);
    const data: { name?: string; vehicleId?: bigint | null } = {};
    if (dto.name !== undefined && dto.name !== route.name) data.name = dto.name;
    if (dto.vehicleId !== undefined) {
      const vehicleId = dto.vehicleId === null ? null : await this.activeVehicle(schoolId, BigInt(dto.vehicleId));
      if (vehicleId !== (route.vehicle?.id ?? null)) data.vehicleId = vehicleId;
    }
    const fields = Object.keys(data);
    if (fields.length > 0 && (await this.transport.updateRoute(schoolId, id, data)) !== 1) throw routeArchived(id);

    let stopsAdded = 0;
    let stopsEdited = 0;
    let stopsEnded = 0;
    if (dto.stops !== undefined) {
      const live = await this.transport.liveStops(schoolId, id);
      const byId = new Map(live.map((s) => [s.id, s]));
      const kept = new Set<bigint>();
      for (const item of dto.stops) {
        if (item.id === undefined) continue;
        const stopId = BigInt(item.id);
        if (!byId.has(stopId) || kept.has(stopId)) {
          throw fieldRefused('stops', ErrorCode.INVALID_VALUE, `Stop ${item.id} is not a live stop of this route`);
        }
        kept.add(stopId);
      }
      assertDistinctOrders(dto.stops);
      const ended = live.filter((s) => !kept.has(s.id)).map((s) => s.id);
      if (ended.length > 0) {
        if (dto.reason === undefined) {
          throw fieldRefused('reason', ErrorCode.INVALID_VALUE, 'A reason is required when a stop is removed');
        }
        const [inUse] = await this.transport.stopsInUse(schoolId, ended);
        if (inUse !== undefined) {
          throw new ApiException(409, ErrorCode.TRANSPORT_STOP_IN_USE, `A student is still assigned to "${byId.get(inUse)?.name ?? 'a stop'}".`, {
            stopId: inUse.toString(),
          });
        }
        stopsEnded = await this.transport.endStops(schoolId, id, ended, { by: userId, reason: dto.reason, now: this.clock.now() });
      }
      for (const item of dto.stops) {
        if (item.id === undefined) continue;
        const stop = byId.get(BigInt(item.id));
        if (stop === undefined || sameStop(stop, item)) continue;
        await this.transport.updateStop(schoolId, id, stop.id, newStop(item));
        stopsEdited += 1;
      }
      const added = dto.stops.filter((s) => s.id === undefined).map(newStop);
      await this.transport.insertStops(schoolId, id, added);
      stopsAdded = added.length;
    }

    if (fields.length > 0 || stopsAdded + stopsEdited + stopsEnded > 0) {
      await this.audit.record(schoolId, {
        actorUserId: userId,
        action: 'transport_route.updated',
        subjectType: 'transport_route',
        subjectId: id,
        ...(stopsEnded > 0 && dto.reason !== undefined ? { reason: dto.reason } : {}),
        metadata: {
          fields: fields.join(','),
          ...(data.vehicleId === undefined ? {} : { vehicleId: data.vehicleId?.toString() ?? null }),
          stopsAdded,
          stopsEdited,
          stopsEnded,
        },
      });
    }
    return this.getRoute(id);
  }

  /** R329: refused while a live assignment rides the route. */
  @Transactional()
  async archiveRoute(id: bigint, reason: string): Promise<TransportRouteDetailDto> {
    const { schoolId, userId } = this.context.actor();
    const route = await this.requireRoute(schoolId, id);
    if (route.status !== 'active') throw routeArchived(id);
    if (route.riders > 0) {
      throw new ApiException(409, ErrorCode.TRANSPORT_ROUTE_HAS_ASSIGNMENTS, 'Students are still assigned to this route. End their assignments first.', {
        routeId: id.toString(),
      });
    }
    if ((await this.transport.archiveRoute(schoolId, id, { by: userId, reason, now: this.clock.now() })) !== 1) throw routeArchived(id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'transport_route.archived',
      subjectType: 'transport_route',
      subjectId: id,
      reason,
      metadata: { name: route.name },
    });
    return this.getRoute(id);
  }

  // ----------------------------------------------------------------------------------- amounts

  /**
   * §2.3 (R327): from the next period, so a period's catch-up run charges what its first run did;
   * a route with no amount in force may take the current period (its first price).
   */
  @Transactional()
  async setAmount(routeId: bigint, dto: SetRouteAmountDto): Promise<TransportRouteAmountDto> {
    const { schoolId, userId } = this.context.actor();
    const route = await this.requireRoute(schoolId, routeId);
    if (route.status !== 'active') throw routeArchived(routeId);
    const period = await this.currentPeriod(schoolId);
    const live = (await this.transport.amountsOf(schoolId, [routeId])).filter((a) => a.voidedAt === null);
    const inForce = live.find((a) => a.effectivePeriod <= period);
    const earliest = inForce === undefined ? period : addMonths(period, 1);
    if (dto.effectivePeriod < earliest) {
      throw fieldRefused(
        'effectivePeriod',
        ErrorCode.TRANSPORT_AMOUNT_PERIOD_PAST,
        `A new amount starts from ${earliest} or later; the amount in force this month does not change`,
      );
    }
    if (live.some((a) => a.effectivePeriod === dto.effectivePeriod)) {
      throw new ApiException(409, ErrorCode.TRANSPORT_AMOUNT_PERIOD_TAKEN, 'The route already has an amount from that month. Void it first.', {
        routeId: routeId.toString(),
        effectivePeriod: dto.effectivePeriod,
      });
    }
    const id = await this.transport.createAmount(schoolId, {
      routeId,
      effectivePeriod: dto.effectivePeriod,
      amount: dto.amount,
      createdBy: userId,
    });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'transport_amount.set',
      subjectType: 'transport_route',
      subjectId: routeId,
      metadata: {
        amountId: id.toString(),
        effectivePeriod: dto.effectivePeriod,
        amount: dto.amount,
        previousAmount: inForce?.amount ?? null,
      },
    });
    return this.amountDto(schoolId, id, period);
  }

  /** A mistaken future amount, voided before its month starts (TRANSPORT_AMOUNT_PERIOD_PAST). */
  @Transactional()
  async voidAmount(id: bigint, reason: string): Promise<TransportRouteAmountDto> {
    const { schoolId, userId } = this.context.actor();
    const amount = await this.transport.findAmount(schoolId, id);
    if (!amount) throw notFound();
    if (amount.voidedAt !== null) throw new ApiException(409, ErrorCode.STALE_STATUS, 'This amount is already voided.');
    const period = await this.currentPeriod(schoolId);
    if (amount.effectivePeriod <= period) {
      throw new ApiException(409, ErrorCode.TRANSPORT_AMOUNT_PERIOD_PAST, 'An amount whose month has started cannot be voided.', {
        routeId: amount.routeId.toString(),
        effectivePeriod: amount.effectivePeriod,
      });
    }
    if ((await this.transport.voidAmount(schoolId, id, { by: userId, reason, now: this.clock.now() })) !== 1) {
      throw new ApiException(409, ErrorCode.STALE_STATUS, 'This amount is already voided.');
    }
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'transport_amount.voided',
      subjectType: 'transport_route',
      subjectId: amount.routeId,
      reason,
      metadata: { amountId: id.toString(), effectivePeriod: amount.effectivePeriod, amount: amount.amount },
    });
    return this.amountDto(schoolId, id, period);
  }

  // ----------------------------------------------------------------------------------- helpers

  private toRouteDto(r: RouteRecord, amounts: ReturnType<typeof amountsAround>): TransportRouteDto {
    return {
      id: r.id.toString(),
      name: r.name,
      status: r.status,
      vehicle:
        r.vehicle === null
          ? null
          : { id: r.vehicle.id.toString(), registration: r.vehicle.registration, capacity: r.vehicle.capacity, driverName: r.vehicle.driverName },
      riders: r.riders,
      currentAmount: amounts.current,
      nextAmount: amounts.next,
      stopCount: r.stopCount,
      archivedAt: r.archivedAt,
      archiveReason: r.archiveReason,
    };
  }

  private async amountDto(schoolId: SchoolId, id: bigint, period: string): Promise<TransportRouteAmountDto> {
    const row = await this.transport.findAmount(schoolId, id);
    if (!row) throw notFound();
    return toAmountDto(row, period);
  }

  private async requireVehicle(schoolId: SchoolId, id: bigint): Promise<VehicleRecord> {
    const row = await this.transport.findVehicle(schoolId, id);
    if (!row) throw notFound();
    return row;
  }

  private async requireRoute(schoolId: SchoolId, id: bigint): Promise<RouteRecord> {
    const row = await this.transport.findRoute(schoolId, id);
    if (!row) throw notFound();
    return row;
  }

  /** The vehicle a route names: this school's, active. */
  private async activeVehicle(schoolId: SchoolId, id: bigint): Promise<bigint> {
    const row = await this.transport.findVehicle(schoolId, id);
    if (!row) throw fieldRefused('vehicleId', ErrorCode.REFERENCE_NOT_FOUND, 'No such vehicle');
    if (row.status !== 'active') throw vehicleRetired(id);
    return row.id;
  }

  /** A driver: a staff member of this school who has not left. */
  private async driver(schoolId: SchoolId, staffId: bigint): Promise<bigint> {
    const row = await this.staff.findById(schoolId, staffId);
    if (!row || row.status === 'left') {
      throw fieldRefused('driverStaffId', ErrorCode.REFERENCE_NOT_FOUND, 'The driver must be a current staff member');
    }
    return row.id;
  }

  private async currentPeriod(schoolId: SchoolId): Promise<string> {
    return periodOf(await this.clock.today(schoolId));
  }
}

/** §2.2: the live stops' orders are distinct (the database checks again at commit). */
function assertDistinctOrders(stops: readonly StopInputDto[]): void {
  const orders = new Set<number>();
  for (const stop of stops) {
    if (orders.has(stop.sortOrder)) {
      throw fieldRefused('stops', ErrorCode.INVALID_VALUE, `Two stops share the order ${stop.sortOrder}`);
    }
    orders.add(stop.sortOrder);
  }
}

const newStop = (s: StopInputDto): NewStop => ({
  sortOrder: s.sortOrder,
  name: s.name,
  pickupTime: s.pickupTime === undefined ? null : timeColumn(s.pickupTime),
});

const sameStop = (stop: StopRecord, item: StopInputDto): boolean =>
  stop.sortOrder === item.sortOrder &&
  stop.name === item.name &&
  (stop.pickupTime?.getTime() ?? null) === (item.pickupTime === undefined ? null : timeColumn(item.pickupTime).getTime());
