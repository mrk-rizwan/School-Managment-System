import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { fieldRefused, notFound } from '../../common/errors/api-exception';
import { summariseDatabaseError } from '../../common/errors/prisma-errors';
import { toPage, type Page } from '../../common/pagination';
import { SchoolContext } from '../../common/school-context';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import {
  CustomRoleRepository,
  type CustomRoleRecord,
} from '../../repositories/custom-role.repository';
import {
  capabilityNotHeld,
  customRoleArchived,
  customRoleInUse,
  customRoleKeyTaken,
} from './access.errors';
import { capabilityOrder, delegableCapabilities } from './effective-permissions';
import type {
  CreateCustomRoleDto,
  CustomRoleDto,
  ListCustomRolesQueryDto,
  ReasonDto,
  UpdateCustomRoleDto,
} from './roles.dto';

// contracts/slice-7.md §3. A role row is locked (CustomRoleRepository.lock, which writes nothing
// visible) for every edit and archive, and by role assignment after the user row, so archive and
// assign serialise (R96).

const KEY_UNIQUE = 'custom_roles_school_id_key_key';

export const toCustomRoleDto = (row: CustomRoleRecord): CustomRoleDto => ({
  id: row.id.toString(),
  key: row.key,
  name: row.name,
  status: row.status,
  // Live keys in registry order; unknown keys stored in the database are dropped.
  capabilities: delegableCapabilities(row.capabilityKeys),
  holderCount: row.holderCount,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

@Injectable()
export class CustomRolesService {
  constructor(
    private readonly context: SchoolContext,
    private readonly roles: CustomRoleRepository,
    private readonly audit: AuditLogRepository,
  ) {}

  async list(query: ListCustomRolesQueryDto): Promise<Page<CustomRoleDto>> {
    const { rows, total } = await this.roles.list(this.context.schoolId, {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.q === undefined ? {} : { q: query.q }),
      sort: query.sort ?? 'name',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map(toCustomRoleDto), query, total);
  }

  async get(id: bigint): Promise<CustomRoleDto> {
    const row = await this.roles.findById(this.context.schoolId, id);
    if (!row) throw notFound();
    return toCustomRoleDto(row);
  }

  /** A race on the key's partial unique index answers as the pre-check (fresh read). */
  async create(session: SchoolSessionContext, dto: CreateCustomRoleDto): Promise<CustomRoleDto> {
    let id: bigint;
    try {
      id = await this.createInTransaction(session, dto);
    } catch (error) {
      if (summariseDatabaseError(error)?.constraint !== KEY_UNIQUE) throw error;
      const winner = await this.roles.findActiveIdByKey(session.schoolId, dto.key);
      throw winner === null ? error : customRoleKeyTaken(winner);
    }
    return this.get(id);
  }

  async update(
    session: SchoolSessionContext,
    id: bigint,
    dto: UpdateCustomRoleDto,
  ): Promise<CustomRoleDto> {
    await this.updateInTransaction(session, id, dto);
    return this.get(id);
  }

  async archive(session: SchoolSessionContext, id: bigint, dto: ReasonDto): Promise<CustomRoleDto> {
    await this.archiveInTransaction(session, id, dto);
    return this.get(id);
  }

  @Transactional()
  private async createInTransaction(
    session: SchoolSessionContext,
    dto: CreateCustomRoleDto,
  ): Promise<bigint> {
    const { schoolId, access: actor } = session;
    // R94: only capabilities the creator holds at creation.
    const missing = dto.capabilities.filter((key) => !actor.capabilities.has(key));
    if (missing.length > 0) throw capabilityNotHeld(missing);
    const existing = await this.roles.findActiveIdByKey(schoolId, dto.key);
    if (existing !== null) throw customRoleKeyTaken(existing);
    const id = await this.roles.create(schoolId, {
      key: dto.key,
      name: dto.name,
      capabilityKeys: dto.capabilities,
      addedBy: actor.userId,
      now: new Date(),
    });
    await this.audit.record(schoolId, {
      actorUserId: actor.userId,
      action: 'custom_role.created',
      subjectType: 'custom_role',
      subjectId: id,
      metadata: { key: dto.key, capabilities: [...dto.capabilities].sort(capabilityOrder).join(',') },
    });
    return id;
  }

  /**
   * R94: keys added need the editor to hold them now; keys already in the role are not
   * re-checked. R95: removing keys needs only role.manage (the route) and a reason, and applies
   * to every holder on their next request (capabilities are read per request, R69). Adding keys
   * to a held role grants them to every holder, so that needs a reason too (§3.4).
   */
  @Transactional()
  private async updateInTransaction(
    session: SchoolSessionContext,
    id: bigint,
    dto: UpdateCustomRoleDto,
  ): Promise<void> {
    const { schoolId, access: actor } = session;
    const role = await this.roles.lock(schoolId, id);
    if (!role) throw notFound();
    if (role.status !== 'active') throw customRoleArchived();
    const current = new Set<string>(role.capabilityKeys);
    const wanted = new Set<string>(dto.capabilities ?? role.capabilityKeys);
    const added = (dto.capabilities ?? []).filter((key) => !current.has(key));
    const removed = [...current].filter((key) => !wanted.has(key));
    if (removed.length > 0 && dto.reason === undefined) {
      throw fieldRefused('reason', ErrorCode.INVALID_VALUE, 'Give a reason for removing permissions.');
    }
    if (added.length > 0 && role.holderCount > 0 && dto.reason === undefined) {
      throw fieldRefused(
        'reason',
        ErrorCode.INVALID_VALUE,
        'Give a reason: the added permissions reach everyone who holds this role.',
      );
    }
    const missing = added.filter((key) => !actor.capabilities.has(key));
    if (missing.length > 0) throw capabilityNotHeld(missing);
    const nameChanged = dto.name !== undefined && dto.name !== role.name;
    if (added.length === 0 && removed.length === 0 && !nameChanged) return;

    const now = new Date();
    await this.roles.markEdited(schoolId, id, {
      ...(nameChanged && dto.name !== undefined ? { name: dto.name } : {}),
      now,
    });
    await this.roles.removeCapabilities(schoolId, id, removed, actor.userId, now);
    await this.roles.addCapabilities(schoolId, id, added, actor.userId, now);
    await this.audit.record(schoolId, {
      actorUserId: actor.userId,
      action: 'custom_role.updated',
      subjectType: 'custom_role',
      subjectId: id,
      ...(dto.reason === undefined ? {} : { reason: dto.reason }),
      metadata: {
        added: [...added].sort(capabilityOrder).join(','),
        removed: [...removed].sort().join(','),
        nameChanged,
        holderCount: role.holderCount,
      },
    });
  }

  /** R52, R96: refused while any live role row holds it, whatever that user's status. */
  @Transactional()
  private async archiveInTransaction(
    session: SchoolSessionContext,
    id: bigint,
    dto: ReasonDto,
  ): Promise<void> {
    const { schoolId, access: actor } = session;
    const role = await this.roles.lock(schoolId, id);
    if (!role) throw notFound();
    if (role.status === 'archived') return;
    if (role.holderCount > 0) throw customRoleInUse(role.holderCount);
    await this.roles.archive(schoolId, id);
    await this.audit.record(schoolId, {
      actorUserId: actor.userId,
      action: 'custom_role.archived',
      subjectType: 'custom_role',
      subjectId: id,
      reason: dto.reason,
      metadata: { key: role.key },
    });
  }
}
