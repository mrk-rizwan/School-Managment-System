import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { Capability, ErrorCode } from '@asms/shared';
import type { SchoolSessionContext } from '../../../common/auth/school-session';
import { ApiException, notFound } from '../../../common/errors/api-exception';
import { AuditLogRepository } from '../../../repositories/audit-log.repository';
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
    await this.apply(session, id, dto);
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
    let user = before.userId === null ? null : await this.users.lock(schoolId, before.userId);
    const staff = await this.staffService.lock(schoolId, id);
    // A login issued between the read and the staff lock (issue-login holds the staff lock while
    // it creates one, so it has committed by now): lock it too.
    if (staff.userId !== null && staff.userId !== user?.id) {
      user = await this.users.lock(schoolId, staff.userId);
    }

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
    if (to === 'left') {
      // R17. Grants ended with reason "staff left" arrive with slice 7 (GrantsRepository.endAllForUser).
      if (user) rolesEnded = await this.roles.endAllForUser(schoolId, user.id, actor.userId, now);
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
      metadata: { from, to, rolesEnded, assignmentsEnded, sessionsRevoked },
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
