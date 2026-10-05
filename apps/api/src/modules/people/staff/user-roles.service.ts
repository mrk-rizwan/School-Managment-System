import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import type { SchoolSessionContext } from '../../../common/auth/school-session';
import { ApiException, fieldRefused, notFound } from '../../../common/errors/api-exception';
import { summariseDatabaseError } from '../../../common/errors/prisma-errors';
import { toPage, type Page } from '../../../common/pagination';
import { SchoolContext } from '../../../common/school-context';
import { AuditLogRepository } from '../../../repositories/audit-log.repository';
import { CapabilityGrantRepository } from '../../../repositories/capability-grant.repository';
import { CustomRoleRepository } from '../../../repositories/custom-role.repository';
import { SchoolSettingsRepository } from '../../../repositories/school-settings.repository';
import { StaffRepository } from '../../../repositories/staff.repository';
import {
  UserRoleRepository,
  type RoleChoice,
  type UserRoleRecord,
} from '../../../repositories/user-role.repository';
import { UserRepository } from '../../../repositories/user.repository';
import { customRoleArchived } from '../../access/access.errors';
import type { AssignRoleDto, ListUserRolesQueryDto, RemoveRoleDto, UserRoleDto } from './staff.dto';
import { lastPrincipal, selfForbidden, staffNotActive } from './staff.errors';

// contracts/slice-4.md §5, slice-7.md §3.6: a login's roles. Role rows are written only under the
// target's user row lock (and, for principal, the school_settings lock first: R72, R73).

const ROLE_UNIQUE = 'user_roles_school_id_user_id_system_role_key';
const CUSTOM_ROLE_UNIQUE = 'user_roles_school_id_user_id_custom_role_key';

const toUserRoleDto = (row: UserRoleRecord): UserRoleDto => ({
  id: row.id.toString(),
  userId: row.userId.toString(),
  systemRole: row.systemRole,
  customRoleId: row.customRoleId?.toString() ?? null,
  customRoleName: row.customRoleName,
  assignedBy: row.assignedBy?.toString() ?? null,
  assignedAt: row.assignedAt,
  endedAt: row.endedAt,
  endedBy: row.endedBy?.toString() ?? null,
});

/** Exactly one of systemRole / customRoleId (contracts/slice-7.md §3.6). */
function roleOf(dto: AssignRoleDto): RoleChoice {
  if (dto.systemRole !== undefined && dto.customRoleId === undefined) {
    return { kind: 'system', systemRole: dto.systemRole };
  }
  if (dto.customRoleId !== undefined && dto.systemRole === undefined) {
    return { kind: 'custom', customRoleId: BigInt(dto.customRoleId) };
  }
  const path = dto.systemRole === undefined ? 'systemRole' : 'customRoleId';
  throw fieldRefused(path, ErrorCode.INVALID_VALUE, 'Give exactly one of systemRole and customRoleId.');
}

const alreadyAssigned = (row: UserRoleRecord): ApiException =>
  new ApiException(409, ErrorCode.ROLE_ALREADY_ASSIGNED, 'The user already holds that role.', {
    userRoleId: row.id.toString(),
  });

@Injectable()
export class UserRolesService {
  constructor(
    private readonly context: SchoolContext,
    private readonly roles: UserRoleRepository,
    private readonly customRoles: CustomRoleRepository,
    private readonly grants: CapabilityGrantRepository,
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
    const role = roleOf(dto);
    try {
      return toUserRoleDto(await this.assignInTransaction(session, userId, role, dto.reason));
    } catch (error) {
      const constraint = summariseDatabaseError(error)?.constraint;
      if (constraint !== ROLE_UNIQUE && constraint !== CUSTOM_ROLE_UNIQUE) throw error;
      const live = await this.roles.findLive(session.schoolId, userId, role);
      throw live ? alreadyAssigned(live) : error;
    }
  }

  async remove(session: SchoolSessionContext, id: bigint, dto: RemoveRoleDto): Promise<UserRoleDto> {
    await this.removeInTransaction(session, id, dto);
    const row = await this.roles.findById(session.schoolId, id);
    if (!row) throw notFound();
    return toUserRoleDto(row);
  }

  /**
   * A custom role is locked after the user (contracts/slice-7.md §3.6): the role lock serialises
   * against archive, so an archived role never gains a holder (R96). A user becoming principal
   * has every live grant and revoke row ended (principals are unrestricted peers, §4.4).
   */
  @Transactional()
  private async assignInTransaction(
    session: SchoolSessionContext,
    userId: bigint,
    role: RoleChoice,
    reason: string,
  ): Promise<UserRoleRecord> {
    const { schoolId, access: actor } = session;
    // A new principal changes the principal count: take the school_settings lock first, as the
    // remove path does and as isSolePrincipal reads under (phase-3-financial.md §3.1, R253), so
    // a decision taken as the sole principal cannot interleave with a second one appearing.
    if (role.kind === 'system' && role.systemRole === 'principal') await this.settings.lock(schoolId);
    const user = await this.users.lock(schoolId, userId);
    if (!user) throw notFound();
    // R74: nobody changes their own roles.
    if (user.id === actor.userId) throw selfForbidden();
    const staff = user.staffId === null ? null : await this.staff.findById(schoolId, user.staffId);
    if (!staff || staff.status !== 'active') throw staffNotActive();
    if (role.kind === 'custom') {
      const custom = await this.customRoles.lock(schoolId, role.customRoleId);
      if (!custom) {
        throw fieldRefused('customRoleId', ErrorCode.REFERENCE_NOT_FOUND, 'No such custom role.');
      }
      if (custom.status !== 'active') throw customRoleArchived();
    }
    const live = await this.roles.findLive(schoolId, userId, role);
    if (live) throw alreadyAssigned(live);
    const now = new Date();
    const row = await this.roles.assign(schoolId, { userId, role, assignedBy: actor.userId, now });
    const grantsEnded =
      role.kind === 'system' && role.systemRole === 'principal'
        ? await this.grants.endAllForNewPrincipal(schoolId, userId, { revokedBy: actor.userId, now })
        : 0;
    await this.audit.record(schoolId, {
      actorUserId: actor.userId,
      action: 'user_role.assigned',
      subjectType: 'user',
      subjectId: userId,
      reason,
      metadata: {
        ...(role.kind === 'system'
          ? { systemRole: role.systemRole }
          : { customRoleId: role.customRoleId.toString() }),
        userRoleId: row.id.toString(),
        ...(grantsEnded > 0 ? { grantsEnded } : {}),
      },
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
      metadata: {
        ...(row.customRoleId === null
          ? { systemRole: row.systemRole }
          : { customRoleId: row.customRoleId.toString() }),
        userRoleId: id.toString(),
      },
    });
  }
}
