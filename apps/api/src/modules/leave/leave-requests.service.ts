import type { ReasonDto } from '../../common/reason.dto';
import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import {
  Capability,
  ErrorCode,
  isStaffWorkingDay,
  leaveBalance,
  type LeaveStatus,
  type SchoolCalendar,
} from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { readLocked } from '../../common/locking';
import { toPage, type Page } from '../../common/pagination';
import { addDays, SchoolClock } from '../../common/school-clock';
import { SchoolContext, type Actor } from '../../common/school-context';
import { NotificationService } from '../../messaging/notification.service';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ChangeContextRepository } from '../../repositories/change-context.repository';
import {
  LeaveRequestRepository,
  TAKEN_LEAVE_STATUSES,
  type ClassTeacherRow,
  type LeaveRequestRecord,
} from '../../repositories/leave-request.repository';
import { LeaveTypeRepository, type LeaveTypeRecord } from '../../repositories/leave-type.repository';
import { StaffRepository, type StaffRecord } from '../../repositories/staff.repository';
import { TeacherAssignmentRepository } from '../../repositories/teacher-assignment.repository';
import { UserRepository } from '../../repositories/user.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { fromDateString, toDateString } from '../academics/academics.shared';
import { PermissionsService } from '../access/permissions.service';
import { CalendarService } from '../calendar/calendar.service';
import { staffNotActive } from '../people/staff/staff.errors';
import { TeacherAssignmentsService } from '../people/staff/teacher-assignments.service';
import type {
  ApproveLeaveRequestDto,
  CreateLeaveRequestDto,
  CreateMyLeaveRequestDto,
  EndLeaveEarlyDto,
  LeaveBalanceDto,
  LeaveRequestDto,
  ListLeaveRequestsQueryDto,
  ListMyLeaveRequestsQueryDto,
  SectionNeedingCoverDto,
  StaffLeaveRequestDto,
} from './leave.dto';

// phase-3-financial.md slice 24 (R209-R212, R248, R253); contracts/slice-24.md. Lock order: the
// staff row (create), else the request row; then, on approval with a cover, what the slice-10
// cover assignment locks (the covering staff row, the class, the year). Rows are never deleted.

const ENDPOINT = 'leave_requests';
const SUBJECT = 'leave_request';
/** A request may start at most this many days before today (§5 slice 24). */
const BACKDATE_DAYS = 7;
/** Inclusive length limit (leave_requests_dates_check). */
const MAX_DAYS = 60;

export interface LeaveRequestCreateOutcome {
  replayed: boolean;
  request: LeaveRequestDto;
}

const maxDate = (a: Date, b: Date): Date => (a > b ? a : b);
const minDate = (a: Date, b: Date): Date => (a < b ? a : b);
const yearStart = (year: number): Date => fromDateString(`${year}-01-01`);
const yearEnd = (year: number): Date => fromDateString(`${year}-12-31`);

/** The last day a request holds: ended early, else its end. */
const lastTaken = (row: Pick<LeaveRequestRecord, 'endedEarlyOn' | 'endsOn'>): Date =>
  row.endedEarlyOn ?? row.endsOn;

/** Staff working days from..to, both inclusive (weekly offs and staff holidays excluded, R209). */
export function staffWorkingDays(from: Date, to: Date, calendar: SchoolCalendar): number {
  let count = 0;
  for (let date = from; date <= to; date = addDays(date, 1)) {
    if (isStaffWorkingDay(toDateString(date), calendar)) count += 1;
  }
  return count;
}

const leaveOverlaps = (leaveRequestId: bigint): ApiException =>
  new ApiException(409, ErrorCode.LEAVE_OVERLAPS, 'This overlaps another leave request.', {
    leaveRequestId: leaveRequestId.toString(),
  });

const balanceExceeded = (balance: number, year: number): ApiException =>
  new ApiException(
    409,
    ErrorCode.LEAVE_BALANCE_EXCEEDED,
    `Not enough leave left for ${year}: ${Math.max(0, balance)} working ${balance === 1 ? 'day' : 'days'}.`,
    { balance, year },
  );

const notPending = (status: LeaveStatus): ApiException =>
  new ApiException(409, ErrorCode.LEAVE_NOT_PENDING, 'This request is no longer pending.', { status });

const leaveStarted = (): ApiException =>
  new ApiException(409, ErrorCode.LEAVE_STARTED, 'This leave has started. Ask an approver to end it early.');

const illegalTransition = (status: LeaveStatus): ApiException =>
  new ApiException(409, ErrorCode.ILLEGAL_STATUS_TRANSITION, `A ${status.replace('_', ' ')} request cannot do this.`, {
    status,
  });

const typeArchived = (leaveTypeId: bigint): ApiException =>
  new ApiException(409, ErrorCode.LEAVE_TYPE_ARCHIVED, 'This leave type is archived.', {
    leaveTypeId: leaveTypeId.toString(),
  });

/** Approving with a cover creates a teacher assignment, which needs class.manage. */
const coverNeedsClassManage = (): ApiException =>
  new ApiException(
    403,
    ErrorCode.PERMISSION_DENIED,
    'Assigning a cover needs permission to manage classes. Approve without a cover, or ask someone who can.',
    { reason: 'cover_needs_class_manage' },
  );

/** R210: nobody decides or ends their own leave (the sole principal's approval excepted, R253). */
const ownLeave = (leaveRequestId: bigint): ApiException =>
  new ApiException(
    409,
    ErrorCode.SELF_ACTION_FORBIDDEN,
    'You cannot decide your own leave. Ask a colleague.',
    { reason: 'own_leave', leaveRequestId: leaveRequestId.toString() },
  );

@Injectable()
export class LeaveRequestsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly requests: LeaveRequestRepository,
    private readonly types: LeaveTypeRepository,
    private readonly staff: StaffRepository,
    private readonly users: UserRepository,
    private readonly assignments: TeacherAssignmentRepository,
    private readonly teacherAssignments: TeacherAssignmentsService,
    private readonly calendar: CalendarService,
    private readonly clock: SchoolClock,
    private readonly permissions: PermissionsService,
    private readonly changeContext: ChangeContextRepository,
    private readonly audit: AuditLogRepository,
    private readonly notifications: NotificationService,
    private readonly idempotency: IdempotentRequests,
  ) {}

  // ---------------------------------------------------------------------------------- reads

  /** The caller's own staff id (@RequireStaff admits only an active staff capacity). */
  ownStaffId(session: SchoolSessionContext): bigint {
    const staffId = session.access.staffId;
    if (staffId === null) throw notFound();
    return staffId;
  }

  async list(query: ListLeaveRequestsQueryDto): Promise<Page<LeaveRequestDto>> {
    return this.page(query, {
      ...(query.staffId === undefined ? {} : { staffId: BigInt(query.staffId) }),
      ...(query.startsFrom === undefined ? {} : { startsFrom: fromDateString(query.startsFrom) }),
      ...(query.startsTo === undefined ? {} : { startsTo: fromDateString(query.startsTo) }),
      sort: query.sort ?? '-requestedAt',
    });
  }

  /** One staff member's requests, newest first (/me/staff and /staff/:id). */
  async listForStaff(staffId: bigint, query: ListMyLeaveRequestsQueryDto): Promise<Page<LeaveRequestDto>> {
    if (!(await this.staff.findById(this.context.schoolId, staffId))) throw notFound();
    return this.page(query, { staffId, sort: '-requestedAt' });
  }

  /**
   * GET /staff/:id/leave-requests for staff.view holders: without `reason` and `decisionReason`,
   * which can be medical; those stay with the person and the approvers.
   */
  async listForStaffView(staffId: bigint, query: ListMyLeaveRequestsQueryDto): Promise<Page<StaffLeaveRequestDto>> {
    const page = await this.listForStaff(staffId, query);
    return { ...page, data: page.data.map(({ reason: _reason, decisionReason: _decision, ...rest }) => rest) };
  }

  /** Any request (approvers), or only the staff member's own (`ownerStaffId`). */
  async get(id: bigint, ownerStaffId?: bigint): Promise<LeaveRequestDto> {
    const schoolId = this.context.schoolId;
    const row = await this.requests.findById(schoolId, id);
    if (!row || (ownerStaffId !== undefined && row.staffId !== ownerStaffId)) throw notFound();
    return this.one(schoolId, row);
  }

  /** R209: per live type, the year's entitlement, taken and pending working days. */
  async balance(staffId: bigint, year: number | undefined): Promise<LeaveBalanceDto> {
    const schoolId = this.context.schoolId;
    const member = await this.staff.findById(schoolId, staffId);
    if (!member) throw notFound();
    const y = year ?? (await this.clock.today(schoolId)).getUTCFullYear();
    const taken = await this.daysByType(schoolId, staffId, y, TAKEN_LEAVE_STATUSES);
    const pending = await this.daysByType(schoolId, staffId, y, ['pending']);
    const types = await this.types.listActive(schoolId);
    return {
      year: y,
      types: types.map((type) => {
        const used = taken.get(type.id) ?? 0;
        const b = leaveBalance(type.daysPerYear, joinedOn(member), y, used);
        return {
          leaveTypeId: type.id.toString(),
          name: type.name,
          code: type.code,
          paid: type.paid,
          entitlement: b.entitled,
          used,
          pending: pending.get(type.id) ?? 0,
          balance: b.remaining,
        };
      }),
    };
  }

  // ------------------------------------------------------------------------------- requests

  /**
   * POST /me/staff/leave-requests and the on-behalf POST /leave-requests. Keyed by
   * Idempotency-Key (endpoint leave_requests, path id the staff member). `leave_requested` goes to
   * the approvers after commit.
   */
  async create(
    session: SchoolSessionContext,
    staffId: bigint,
    dto: CreateMyLeaveRequestDto | CreateLeaveRequestDto,
    onBehalf: boolean,
    rawKey: string | undefined,
  ): Promise<LeaveRequestCreateOutcome> {
    const actor = this.context.actor();
    if (onBehalf && staffId === session.access.staffId) {
      throw fieldRefused('staffId', ErrorCode.INVALID_VALUE, 'Request your own leave from My leave');
    }
    const outcome = await this.idempotency.withIdempotencyKey(actor, ENDPOINT, staffId, dto, rawKey, (claim) =>
      this.createInTransaction(actor, staffId, dto, onBehalf, claim, session.access.staffId),
    );
    const schoolId = actor.schoolId;
    const row = outcome.replayed
      ? await this.requests.findById(schoolId, outcome.subjectId)
      : outcome.value;
    if (!row) throw notFound();
    return { replayed: outcome.replayed, request: await this.one(schoolId, row) };
  }

  @Transactional()
  private async createInTransaction(
    actor: Actor,
    staffId: bigint,
    dto: CreateMyLeaveRequestDto,
    onBehalf: boolean,
    claim: IdempotencyClaim,
    requesterStaffId: bigint | null,
  ): Promise<LeaveRequestRecord> {
    const { schoolId, userId } = actor;
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, SUBJECT);
    // The staff row serialises one member's requests, so the balance is read stable.
    const member = await readLocked(
      () => this.staff.findById(schoolId, staffId),
      (row) => this.staff.lockIfUnchanged(schoolId, row),
      () =>
        onBehalf
          ? fieldRefused('staffId', ErrorCode.REFERENCE_NOT_FOUND, 'No such staff member')
          : notFound(),
    );
    if (member.status !== 'active') throw staffNotActive();

    const type = await this.types.findById(schoolId, BigInt(dto.leaveTypeId));
    if (!type) throw fieldRefused('leaveTypeId', ErrorCode.REFERENCE_NOT_FOUND, 'No such leave type');

    const startsOn = fromDateString(dto.startsOn);
    const endsOn = fromDateString(dto.endsOn);
    const today = await this.clock.today(schoolId);
    if (startsOn < addDays(today, -BACKDATE_DAYS)) {
      throw fieldRefused('startsOn', ErrorCode.INVALID_VALUE, `startsOn must be at most ${BACKDATE_DAYS} days ago`);
    }
    if (endsOn < startsOn) {
      throw fieldRefused('endsOn', ErrorCode.INVALID_VALUE, 'endsOn must be on or after startsOn');
    }
    if (endsOn > addDays(startsOn, MAX_DAYS - 1)) {
      throw fieldRefused('endsOn', ErrorCode.INVALID_VALUE, `A request covers at most ${MAX_DAYS} days`);
    }
    const { value: cal } = await this.calendar.calendar(schoolId, startsOn, endsOn);
    const workingDays = staffWorkingDays(startsOn, endsOn, cal);
    if (workingDays === 0) {
      throw fieldRefused('endsOn', ErrorCode.INVALID_VALUE, 'The dates hold no working day');
    }

    if (type.status === 'archived') throw typeArchived(type.id);
    const overlap = await this.requests.findLiveOverlapping(schoolId, staffId, startsOn, endsOn);
    if (overlap) throw leaveOverlaps(overlap.id);
    // Pending requests are held against the balance too, so two cannot together exceed it.
    await this.assertBalance(schoolId, member, type, startsOn, endsOn, cal, true);

    const created = await this.requests.create(schoolId, {
      staffId,
      leaveTypeId: type.id,
      startsOn,
      endsOn,
      workingDays,
      reason: dto.reason,
      requestedBy: userId,
      onBehalf,
    });
    await recordSubject(created.id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'leave_request.created',
      subjectType: SUBJECT,
      subjectId: created.id,
      reason: dto.reason,
      metadata: {
        staffId: staffId.toString(),
        leaveTypeId: type.id.toString(),
        startsOn: dto.startsOn,
        endsOn: dto.endsOn,
        workingDays,
        onBehalf,
      },
    });
    // Not the person on leave, nor the approver who recorded it for them.
    const recipients = (await this.approverStaffIds(schoolId)).filter(
      (id) => id !== staffId && id !== requesterStaffId,
    );
    if (recipients.length > 0) {
      await this.notifications.send(schoolId, {
        type: 'leave_requested',
        subject: { type: SUBJECT, id: created.id },
        recipients: recipients.map((id) => ({ staffId: id })),
        vars: { staffName: member.fullName, typeName: type.name, startsOn, endsOn, workingDays },
      });
    }
    return created;
  }

  /** Own: pending, or approved before it starts (LEAVE_STARTED otherwise); ends its cover (R212). */
  @Transactional()
  async cancel(session: SchoolSessionContext, id: bigint, dto: ReasonDto): Promise<LeaveRequestDto> {
    const { schoolId, userId } = this.context.actor();
    const staffId = this.ownStaffId(session);
    const row = await this.lock(schoolId, id);
    if (row.staffId !== staffId) throw notFound();
    const today = await this.clock.today(schoolId);
    if (row.status === 'approved' && row.startsOn <= today) throw leaveStarted();
    if (row.status !== 'pending' && row.status !== 'approved') throw illegalTransition(row.status);
    if ((await this.requests.cancel(schoolId, id, row.status, userId, dto.reason)) === 0) {
      throw illegalTransition(row.status);
    }
    if (row.coverAssignmentId !== null) await this.endCover(row.coverAssignmentId, null, dto.reason);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'leave_request.cancelled',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: { from: row.status, coverAssignmentId: row.coverAssignmentId?.toString() ?? null },
    });
    return this.reload(schoolId, id);
  }

  /**
   * staff.leave.approve. Never one's own (R210), except the sole active principal, recorded
   * self_approved (R253). `cover` creates the slice-10 cover row in this transaction (R212, R132).
   */
  @Transactional()
  async approve(session: SchoolSessionContext, id: bigint, dto: ApproveLeaveRequestDto): Promise<LeaveRequestDto> {
    const { schoolId, userId } = this.context.actor();
    // A cover is a teacher assignment: its own key, refused before anything is written.
    if (dto.cover !== undefined && !session.access.capabilities.has(Capability.CLASS_MANAGE)) {
      throw coverNeedsClassManage();
    }
    const row = await this.lock(schoolId, id);
    if (row.status !== 'pending') throw notPending(row.status);
    const own = row.staffId === session.access.staffId;
    const selfApproved = own && (await this.permissions.isSolePrincipal(schoolId, userId));
    if (own && !selfApproved) throw ownLeave(id);

    const type = await this.types.findById(schoolId, row.leaveTypeId);
    const member = await this.staff.findById(schoolId, row.staffId);
    if (!type || !member) throw notFound();
    const { value: cal } = await this.calendar.calendar(schoolId, row.startsOn, row.endsOn);
    await this.assertBalance(schoolId, member, type, row.startsOn, row.endsOn, cal, false);

    let coverAssignmentId: bigint | null = null;
    if (dto.cover !== undefined) {
      coverAssignmentId = await this.createCover(session, schoolId, row, dto.cover);
    }
    const changed = await this.requests.decide(schoolId, id, {
      status: 'approved',
      decidedBy: userId,
      decisionReason: dto.reason ?? null,
      selfApproved,
      coverAssignmentId,
    });
    if (changed === 0) throw notPending(row.status);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'leave_request.approved',
      subjectType: SUBJECT,
      subjectId: id,
      ...(dto.reason === undefined ? {} : { reason: dto.reason }),
      metadata: {
        staffId: row.staffId.toString(),
        workingDays: row.workingDays,
        selfApproved,
        coverAssignmentId: coverAssignmentId?.toString() ?? null,
      },
    });
    if (!own) await this.notifyDecided(schoolId, row, type, 'approved');
    return this.reload(schoolId, id);
  }

  /** staff.leave.approve; never one's own, whoever (R210). */
  @Transactional()
  async reject(session: SchoolSessionContext, id: bigint, dto: ReasonDto): Promise<LeaveRequestDto> {
    const { schoolId, userId } = this.context.actor();
    const row = await this.lock(schoolId, id);
    if (row.status !== 'pending') throw notPending(row.status);
    if (row.staffId === session.access.staffId) throw ownLeave(id);
    const changed = await this.requests.decide(schoolId, id, {
      status: 'rejected',
      decidedBy: userId,
      decisionReason: dto.reason,
      selfApproved: false,
      coverAssignmentId: null,
    });
    if (changed === 0) throw notPending(row.status);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'leave_request.rejected',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: { staffId: row.staffId.toString() },
    });
    const type = await this.types.findById(schoolId, row.leaveTypeId);
    if (type) await this.notifyDecided(schoolId, row, type, 'rejected');
    return this.reload(schoolId, id);
  }

  /**
   * R248: an approved leave ends on `endedOn` (its last day taken), the later dates are freed and
   * the cover ends the same day. The trigger reads the actor from the change context.
   */
  @Transactional()
  async endEarly(session: SchoolSessionContext, id: bigint, dto: EndLeaveEarlyDto): Promise<LeaveRequestDto> {
    const { schoolId, userId } = this.context.actor();
    const row = await this.lock(schoolId, id);
    if (row.status !== 'approved') throw illegalTransition(row.status);
    const endedOn = fromDateString(dto.endedOn);
    if (endedOn < row.startsOn || endedOn >= row.endsOn) {
      throw fieldRefused('endedOn', ErrorCode.INVALID_VALUE, 'endedOn must be on or after startsOn and before endsOn');
    }
    if (row.staffId === session.access.staffId) {
      const sole = row.selfApproved && (await this.permissions.isSolePrincipal(schoolId, userId));
      if (!sole) throw ownLeave(id);
    }
    await this.changeContext.setChangeContext(userId, dto.reason);
    if ((await this.requests.endEarly(schoolId, id, endedOn)) === 0) throw illegalTransition(row.status);
    if (row.coverAssignmentId !== null) await this.endCover(row.coverAssignmentId, endedOn, dto.reason);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'leave_request.ended_early',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: {
        staffId: row.staffId.toString(),
        endedOn: dto.endedOn,
        coverAssignmentId: row.coverAssignmentId?.toString() ?? null,
      },
    });
    return this.reload(schoolId, id);
  }

  // -------------------------------------------------------------------------------- helpers

  private lock(schoolId: SchoolId, id: bigint): Promise<LeaveRequestRecord> {
    return readLocked(
      () => this.requests.findById(schoolId, id),
      (row) => this.requests.lockIfUnchanged(schoolId, row),
    );
  }

  private async reload(schoolId: SchoolId, id: bigint): Promise<LeaveRequestDto> {
    const row = await this.requests.findById(schoolId, id);
    if (!row) throw notFound();
    return this.one(schoolId, row);
  }

  private async page(
    query: ListMyLeaveRequestsQueryDto,
    filter: {
      staffId?: bigint;
      startsFrom?: Date;
      startsTo?: Date;
      sort: '-requestedAt' | 'startsOn';
    },
  ): Promise<Page<LeaveRequestDto>> {
    const schoolId = this.context.schoolId;
    const { rows, total } = await this.requests.list(schoolId, {
      ...filter,
      ...(query.status === undefined ? {} : { status: query.status }),
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(await this.toDtos(schoolId, rows), query, total);
  }

  private async one(schoolId: SchoolId, row: LeaveRequestRecord): Promise<LeaveRequestDto> {
    const [dto] = await this.toDtos(schoolId, [row]);
    if (!dto) throw notFound();
    return dto;
  }

  /** Names and sectionsNeedingCover for a page: a fixed number of statements, run in order. */
  private async toDtos(schoolId: SchoolId, rows: LeaveRequestRecord[]): Promise<LeaveRequestDto[]> {
    if (rows.length === 0) return [];
    const types = new Map((await this.types.findByIds(schoolId, rows.map((r) => r.leaveTypeId))).map((t) => [t.id, t]));
    const staffNames = await this.requests.staffNames(schoolId, rows.map((r) => r.staffId));
    const deciders = await this.requests.userNames(
      schoolId,
      rows.flatMap((r) => (r.decidedBy === null ? [] : [r.decidedBy])),
    );
    const needing = await this.sectionsNeedingCover(schoolId, rows);
    // R248: when a cancel or an end early ended the cover, the day it actually ended (an end
    // early dated in the past ends the cover yesterday, slice 10 refusing a past last day).
    const closed = rows.filter((r) => r.coverAssignmentId !== null && (r.status === 'cancelled' || r.status === 'ended_early'));
    const coverLast = await this.requests.coverLastDays(schoolId, closed.map((r) => r.coverAssignmentId!));
    return rows.map((row) => {
      const type = types.get(row.leaveTypeId);
      if (!type) throw new Error('leave type vanished');
      return {
        id: row.id.toString(),
        staffId: row.staffId.toString(),
        staffName: staffNames.get(row.staffId) ?? '',
        leaveType: { id: type.id.toString(), name: type.name, code: type.code, paid: type.paid },
        startsOn: toDateString(row.startsOn),
        endsOn: toDateString(row.endsOn),
        endedEarlyOn: row.endedEarlyOn === null ? null : toDateString(row.endedEarlyOn),
        workingDays: row.workingDays,
        reason: row.reason,
        status: row.status,
        requestedByUserId: row.requestedBy.toString(),
        requestedAt: row.requestedAt,
        onBehalf: row.onBehalf,
        decidedByUserId: row.decidedBy?.toString() ?? null,
        decidedByName: row.decidedBy === null ? null : (deciders.get(row.decidedBy) ?? null),
        decidedAt: row.decidedAt,
        decisionReason: row.decisionReason,
        selfApproved: row.selfApproved,
        coverAssignmentId: row.coverAssignmentId?.toString() ?? null,
        coverEndedOn: coverEndedOn(row, coverLast),
        sectionsNeedingCover: needing.get(row.id) ?? [],
        cancelledAt: row.cancelledAt,
        cancelReason: row.cancelReason,
      };
    });
  }

  /**
   * R212: per pending or approved request, the sections whose class teacher the staff member is
   * on some day of the leave, less the section its own cover covers.
   */
  private async sectionsNeedingCover(
    schoolId: SchoolId,
    rows: LeaveRequestRecord[],
  ): Promise<Map<bigint, SectionNeedingCoverDto[]>> {
    const open = rows.filter((r) => r.status === 'pending' || r.status === 'approved');
    if (open.length === 0) return new Map();
    const from = open.map((r) => r.startsOn).reduce(minDate);
    const to = open.map(lastTaken).reduce(maxDate);
    const classTeacher = await this.requests.classTeacherRows(schoolId, open.map((r) => r.staffId), from, to);
    const covered = await this.requests.coverSections(
      schoolId,
      open.flatMap((r) => (r.coverAssignmentId === null ? [] : [r.coverAssignmentId])),
    );
    const labels = await this.requests.sectionLabels(schoolId, classTeacher.map((c) => c.sectionId));
    const out = new Map<bigint, SectionNeedingCoverDto[]>();
    for (const row of open) {
      const coveredSection = row.coverAssignmentId === null ? undefined : covered.get(row.coverAssignmentId);
      const seen = new Set<bigint>();
      const list: SectionNeedingCoverDto[] = [];
      for (const ct of classTeacherDuring(classTeacher, row)) {
        if (ct.sectionId === coveredSection || seen.has(ct.sectionId)) continue;
        seen.add(ct.sectionId);
        const label = labels.get(ct.sectionId);
        if (!label) continue;
        list.push({ sectionId: ct.sectionId.toString(), classId: label.classId.toString(), name: label.label });
      }
      out.set(row.id, list);
    }
    return out;
  }

  /** The cover's dates: the leave's days from today on, inside the covered class-teacher row. */
  private async createCover(
    session: SchoolSessionContext,
    schoolId: SchoolId,
    row: LeaveRequestRecord,
    cover: { sectionId: string; coverStaffId: string },
  ): Promise<bigint> {
    const sectionId = BigInt(cover.sectionId);
    const coverStaffId = BigInt(cover.coverStaffId);
    if (coverStaffId === row.staffId) {
      throw fieldRefused('cover.coverStaffId', ErrorCode.INVALID_VALUE, 'The person on leave cannot cover their own class');
    }
    const classTeacher = await this.requests.classTeacherRows(schoolId, [row.staffId], row.startsOn, row.endsOn);
    const covered = classTeacherDuring(classTeacher, row).find((ct) => ct.sectionId === sectionId);
    if (!covered) {
      throw fieldRefused(
        'cover.sectionId',
        ErrorCode.INVALID_VALUE,
        'Not a section this staff member is class teacher of during the leave',
      );
    }
    const today = await this.clock.today(schoolId);
    const startsOn = [row.startsOn, today, covered.startsOn].reduce(maxDate);
    const endsOn = covered.endsOn === null ? row.endsOn : minDate(row.endsOn, covered.endsOn);
    if (endsOn < startsOn) {
      throw fieldRefused('cover', ErrorCode.INVALID_VALUE, 'The leave has no days left to cover');
    }
    const labels = await this.requests.sectionLabels(schoolId, [sectionId]);
    const label = labels.get(sectionId);
    if (!label) throw fieldRefused('cover.sectionId', ErrorCode.REFERENCE_NOT_FOUND, 'No such section');
    const created = await this.teacherAssignments.create(session, coverStaffId, {
      role: 'cover',
      classId: label.classId.toString(),
      sectionId: sectionId.toString(),
      startsOn: toDateString(startsOn),
      endsOn: toDateString(endsOn),
      coversAssignmentId: covered.id.toString(),
    });
    return BigInt(created.id);
  }

  /**
   * Ends a leave's cover (R212, R248): on `lastDay` when that is today or later, otherwise from
   * today (the slice-10 end: yesterday if it had begun, else voided). Nothing when already over.
   */
  private async endCover(coverId: bigint, lastDay: Date | null, reason: string): Promise<void> {
    const schoolId = this.context.schoolId;
    const cover = await this.assignments.findById(schoolId, coverId);
    if (!cover || cover.voidedAt !== null) return;
    const today = await this.clock.today(schoolId);
    if (cover.endsOn !== null && cover.endsOn < today) return;
    if (lastDay !== null && lastDay >= today && lastDay >= cover.startsOn) {
      if (cover.endsOn !== null && cover.endsOn <= lastDay) return;
      await this.teacherAssignments.end(coverId, { endsOn: toDateString(lastDay), reason });
      return;
    }
    await this.teacherAssignments.end(coverId, { reason });
  }

  /**
   * R209 for a paid type with a yearly limit, per calendar year the dates touch: the request's
   * working days in the year must fit the balance (less pending requests when `holdPending`).
   */
  private async assertBalance(
    schoolId: SchoolId,
    member: StaffRecord,
    type: LeaveTypeRecord,
    startsOn: Date,
    endsOn: Date,
    cal: SchoolCalendar,
    holdPending: boolean,
  ): Promise<void> {
    if (!type.paid || type.daysPerYear === null) return;
    for (let y = startsOn.getUTCFullYear(); y <= endsOn.getUTCFullYear(); y++) {
      const days = staffWorkingDays(maxDate(startsOn, yearStart(y)), minDate(endsOn, yearEnd(y)), cal);
      if (days === 0) continue;
      const used = (await this.daysByType(schoolId, member.id, y, TAKEN_LEAVE_STATUSES)).get(type.id) ?? 0;
      const pending = holdPending
        ? ((await this.daysByType(schoolId, member.id, y, ['pending'])).get(type.id) ?? 0)
        : 0;
      const remaining = leaveBalance(type.daysPerYear, joinedOn(member), y, used).remaining ?? 0;
      const available = remaining - pending;
      if (days > available) throw balanceExceeded(available, y);
    }
  }

  /**
   * Working days per leave type of the staff member's requests in `statuses` inside calendar year
   * `year`: the frozen count for a request wholly inside the year and not ended early, else
   * counted over the days inside the year.
   */
  private async daysByType(
    schoolId: SchoolId,
    staffId: bigint,
    year: number,
    statuses: readonly LeaveStatus[],
  ): Promise<Map<bigint, number>> {
    const from = yearStart(year);
    const to = yearEnd(year);
    const rows = await this.requests.forStaffInRange(schoolId, staffId, statuses, from, to);
    const out = new Map<bigint, number>();
    let cal: SchoolCalendar | undefined;
    for (const row of rows) {
      const last = lastTaken(row);
      let days: number;
      if (row.startsOn >= from && last <= to && row.endedEarlyOn === null) {
        days = row.workingDays;
      } else {
        cal ??= (await this.calendar.calendar(schoolId, from, to)).value;
        days = staffWorkingDays(maxDate(row.startsOn, from), minDate(last, to), cal);
      }
      out.set(row.leaveTypeId, (out.get(row.leaveTypeId) ?? 0) + days);
    }
    return out;
  }

  /** Staff ids of the logins holding staff.leave.approve (role, custom role or grant). */
  private async approverStaffIds(schoolId: SchoolId): Promise<bigint[]> {
    const ids: bigint[] = [];
    for (const candidate of await this.users.watcherCandidates(schoolId, Capability.STAFF_LEAVE_APPROVE)) {
      const access = await this.permissions.load(schoolId, candidate.userId);
      if (access?.capacities.staff && this.permissions.holds(access, Capability.STAFF_LEAVE_APPROVE)) {
        ids.push(candidate.staffId);
      }
    }
    return ids;
  }

  private async notifyDecided(
    schoolId: SchoolId,
    row: LeaveRequestRecord,
    type: LeaveTypeRecord,
    decision: 'approved' | 'rejected',
  ): Promise<void> {
    await this.notifications.send(schoolId, {
      type: 'leave_decided',
      subject: { type: SUBJECT, id: row.id },
      recipients: [{ staffId: row.staffId }],
      vars: { typeName: type.name, startsOn: row.startsOn, endsOn: row.endsOn, decision },
    });
  }
}

/** The staff member's class-teacher rows live on some day of the request. */
function classTeacherDuring(rows: ClassTeacherRow[], request: LeaveRequestRecord): ClassTeacherRow[] {
  const last = lastTaken(request);
  return rows.filter(
    (ct) =>
      ct.staffId === request.staffId &&
      ct.startsOn <= last &&
      (ct.endsOn === null || ct.endsOn >= request.startsOn),
  );
}

/** The cover's last day once the leave was cancelled or ended early; null when voided or none. */
function coverEndedOn(row: LeaveRequestRecord, last: Map<bigint, Date | null>): string | null {
  if (row.coverAssignmentId === null) return null;
  const day = last.get(row.coverAssignmentId);
  return day === undefined || day === null ? null : toDateString(day);
}

const joinedOn = (member: StaffRecord): string | null =>
  member.joinedOn === null ? null : toDateString(member.joinedOn);
