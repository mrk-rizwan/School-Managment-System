import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import { scopeOf, type SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { readLocked } from '../../common/locking';
import { toPage, type Page } from '../../common/pagination';
import { addDays, SchoolClock } from '../../common/school-clock';
import { SchoolContext, type Actor } from '../../common/school-context';
import { timeOfDay } from '../../common/school-settings-reader';
import { AcademicYearRepository } from '../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { EnrolmentRepository } from '../../repositories/enrolment.repository';
import { StudentRepository } from '../../repositories/student.repository';
import { TransportRepository, type AssignmentRecord } from '../../repositories/transport.repository';
import type { SchoolId } from '../../tenancy/school-id';
import type { Scope } from '../../tenancy/scope';
import { fromDateString, toDateString } from '../academics/academics.shared';
import type {
  CapacityWarningDto,
  CreateTransportAssignmentDto,
  EndTransportAssignmentDto,
  ListRouteAssignmentsQueryDto,
  MyDriverRouteDto,
  MyTransportDto,
  StudentTransportDto,
  TransportAssignmentCreatedDto,
  TransportAssignmentDto,
  TransportAssignmentStatus,
} from './transport.dto';
import { toStopDto } from './transport.shared';

// Phase 5 slice 41 (phase-5-extended.md rule 37, §1.3 A8, R326, R329-R331; contracts/slice-41.md
// §2.4, §2.5, §2.7): a student's route assignments — one live per student per year, never edited
// (a change is end-then-start), keyed to the enrolment live when it starts — and the reads of the
// office, the family and the driver. Leaving and promotion end live assignments through
// endForStudents, inside their own transactions.

const ENDPOINT = 'transport_assignments';
const SUBJECT = 'transport_assignment';
/** StudentTransportDto.history: at most this many earlier assignments. */
const HISTORY = 20;

/** How an assignment came to end (audit metadata `via`). */
export type TransportEndVia = 'end' | 'status_change' | 'promotion';

export interface TransportAssignmentCreateOutcome {
  replayed: boolean;
  assignment: TransportAssignmentCreatedDto;
}

export function assignmentStatus(row: Pick<AssignmentRecord, 'startsOn' | 'endedAt'>, today: Date): TransportAssignmentStatus {
  if (row.endedAt !== null) return 'ended';
  return row.startsOn > today ? 'upcoming' : 'live';
}

export function toAssignmentDto(row: AssignmentRecord, today: Date): TransportAssignmentDto {
  return {
    id: row.id.toString(),
    studentId: row.studentId.toString(),
    studentName: row.studentName,
    admissionNo: row.admissionNo,
    className: row.className,
    sectionName: row.sectionName,
    academicYearId: row.academicYearId.toString(),
    routeId: row.routeId.toString(),
    routeName: row.routeName,
    stopId: row.stopId?.toString() ?? null,
    stopName: row.stopName,
    pickupTime: row.pickupTime === null ? null : timeOfDay(row.pickupTime),
    startsOn: toDateString(row.startsOn),
    endsOn: row.endsOn === null ? null : toDateString(row.endsOn),
    status: assignmentStatus(row, today),
    endReason: row.endReason,
    endedByName: row.endedByName,
    createdAt: row.createdAt,
  };
}

/** First day of the month of `day` (UTC midnight). */
const monthStart = (day: Date): Date => new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));

@Injectable()
export class TransportAssignmentsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly transport: TransportRepository,
    private readonly students: StudentRepository,
    private readonly enrolments: EnrolmentRepository,
    private readonly years: AcademicYearRepository,
    private readonly idempotency: IdempotentRequests,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
  ) {}

  // ------------------------------------------------------------------------------------- reads

  /** GET /transport-routes/:id/assignments: live (or every) assignment, by student name. */
  async listForRoute(session: SchoolSessionContext, routeId: bigint, query: ListRouteAssignmentsQueryDto): Promise<Page<TransportAssignmentDto>> {
    const schoolId = this.context.schoolId;
    if (!(await this.transport.findRoute(schoolId, routeId))) throw notFound();
    const today = await this.clock.today(schoolId);
    const { rows, total } = await this.transport.listForRoute(schoolId, scopeOf(session), routeId, {
      includeEnded: query.includeEnded ?? false,
      ...(query.studentName === undefined ? {} : { studentName: query.studentName }),
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map((r) => toAssignmentDto(r, today)), query, total);
  }

  /** GET /students/:id/transport: the current assignment and the earlier ones (scoped). */
  async forStudent(session: SchoolSessionContext, studentId: bigint): Promise<StudentTransportDto> {
    const schoolId = this.context.schoolId;
    const scope = scopeOf(session);
    if (!(await this.students.findById(schoolId, scope, studentId))) throw notFound();
    const today = await this.clock.today(schoolId);
    const rows = await this.transport.listForStudent(schoolId, scope, studentId, HISTORY + 1);
    // A row ended on the day before its start was never in force (as family() reads it): history only.
    const current =
      rows.find((r) => !(r.endsOn !== null && r.endsOn < r.startsOn) && (r.endsOn === null || r.endsOn >= today)) ?? null;
    return {
      current: current === null ? null : toAssignmentDto(current, today),
      history: rows.filter((r) => r !== current).slice(0, HISTORY).map((r) => toAssignmentDto(r, today)),
    };
  }

  /**
   * GET /me/children/:id/transport, GET /me/student/transport (R330): route, stop, pickup time
   * and driver name only. A child outside the capacity scope is 404.
   */
  async family(session: SchoolSessionContext, childId: bigint | null): Promise<MyTransportDto> {
    const schoolId = this.context.schoolId;
    const scope = scopeOf(session);
    const id = childId ?? (scope.kind === 'students' ? scope.ids[0] : undefined);
    if (id === undefined || scope.kind !== 'students' || !scope.ids.includes(id)) throw notFound();
    const row = await this.transport.currentForStudent(schoolId, scope, id, await this.clock.today(schoolId));
    if (row === null || (row.endsOn !== null && row.endsOn < row.startsOn)) return { current: null };
    return {
      current: {
        routeName: row.routeName,
        stopName: row.stopName,
        pickupTime: row.pickupTime === null ? null : timeOfDay(row.pickupTime),
        driverName: row.driverName,
        startsOn: toDateString(row.startsOn),
        endsOn: row.endsOn === null ? null : toDateString(row.endsOn),
      },
    };
  }

  /** GET /me/staff/transport-routes (R330): the routes whose vehicle names the caller as driver. */
  async driverRoutes(session: SchoolSessionContext): Promise<MyDriverRouteDto[]> {
    const schoolId = this.context.schoolId;
    const staffId = session.access.staffId;
    if (staffId === null) return [];
    const routes = await this.transport.driverRoutes(schoolId, staffId, await this.clock.today(schoolId));
    const stops = await this.transport.liveStopsOf(schoolId, routes.map((r) => r.id));
    return routes.map((r) => ({
      id: r.id.toString(),
      name: r.name,
      vehicleRegistration: r.registration,
      stops: stops.filter((s) => s.routeId === r.id).map(toStopDto),
      students: r.riders.map((x) => ({ name: x.name, stopId: x.stopId?.toString() ?? null })),
    }));
  }

  // ------------------------------------------------------------------------------------ writes

  /** POST /transport-routes/:id/assignments, keyed (endpoint transport_assignments, path id the route). */
  async create(
    session: SchoolSessionContext,
    routeId: bigint,
    dto: CreateTransportAssignmentDto,
    rawKey: string | undefined,
  ): Promise<TransportAssignmentCreateOutcome> {
    const actor = this.context.actor();
    let capacityWarning: CapacityWarningDto | null = null;
    const outcome = await this.idempotency.withIdempotencyKey(actor, ENDPOINT, routeId, dto, rawKey, async (claim) => {
      const created = await this.createInTransaction(actor, scopeOf(session), routeId, dto, claim);
      capacityWarning = created.warning;
      return created.id;
    });
    const id = outcome.replayed ? outcome.subjectId : outcome.value;
    const row = await this.transport.findAssignment(actor.schoolId, scopeOf(session), id);
    if (!row) throw notFound();
    // A replay answers the route's live riders against its vehicle now (nothing is audited again).
    if (outcome.replayed) capacityWarning = await this.capacityWarning(actor.schoolId, row.routeId);
    return {
      replayed: outcome.replayed,
      assignment: { ...toAssignmentDto(row, await this.clock.today(actor.schoolId)), capacityWarning },
    };
  }

  @Transactional()
  private async createInTransaction(
    actor: Actor,
    scope: Scope,
    routeId: bigint,
    dto: CreateTransportAssignmentDto,
    claim: IdempotencyClaim,
  ): Promise<{ id: bigint; warning: CapacityWarningDto | null }> {
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, SUBJECT);
    const { schoolId, userId } = actor;
    const route = await this.transport.findRoute(schoolId, routeId);
    if (!route) throw notFound();
    if (route.status !== 'active') {
      throw new ApiException(409, ErrorCode.TRANSPORT_ROUTE_ARCHIVED, 'The route is archived.', { routeId: routeId.toString() });
    }
    const studentId = BigInt(dto.studentId);
    // The student row held for the checks below (a second start for the same student waits).
    await readLocked(
      () => this.students.findById(schoolId, scope, studentId),
      (row) => this.students.lockIfUnchanged(schoolId, row),
    );
    const enrolment = await this.enrolments.findActiveForStudent(schoolId, scope, studentId);
    if (!enrolment) throw fieldRefused('studentId', ErrorCode.INVALID_VALUE, 'The student has no active enrolment');
    const year = await this.years.findById(schoolId, enrolment.academicYearId);
    if (!year) throw notFound();

    const startsOn = fromDateString(dto.startsOn);
    const today = await this.clock.today(schoolId);
    const earliest = [enrolment.startedOn, monthStart(today)].reduce((a, b) => (b > a ? b : a));
    if (startsOn < earliest) {
      throw fieldRefused('startsOn', ErrorCode.INVALID_VALUE, `startsOn must be on or after ${toDateString(earliest)} (the enrolment's start and this month)`);
    }
    if (startsOn > year.endsOn) {
      throw fieldRefused('startsOn', ErrorCode.INVALID_VALUE, `startsOn must be inside the academic year (ends ${toDateString(year.endsOn)})`);
    }
    const prior = await this.transport.yearAssignments(schoolId, studentId, enrolment.academicYearId);
    const live = prior.find((a) => a.endedAt === null);
    if (live) {
      throw new ApiException(409, ErrorCode.TRANSPORT_ASSIGNMENT_LIVE, 'The student already has a live route this year. End it first.', {
        studentId: studentId.toString(),
        assignmentId: live.id.toString(),
      });
    }
    const lastDay = prior.reduce<Date | null>((max, a) => (a.endsOn !== null && (max === null || a.endsOn > max) ? a.endsOn : max), null);
    if (lastDay !== null && startsOn <= lastDay) {
      throw fieldRefused('startsOn', ErrorCode.INVALID_VALUE, `startsOn must be after the last day of the previous route (${toDateString(lastDay)})`);
    }
    let stopId: bigint | null = null;
    if (dto.stopId !== undefined) {
      stopId = BigInt(dto.stopId);
      const stops = await this.transport.liveStops(schoolId, routeId);
      if (!stops.some((s) => s.id === stopId)) throw fieldRefused('stopId', ErrorCode.INVALID_VALUE, 'stopId must be a live stop of the route');
    }

    const id = await this.transport.createAssignment(schoolId, {
      studentId,
      academicYearId: enrolment.academicYearId,
      enrolmentId: enrolment.id,
      routeId,
      stopId,
      startsOn,
      createdBy: userId,
    });
    await recordSubject(id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'transport_assignment.started',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: {
        studentId: studentId.toString(),
        routeId: routeId.toString(),
        stopId: stopId?.toString() ?? null,
        startsOn: dto.startsOn,
        academicYearId: enrolment.academicYearId.toString(),
      },
    });

    // R331: over capacity warns and is audited; it never blocks.
    const warning = await this.capacityWarning(schoolId, routeId);
    if (warning !== null && route.vehicle !== null) {
      await this.audit.record(schoolId, {
        actorUserId: userId,
        action: 'transport.capacity_exceeded',
        subjectType: 'transport_route',
        subjectId: routeId,
        metadata: {
          routeId: routeId.toString(),
          vehicleId: route.vehicle.id.toString(),
          capacity: warning.capacity,
          riders: warning.riders,
          assignmentId: id.toString(),
        },
      });
    }
    return { id, warning };
  }

  /** R331: the route's live riders against its vehicle's seats, when they exceed them. */
  private async capacityWarning(schoolId: SchoolId, routeId: bigint): Promise<CapacityWarningDto | null> {
    const route = await this.transport.findRoute(schoolId, routeId);
    if (!route || route.vehicle === null || route.riders <= route.vehicle.capacity) return null;
    return { capacity: route.vehicle.capacity, riders: route.riders };
  }

  /** POST /transport-assignments/:id/end (R326): the last day on the route, with a reason. */
  @Transactional()
  async end(session: SchoolSessionContext, id: bigint, dto: EndTransportAssignmentDto): Promise<TransportAssignmentDto> {
    const { schoolId, userId } = this.context.actor();
    const scope = scopeOf(session);
    const row = await this.transport.findAssignment(schoolId, scope, id);
    if (!row) throw notFound();
    if (row.endedAt !== null) throw new ApiException(409, ErrorCode.STALE_STATUS, 'This assignment has already ended.');
    const endsOn = fromDateString(dto.endedOn);
    // From the day before the start (never in force), and never before the last day of the previous
    // month (school time): a month whose charge may already be generated is not un-ridden backwards.
    const previousMonthEnd = addDays(monthStart(await this.clock.today(schoolId)), -1);
    const neverInForce = addDays(row.startsOn, -1);
    const earliest = neverInForce > previousMonthEnd ? neverInForce : previousMonthEnd;
    if (endsOn < earliest) {
      throw fieldRefused(
        'endedOn',
        ErrorCode.INVALID_VALUE,
        `endedOn must be on or after ${toDateString(earliest)} (the day before the route starts and the end of last month)`,
      );
    }
    const year = await this.years.findById(schoolId, row.academicYearId);
    if (year && endsOn > year.endsOn) {
      throw fieldRefused('endedOn', ErrorCode.INVALID_VALUE, `endedOn must be inside the academic year (ends ${toDateString(year.endsOn)})`);
    }
    if ((await this.transport.endAssignment(schoolId, id, endsOn, { by: userId, reason: dto.reason, now: new Date() })) !== 1) {
      throw new ApiException(409, ErrorCode.STALE_STATUS, 'This assignment has already ended.');
    }
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'transport_assignment.ended',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: { studentId: row.studentId.toString(), routeId: row.routeId.toString(), endsOn: dto.endedOn, via: 'end' },
    });
    const ended = await this.transport.findAssignment(schoolId, scope, id);
    if (!ended) throw notFound();
    return toAssignmentDto(ended, await this.clock.today(schoolId));
  }

  /**
   * A8 (contracts/slice-41.md §2.7): leaving or promotion ends the students' live assignments (of
   * one year when given) on `on` — or on the day before an assignment starts when that is later,
   * so a future one was never in force. Runs inside the caller's transaction; audited per row.
   */
  async endForStudents(
    schoolId: SchoolId,
    actorUserId: bigint,
    studentIds: readonly bigint[],
    on: Date,
    reason: string,
    via: TransportEndVia,
    academicYearId?: bigint,
  ): Promise<number> {
    const live = await this.transport.liveOf(schoolId, studentIds, academicYearId);
    const now = new Date();
    let ended = 0;
    for (const row of live) {
      const endsOn = on < row.startsOn ? addDays(row.startsOn, -1) : on;
      if ((await this.transport.endAssignment(schoolId, row.id, endsOn, { by: actorUserId, reason, now })) !== 1) continue;
      ended += 1;
      await this.audit.record(schoolId, {
        actorUserId,
        action: 'transport_assignment.ended',
        subjectType: SUBJECT,
        subjectId: row.id,
        reason,
        metadata: { studentId: row.studentId.toString(), routeId: row.routeId.toString(), endsOn: toDateString(endsOn), via },
      });
    }
    return ended;
  }
}
