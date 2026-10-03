import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { SYSTEM_ROLE_DEFAULTS, capabilityGroupOf, type Capability } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { notFound } from '../../common/errors/api-exception';
import { summariseDatabaseError } from '../../common/errors/prisma-errors';
import { SchoolContext } from '../../common/school-context';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import {
  CapabilityGrantRepository,
  type GrantRecord,
} from '../../repositories/capability-grant.repository';
import { StaffRepository } from '../../repositories/staff.repository';
import { UserRoleRepository } from '../../repositories/user-role.repository';
import { UserRepository } from '../../repositories/user.repository';
import { selfForbidden, staffNotActive } from '../people/staff/staff.errors';
import { capabilityNotHeld, grantExists, targetIsPrincipal } from './access.errors';
import {
  capabilityOrder,
  delegableCapabilities,
  delegableCapability,
  type CapabilitySource,
} from './effective-permissions';
import { PermissionsService } from './permissions.service';
import type {
  CapabilitySourceDto,
  CreateGrantDto,
  GrantDto,
  PermissionRoleDto,
  ReasonDto,
  UserPermissionsDto,
  UserPermissionsQueryDto,
} from './roles.dto';

// contracts/slice-7.md §4, §5. Grant and revoke rows of a user are written only under that user's
// row lock, so racing grants and ends on one user serialise.

const LIVE_UNIQUE = 'user_capability_grants_live_key';

/**
 * A row as a GrantDto, or none when its stored key is not a delegable registry key: such a key
 * cannot arrive through the API (DTO and CHECKs) and is ignored on read like everywhere else.
 */
const toGrantDtos = (row: GrantRecord): GrantDto[] => {
  const capability = delegableCapability(row.capabilityKey);
  return capability ? [toGrantDto(row, capability)] : [];
};

const toGrantDto = (row: GrantRecord, capability: Capability): GrantDto => ({
  id: row.id.toString(),
  userId: row.userId.toString(),
  capability,
  effect: row.effect,
  reason: row.reason,
  grantedBy: row.grantedBy.toString(),
  grantedByName: row.grantedByName,
  grantedAt: row.createdAt,
  revokedAt: row.revokedAt,
  revokedBy: row.revokedBy?.toString() ?? null,
  revokedByName: row.revokedByName,
  endReason: row.endReason,
});

const toSourceDto = (source: CapabilitySource): CapabilitySourceDto => ({
  kind: source.kind,
  systemRole: source.kind === 'system_role' ? source.systemRole : null,
  customRoleId: source.kind === 'custom_role' ? source.customRoleId.toString() : null,
  customRoleName: source.kind === 'custom_role' ? source.name : null,
  grantId: source.kind === 'grant' ? source.grantId.toString() : null,
});

@Injectable()
export class GrantsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly permissions: PermissionsService,
    private readonly grants: CapabilityGrantRepository,
    private readonly users: UserRepository,
    private readonly userRoles: UserRoleRepository,
    private readonly staff: StaffRepository,
    private readonly audit: AuditLogRepository,
  ) {}

  /** A race on the live-row index answers as the in-transaction check (fresh read). */
  async create(session: SchoolSessionContext, userId: bigint, dto: CreateGrantDto): Promise<GrantDto> {
    let id: bigint;
    try {
      id = await this.createInTransaction(session, userId, dto);
    } catch (error) {
      if (summariseDatabaseError(error)?.constraint !== LIVE_UNIQUE) throw error;
      const live = await this.grants.findLive(session.schoolId, userId, dto.capability, dto.effect);
      throw live ? grantExists(live.id) : error;
    }
    return this.get(id);
  }

  async end(session: SchoolSessionContext, id: bigint, dto: ReasonDto): Promise<GrantDto> {
    await this.endInTransaction(session, id, dto);
    return this.get(id);
  }

  /** GET /users/:id/permissions: the three columns of the permissions screen (R58). */
  async view(userId: bigint, query: UserPermissionsQueryDto): Promise<UserPermissionsDto> {
    const schoolId = this.context.schoolId;
    const access = await this.permissions.load(schoolId, userId);
    if (!access) throw notFound();
    const staff = access.staffId === null ? null : await this.staff.findById(schoolId, access.staffId);
    const deltas = await this.grants.listForUser(schoolId, userId, query.includeEnded ?? false);
    // The live role rows as load() read them, in assignment order (no second user_roles read).
    const roles: PermissionRoleDto[] =
      access.staffId === null
        ? []
        : [
            ...access.systemRoleRows.map((row) => ({
              id: row.userRoleId,
              dto: {
                userRoleId: row.userRoleId.toString(),
                systemRole: row.systemRole,
                customRoleId: null,
                customRoleName: null,
                customRoleStatus: null,
                capabilities: [...SYSTEM_ROLE_DEFAULTS[row.systemRole]].sort(capabilityOrder),
              },
            })),
            ...access.customRoles.map((role) => ({
              id: role.userRoleId,
              dto: {
                userRoleId: role.userRoleId.toString(),
                systemRole: null,
                customRoleId: role.customRoleId.toString(),
                customRoleName: role.name,
                customRoleStatus: role.status,
                capabilities: delegableCapabilities(role.capabilityKeys),
              },
            })),
          ]
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .map((row) => row.dto);
    return {
      userId: userId.toString(),
      staffId: access.staffId?.toString() ?? null,
      staffStatus: staff?.status ?? null,
      staffCapacity: access.capacities.staff,
      roles,
      deltas: deltas.flatMap(toGrantDtos),
      // Exactly effectivePermissions() for the target, as its own GET /me sees it (R58).
      effective: access.lines.map((line) => ({
        capability: line.capability,
        group: capabilityGroupOf(line.capability),
        scope: line.scope,
        sources: line.sources.map(toSourceDto),
      })),
    };
  }

  private async get(id: bigint): Promise<GrantDto> {
    const row = await this.grants.findById(this.context.schoolId, id);
    const [dto] = row ? toGrantDtos(row) : [];
    if (!dto) throw notFound();
    return dto;
  }

  /** contracts/slice-7.md §4.1, in the contract's refusal order. */
  @Transactional()
  private async createInTransaction(
    session: SchoolSessionContext,
    userId: bigint,
    dto: CreateGrantDto,
  ): Promise<bigint> {
    const { schoolId, access: actor } = session;
    const user = await this.users.lock(schoolId, userId);
    if (!user) throw notFound();
    // R47: nobody grants or revokes on themselves.
    if (user.id === actor.userId) throw selfForbidden();
    // Principals are unrestricted peers: no grant or revoke row is made for one (§4.1).
    if (await this.userRoles.hasLivePrincipalRole(schoolId, userId)) throw targetIsPrincipal();
    // R46: nobody grants or revokes what they do not hold. R48 holds by the route (role.manage).
    if (!actor.capabilities.has(dto.capability)) throw capabilityNotHeld([dto.capability]);
    // R49: only to a user whose staff record is active and who holds a staff role. Read under
    // the user lock: role rows are written only under it.
    const target = await this.permissions.load(schoolId, userId);
    if (!target || target.staffId === null) throw staffNotActive('staff_not_active');
    const staff = await this.staff.findById(schoolId, target.staffId);
    if (staff?.status !== 'active') throw staffNotActive('staff_not_active');
    if (!target.capacities.staff) throw staffNotActive('no_staff_role');
    const live = await this.grants.findLive(schoolId, userId, dto.capability, dto.effect);
    if (live) throw grantExists(live.id);
    const id = await this.grants.create(schoolId, {
      userId,
      capabilityKey: dto.capability,
      effect: dto.effect,
      grantedBy: actor.userId,
      reason: dto.reason,
      now: new Date(),
    });
    await this.audit.record(schoolId, {
      actorUserId: actor.userId,
      action: 'capability_grant.created',
      subjectType: 'user',
      subjectId: userId,
      reason: dto.reason,
      metadata: { grantId: id.toString(), capability: dto.capability, effect: dto.effect },
    });
    return id;
  }

  /**
   * contracts/slice-7.md §4.2. Ending a revoke restores a key, so R46 applies to ending as well.
   * Ending twice is a no-op (R50). A grantor's later loss of the key is never re-checked (R51).
   */
  @Transactional()
  private async endInTransaction(
    session: SchoolSessionContext,
    id: bigint,
    dto: ReasonDto,
  ): Promise<void> {
    const { schoolId, access: actor } = session;
    const found = await this.grants.findById(schoolId, id);
    // A stored key outside the delegable registry is 404 by id, as on read (§2).
    if (!found || !delegableCapability(found.capabilityKey)) throw notFound();
    await this.users.lock(schoolId, found.userId);
    // Read again under the user lock: grant rows are written only under it.
    const row = await this.grants.findById(schoolId, id);
    const capability = row ? delegableCapability(row.capabilityKey) : undefined;
    if (!row || !capability) throw notFound();
    if (row.userId === actor.userId) throw selfForbidden();
    if (!actor.capabilities.has(capability)) throw capabilityNotHeld([capability]);
    if (row.revokedAt !== null) return;
    await this.grants.end(schoolId, id, { revokedBy: actor.userId, endReason: dto.reason, now: new Date() });
    await this.audit.record(schoolId, {
      actorUserId: actor.userId,
      action: 'capability_grant.ended',
      subjectType: 'user',
      subjectId: row.userId,
      reason: dto.reason,
      metadata: { grantId: id.toString(), capability: row.capabilityKey, effect: row.effect },
    });
  }
}
