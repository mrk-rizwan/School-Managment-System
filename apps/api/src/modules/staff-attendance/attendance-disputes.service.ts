import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { Capability, ErrorCode, type DisputeStatus } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { readLocked } from '../../common/locking';
import type { ReasonDto } from '../../common/reason.dto';
import { toPage, type Page } from '../../common/pagination';
import { SchoolContext, type Actor } from '../../common/school-context';
import { NotificationService } from '../../messaging/notification.service';
import {
  AttendanceDisputeRepository,
  type DisputeRecord,
} from '../../repositories/attendance-dispute.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { StaffAttendanceRepository } from '../../repositories/staff-attendance.repository';
import { UserRepository } from '../../repositories/user.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { toDateString } from '../academics/academics.shared';
import { PermissionsService } from '../access/permissions.service';
import type {
  ApproveDisputeDto,
  AttendanceDisputeDto,
  ListDisputesQueryDto,
  ListMyDisputesQueryDto,
  RaiseDisputeDto,
} from './attendance-disputes.dto';
import { ownAttendance } from './biometric.service';
import { StaffAttendanceService } from './staff-attendance.service';

// contracts/slice-44.md §2.5, §2.6 (R346, R347): the leave-request shape. Lock order: the dispute
// row (readLocked), then the mark (StaffAttendanceService.amend). Rows are never deleted.

const ENDPOINT = 'attendance_disputes';
const SUBJECT = 'attendance_dispute';

export interface DisputeCreateOutcome {
  replayed: boolean;
  dispute: AttendanceDisputeDto;
}

const notPending = (id: bigint, status: DisputeStatus): ApiException =>
  new ApiException(409, ErrorCode.ATTENDANCE_DISPUTE_NOT_PENDING, 'This dispute is no longer pending.', {
    disputeId: id.toString(),
    status,
  });

const pendingExists = (disputeId: bigint): ApiException =>
  new ApiException(409, ErrorCode.ATTENDANCE_DISPUTE_PENDING_EXISTS, 'This mark already has a pending dispute.', {
    disputeId: disputeId.toString(),
  });

export const toDisputeDto = (row: DisputeRecord): AttendanceDisputeDto => ({
  id: row.id.toString(),
  attendanceId: row.attendanceId.toString(),
  staffId: row.staffId.toString(),
  staffName: row.staffName,
  date: toDateString(row.date),
  markStatus: row.markStatus,
  markSource: row.markSource,
  requestedStatus: row.requestedStatus,
  reason: row.reason,
  status: row.status,
  createdAt: row.createdAt,
  decidedByName: row.decidedByName,
  decidedAt: row.decidedAt,
  decisionReason: row.decisionReason,
  withdrawnAt: row.withdrawnAt,
});

@Injectable()
export class AttendanceDisputesService {
  constructor(
    private readonly context: SchoolContext,
    private readonly disputes: AttendanceDisputeRepository,
    private readonly marks: StaffAttendanceRepository,
    private readonly attendance: StaffAttendanceService,
    private readonly users: UserRepository,
    private readonly permissions: PermissionsService,
    private readonly audit: AuditLogRepository,
    private readonly notifications: NotificationService,
    private readonly idempotency: IdempotentRequests,
  ) {}

  /** The caller's own staff id (@RequireStaff admits only an active staff capacity). */
  ownStaffId(session: SchoolSessionContext): bigint {
    const staffId = session.access.staffId;
    if (staffId === null) throw notFound();
    return staffId;
  }

  // ---------------------------------------------------------------------------------- reads

  /** GET /staff-attendance-disputes (and the Approvals section): newest first. */
  async list(query: ListDisputesQueryDto): Promise<Page<AttendanceDisputeDto>> {
    return this.page(query, query.staffId === undefined ? undefined : BigInt(query.staffId));
  }

  /** GET /me/staff/attendance-disputes: the caller's own. */
  async listMine(session: SchoolSessionContext, query: ListMyDisputesQueryDto): Promise<Page<AttendanceDisputeDto>> {
    return this.page(query, this.ownStaffId(session));
  }

  private async page(query: ListMyDisputesQueryDto, staffId: bigint | undefined): Promise<Page<AttendanceDisputeDto>> {
    const { rows, total } = await this.disputes.list(this.context.schoolId, {
      ...(staffId === undefined ? {} : { staffId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map(toDisputeDto), query, total);
  }

  // ---------------------------------------------------------------------------- the staff member

  /** §2.5. Keyed (endpoint attendance_disputes, path id the mark). */
  async raise(session: SchoolSessionContext, dto: RaiseDisputeDto, rawKey: string | undefined): Promise<DisputeCreateOutcome> {
    const actor = this.context.actor();
    const staffId = this.ownStaffId(session);
    const attendanceId = BigInt(dto.attendanceId);
    const outcome = await this.idempotency.withIdempotencyKey(actor, ENDPOINT, attendanceId, dto, rawKey, (claim) =>
      this.raiseInTransaction(actor, staffId, attendanceId, dto, claim),
    );
    const row = outcome.replayed ? await this.disputes.findById(actor.schoolId, outcome.subjectId) : outcome.value;
    if (!row) throw notFound();
    return { replayed: outcome.replayed, dispute: toDisputeDto(row) };
  }

  @Transactional()
  private async raiseInTransaction(
    actor: Actor,
    staffId: bigint,
    attendanceId: bigint,
    dto: RaiseDisputeDto,
    claim: IdempotencyClaim,
  ): Promise<DisputeRecord> {
    const { schoolId, userId } = actor;
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, SUBJECT);
    const mark = await this.marks.findById(schoolId, attendanceId);
    // Another member's mark is as absent as another school's.
    if (!mark || mark.staffId !== staffId) {
      throw fieldRefused('attendanceId', ErrorCode.REFERENCE_NOT_FOUND, 'No such mark of yours');
    }
    const pending = await this.disputes.pendingFor(schoolId, attendanceId);
    if (pending !== null) throw pendingExists(pending);
    if (dto.requestedStatus === mark.status) {
      throw fieldRefused('requestedStatus', ErrorCode.INVALID_VALUE, 'The mark already says this');
    }
    const created = await this.disputes.create(schoolId, {
      attendanceId,
      staffId,
      raisedBy: userId,
      requestedStatus: dto.requestedStatus,
      reason: dto.reason,
    });
    await recordSubject(created.id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'attendance_dispute.raised',
      subjectType: SUBJECT,
      subjectId: created.id,
      reason: dto.reason,
      metadata: {
        attendanceId: attendanceId.toString(),
        date: toDateString(mark.date),
        from: mark.status,
        to: dto.requestedStatus,
      },
    });
    const recipients = (await this.deciderStaffIds(schoolId)).filter((id) => id !== staffId);
    if (recipients.length > 0) {
      await this.notifications.send(schoolId, {
        type: 'attendance_disputed',
        subject: { type: SUBJECT, id: created.id },
        recipients: recipients.map((id) => ({ staffId: id })),
        vars: { staffName: created.staffName, date: mark.date },
      });
    }
    return created;
  }

  /** §2.5: own and pending. */
  @Transactional()
  async withdraw(session: SchoolSessionContext, id: bigint): Promise<AttendanceDisputeDto> {
    const { schoolId, userId } = this.context.actor();
    const staffId = this.ownStaffId(session);
    const row = await this.lock(schoolId, id);
    if (row.staffId !== staffId) throw notFound();
    if (row.status !== 'pending' || (await this.disputes.withdraw(schoolId, id, userId)) === 0) {
      throw notPending(id, row.status);
    }
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'attendance_dispute.withdrawn',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { attendanceId: row.attendanceId.toString() },
    });
    return this.reload(schoolId, id);
  }

  // ------------------------------------------------------------------------------ the decider

  /**
   * §2.6: amends the mark through the Phase 2 path with the current status as fromStatus (so it
   * cannot go stale) and the dispute's reason as the change reason; a mark that already holds the
   * requested status is a no-op approval.
   */
  @Transactional()
  async approve(session: SchoolSessionContext, id: bigint, dto: ApproveDisputeDto): Promise<AttendanceDisputeDto> {
    const { schoolId, userId } = this.context.actor();
    const row = await this.decidable(session, schoolId, id);
    const mark = await this.marks.lock(schoolId, row.attendanceId);
    if (!mark) throw notFound();
    const amended = mark.status !== row.requestedStatus;
    if (amended) {
      await this.attendance.amend(
        session,
        row.attendanceId,
        { fromStatus: mark.status, status: row.requestedStatus, reason: row.reason },
        row.id,
      );
    }
    if ((await this.disputes.decide(schoolId, id, { status: 'approved', decidedBy: userId, decisionReason: dto.reason ?? null })) === 0) {
      throw notPending(id, row.status);
    }
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'attendance_dispute.approved',
      subjectType: SUBJECT,
      subjectId: id,
      ...(dto.reason === undefined ? {} : { reason: dto.reason }),
      metadata: { staffId: row.staffId.toString(), amended, from: mark.status, to: row.requestedStatus },
    });
    await this.notifyDecided(schoolId, row, 'approved');
    return this.reload(schoolId, id);
  }

  @Transactional()
  async reject(session: SchoolSessionContext, id: bigint, dto: ReasonDto): Promise<AttendanceDisputeDto> {
    const { schoolId, userId } = this.context.actor();
    const row = await this.decidable(session, schoolId, id);
    if ((await this.disputes.decide(schoolId, id, { status: 'rejected', decidedBy: userId, decisionReason: dto.reason })) === 0) {
      throw notPending(id, row.status);
    }
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'attendance_dispute.rejected',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: { staffId: row.staffId.toString() },
    });
    await this.notifyDecided(schoolId, row, 'rejected');
    return this.reload(schoolId, id);
  }

  // -------------------------------------------------------------------------------- helpers

  /** Locked, pending, and not the decider's own (no sole-principal exception, R346). */
  private async decidable(session: SchoolSessionContext, schoolId: SchoolId, id: bigint): Promise<DisputeRecord> {
    const row = await this.lock(schoolId, id);
    if (row.status !== 'pending') throw notPending(id, row.status);
    if (row.staffId === session.access.staffId) throw ownAttendance();
    return row;
  }

  private lock(schoolId: SchoolId, id: bigint): Promise<DisputeRecord> {
    return readLocked(
      () => this.disputes.findById(schoolId, id),
      (row) => this.disputes.lockIfUnchanged(schoolId, row),
    );
  }

  private async reload(schoolId: SchoolId, id: bigint): Promise<AttendanceDisputeDto> {
    const row = await this.disputes.findById(schoolId, id);
    if (!row) throw notFound();
    return toDisputeDto(row);
  }

  /** Active staff logins holding attendance.staff.manage now (effective holdings). */
  private async deciderStaffIds(schoolId: SchoolId): Promise<bigint[]> {
    const ids: bigint[] = [];
    for (const candidate of await this.users.watcherCandidates(schoolId, Capability.ATTENDANCE_STAFF_MANAGE)) {
      const access = await this.permissions.load(schoolId, candidate.userId);
      if (access?.capacities.staff && this.permissions.holds(access, Capability.ATTENDANCE_STAFF_MANAGE)) {
        ids.push(candidate.staffId);
      }
    }
    return ids;
  }

  private async notifyDecided(schoolId: SchoolId, row: DisputeRecord, decision: 'approved' | 'rejected'): Promise<void> {
    await this.notifications.send(schoolId, {
      type: 'attendance_dispute_decided',
      subject: { type: SUBJECT, id: row.id },
      recipients: [{ staffId: row.staffId }],
      vars: { date: row.date, decision },
    });
  }
}
