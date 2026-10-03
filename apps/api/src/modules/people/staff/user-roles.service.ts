import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import type { SchoolSessionContext } from '../../../common/auth/school-session';
import { ApiException, notFound } from '../../../common/errors/api-exception';
import { summariseDatabaseError } from '../../../common/errors/prisma-errors';
import { toPage, type Page } from '../../../common/pagination';
import { SchoolContext } from '../../../common/school-context';
import { AuditLogRepository } from '../../../repositories/audit-log.repository';
import { SchoolSettingsRepository } from '../../../repositories/school-settings.repository';
import { StaffRepository } from '../../../repositories/staff.repository';
import { UserRoleRepository, type UserRoleRecord } from '../../../repositories/user-role.repository';
import { UserRepository } from '../../../repositories/user.repository';
import type { AssignRoleDto, ListUserRolesQueryDto, RemoveRoleDto, UserRoleDto } from './staff.dto';
import { lastPrincipal, selfForbidden, staffNotActive } from './staff.errors';

// contracts/slice-4.md §5: a login's system roles. Role rows are written only under the target's
// user row lock (and, for principal, the school_settings lock first: R72, R73).

const ROLE_UNIQUE = 'user_roles_school_id_user_id_system_role_key';

const toUserRoleDto = (row: UserRoleRecord): UserRoleDto => ({
  id: row.id.toString(),
  userId: row.userId.toString(),
  systemRole: row.systemRole,
  customRoleId: null,
  assignedBy: row.assignedBy?.toString() ?? null,
  assignedAt: row.assignedAt,
  endedAt: row.endedAt,
  endedBy: row.endedBy?.toString() ?? null,
});

const alreadyAssigned = (row: UserRoleRecord): ApiException =>
  new ApiException(409, ErrorCode.ROLE_ALREADY_ASSIGNED, 'The user already holds that role.', {
    userRoleId: row.id.toString(),
  });

@Injectable()
export class UserRolesService {
  constructor(
    private readonly context: SchoolContext,
    private readonly roles: UserRoleRepository,
    private readonly users: UserRepository,
    private readonly staff: StaffRepository,
    private readonly settings: SchoolSettingsRepository,
    private readonly audit: AuditLogRepository,
  ) {}

  async list(userId: bigint, query: ListUserRolesQueryDto): Promise<Page<UserRoleDto>> {
    const schoolId = this.context.schoolId;
    if (!(await this.users.findCredentials(schoolId, userId))) throw notFound();
    const { rows, total } = await this.roles.listForUser(schoolId, userId, {
      includeEnded: query.includeEnded ?? false,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map(toUserRoleDto), query, total);
  }

  /** A race on the partial unique index answers as the in-transaction check (fresh read). */
  async assign(session: SchoolSessionContext, userId: bigint, dto: AssignRoleDto): Promise<UserRoleDto> {
    try {
      return toUserRoleDto(await this.assignInTransaction(session, userId, dto));
    } catch (error) {
      if (summariseDatabaseError(error)?.constraint !== ROLE_UNIQUE) throw error;
      const live = await this.roles.findLive(session.schoolId, userId, dto.systemRole);
      throw live ? alreadyAssigned(live) : error;
    }
  }

  async remove(session: SchoolSessionContext, id: bigint, dto: RemoveRoleDto): Promise<UserRoleDto> {
    await this.removeInTransaction(session, id, dto);
    const row = await this.roles.findById(session.schoolId, id);
    if (!row) throw notFound();
    return toUserRoleDto(row);
  }

  @Transactional()
  private async assignInTransaction(
    session: SchoolSessionContext,
    userId: bigint,
    dto: AssignRoleDto,
  ): Promise<UserRoleRecord> {
    const { schoolId, access: actor } = session;
    const user = await this.users.lock(schoolId, userId);
    if (!user) throw notFound();
    // R74: nobody changes their own roles.
    if (user.id === actor.userId) throw selfForbidden();
    const staff = user.staffId === null ? null : await this.staff.findById(schoolId, user.staffId);
    if (!staff || staff.status !== 'active') throw staffNotActive();
    const live = await this.roles.findLive(schoolId, userId, dto.systemRole);
    if (live) throw alreadyAssigned(live);
    const row = await this.roles.assign(schoolId, {
      userId,
      systemRole: dto.systemRole,
      assignedBy: actor.userId,
      now: new Date(),
    });
    await this.audit.record(schoolId, {
      actorUserId: actor.userId,
      action: 'user_role.assigned',
      subjectType: 'user',
      subjectId: userId,
      reason: dto.reason,
      metadata: { systemRole: dto.systemRole, userRoleId: row.id.toString() },
    });
    return row;
  }

  /**
   * Ends the row. Takes effect on the target's next request (R69); a target left with no
   * capacity is refused by session resolution (R71), so sessions are not revoked here.
   */
  @Transactional()
  private async removeInTransaction(
    session: SchoolSessionContext,
    id: bigint,
    dto: RemoveRoleDto,
  ): Promise<void> {
    const { schoolId, access: actor } = session;
    const found = await this.roles.findById(schoolId, id);
    if (!found) throw notFound();
    if (found.systemRole === 'principal') await this.settings.lock(schoolId);
    await this.users.lock(schoolId, found.userId);
    // Read again under the user lock: role rows are written only under it.
    const row = await this.roles.findById(schoolId, id);
    if (!row) throw notFound();
    if (row.userId === actor.userId) throw selfForbidden();
    if (row.endedAt !== null) return;
    if (row.systemRole === 'principal' && (await this.roles.isLastActivePrincipal(schoolId, row.userId))) {
      throw lastPrincipal();
    }
    await this.roles.end(schoolId, id, actor.userId, new Date());
    await this.audit.record(schoolId, {
      actorUserId: actor.userId,
      action: 'user_role.removed',
      subjectType: 'user',
      subjectId: row.userId,
      reason: dto.reason,
      metadata: { systemRole: row.systemRole, userRoleId: id.toString() },
    });
  }
}
