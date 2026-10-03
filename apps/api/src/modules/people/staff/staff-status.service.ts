import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { Capability, ErrorCode } from '@asms/shared';
import type { SchoolSessionContext } from '../../../common/auth/school-session';
import { ApiException, concurrentUpdate, notFound } from '../../../common/errors/api-exception';
import { AuditLogRepository } from '../../../repositories/audit-log.repository';
import { CapabilityGrantRepository } from '../../../repositories/capability-grant.repository';
import { SchoolSettingsRepository } from '../../../repositories/school-settings.repository';
import { SessionRepository } from '../../../repositories/session.repository';
import { StaffRepository } from '../../../repositories/staff.repository';
import { UserRoleRepository } from '../../../repositories/user-role.repository';
import { UserRepository, type UserCredentialRow } from '../../../repositories/user.repository';
import type { SchoolId } from '../../../tenancy/school-id';
import { PermissionsService } from '../../access/permissions.service';
import { SchoolClock } from '../../../common/school-clock';
import type { ChangeStaffStatusDto, StaffDto } from './staff.dto';
import { denied, lastPrincipal, selfForbidden } from './staff.errors';
import { StaffService } from './staff.service';
import { TeacherAssignmentsService } from './teacher-assignments.service';

/** end_reason of the grant rows R17 ends. */
export const STAFF_LEFT = 'staff left';

/** Attempts when a login is issued to the staff member between the read and the staff lock. */
const ATTEMPTS = 3;

/** Thrown inside the transaction to roll it back (releasing its locks) and start again. */
class LoginChangedDuringLock extends Error {}

/**
 * POST /staff/:id/change-status (contracts/slice-4.md §3.5; R12, R14, R17-R19, R70, R72-R74).
 * Lock order: school_settings (when leaving) -> the target's user row -> staff row -> assignments.
 */

@Injectable()
export class StaffStatusService {
  constructor(
    private readonly staffService: StaffService,
    private readonly staff: StaffRepository,
    private readonly users: UserRepository,
    private readonly roles: UserRoleRepository,
    private readonly grants: CapabilityGrantRepository,
    private readonly sessions: SessionRepository,
    private readonly settings: SchoolSettingsRepository,
    private readonly assignments: TeacherAssignmentsService,
    private readonly audit: AuditLogRepository,
    private readonly permissions: PermissionsService,
    private readonly clock: SchoolClock,
  ) {}

  async changeStatus(
    session: SchoolSessionContext,
    id: bigint,
    dto: ChangeStaffStatusDto,
  ): Promise<StaffDto> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.apply(session, id, dto);
        break;
      } catch (error) {
        if (!(error instanceof LoginChangedDuringLock)) throw error;
        if (attempt >= ATTEMPTS) throw concurrentUpdate();
      }
    }
    return this.staffService.read(session.schoolId, id);
  }

  @Transactional()
  private async apply(
    session: SchoolSessionContext,
    id: bigint,
    dto: ChangeStaffStatusDto,
  ): Promise<void> {
    const { schoolId, access: actor } = session;
    const leaving = dto.status !== 'active';
    // R72 / R73: the settings row serialises every path that could remove the last principal.
    if (leaving) await this.settings.lock(schoolId);
    const before = await this.staff.findById(schoolId, id);
    if (!before) throw notFound();
    const user = before.userId === null ? null : await this.users.lock(schoolId, before.userId);
    const staff = await this.staffService.lock(schoolId, id);
    // A login issued between the read and the staff lock (issue-login holds the staff lock while
    // it creates one, so it has committed by now). Locking it now would take a user row after a
    // staff row, against the lock order: roll back and start again with the login in the read.
    if (staff.userId !== null && staff.userId !== user?.id) throw new LoginChangedDuringLock();

    // R74: nobody changes their own staff status.
    if (actor.staffId === id) throw selfForbidden();
    if (user) await this.assertMayChange(schoolId, session, user);

    const from = staff.status;
    const to = dto.status;
    if (from === to) return;
    if (from === 'left' && to === 'suspended') {
      throw new ApiException(
        409,
        ErrorCode.ILLEGAL_STATUS_TRANSITION,
        'A staff member who has left can only be re-hired.',
        { from, to },
      );
    }
    if (leaving && user && (await this.roles.isLastActivePrincipal(schoolId, user.id))) throw lastPrincipal();

    const now = new Date();
    const today = await this.clock.today(schoolId);
    let rolesEnded = 0;
    let assignmentsEnded = 0;
    let sessionsRevoked = 0;
    let grantsEnded = 0;
    if (to === 'left') {
      // R17: roles, grants and revokes end (contracts/slice-7.md §4.3); re-hire restores none (R19).
      if (user) {
        rolesEnded = await this.roles.endAllForUser(schoolId, user.id, actor.userId, now);
        grantsEnded = await this.grants.endAllForUser(schoolId, user.id, {
          revokedBy: actor.userId,
          endReason: STAFF_LEFT,
          now,
        });
      }
      assignmentsEnded = await this.assignments.endAllForStaff(
        schoolId,
        id,
        actor.userId,
        now,
        today,
      );
    }
    // R70: the staff capacity ends, so every session goes, cookie and bearer, even when a
    // guardian capacity remains. users.status is never written here (R71).
    if (leaving && user) sessionsRevoked = await this.sessions.revokeAllForUser(schoolId, user.id, now);
    // left_on is the last day: today, or the joining day if that is still ahead.
    const leftOn =
      to === 'left' ? (staff.joinedOn !== null && staff.joinedOn > today ? staff.joinedOn : today) : null;
    await this.staff.setStatus(schoolId, id, to, leftOn);
    await this.audit.record(schoolId, {
      actorUserId: actor.userId,
      action: 'staff.status_changed',
      subjectType: 'staff',
      subjectId: id,
      reason: dto.reason,
      metadata: { from, to, rolesEnded, assignmentsEnded, sessionsRevoked, grantsEnded },
    });
  }

  /** R12, R14 against the target's login (contract §3.5). */
  private async assertMayChange(
    schoolId: SchoolId,
    session: SchoolSessionContext,
    user: UserCredentialRow,
  ): Promise<void> {
    const actor = session.access;
    if (this.permissions.holds(actor, Capability.ROLE_MANAGE)) return;
    if (await this.roles.hasLivePrincipalRole(schoolId, user.id)) throw denied('target_is_principal');
    const target = await this.permissions.load(schoolId, user.id);
    if (target && !this.permissions.isSubset(target, actor)) throw denied('target_exceeds_actor');
  }

}
