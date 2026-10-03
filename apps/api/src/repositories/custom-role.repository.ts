import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { CustomRoleStatus } from '@asms/shared';
import { readLocked } from '../common/locking';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

/** One custom_roles row with its live keys (as stored) and live holder count. */
export interface CustomRoleRecord {
  id: bigint;
  key: string;
  name: string;
  status: CustomRoleStatus;
  capabilityKeys: string[];
  holderCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A live custom-role assignment of one user, for effective permissions. */
export interface UserCustomRole {
  userRoleId: bigint;
  customRoleId: bigint;
  name: string;
  status: CustomRoleStatus;
  capabilityKeys: string[];
}

export type CustomRoleSort = 'name' | '-name' | 'createdAt' | '-createdAt';

const SELECT = {
  id: true,
  key: true,
  name: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  capabilities: { where: { removedAt: null }, select: { capabilityKey: true }, orderBy: { id: 'asc' } },
  _count: { select: { userRoles: { where: { endedAt: null } } } },
} as const satisfies Prisma.CustomRoleSelect;

type Row = Prisma.CustomRoleGetPayload<{ select: typeof SELECT }>;

const toRecord = (row: Row): CustomRoleRecord => ({
  id: row.id,
  key: row.key,
  name: row.name,
  status: row.status,
  capabilityKeys: row.capabilities.map((c) => c.capabilityKey),
  holderCount: row._count.userRoles,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

function orderBy(sort: CustomRoleSort): Prisma.CustomRoleOrderByWithRelationInput {
  switch (sort) {
    case 'name':
      return { name: 'asc' };
    case '-name':
      return { name: 'desc' };
    case 'createdAt':
      return { createdAt: 'asc' };
    case '-createdAt':
      return { createdAt: 'desc' };
  }
}

/**
 * custom_roles and custom_role_capabilities (tenant, contracts/slice-7.md). Never deleted: a role
 * is archived, a key's row is ended (removed_at).
 */
@Injectable()
export class CustomRoleRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async list(
    schoolId: SchoolId,
    query: { status?: CustomRoleStatus; q?: string; sort: CustomRoleSort; skip: number; take: number },
  ): Promise<{ rows: CustomRoleRecord[]; total: number }> {
    const where: Prisma.CustomRoleWhereInput = {
      schoolId,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.q === undefined
        ? {}
        : {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { key: { contains: query.q, mode: 'insensitive' } },
            ],
          }),
    };
    // Sequential, not Promise.all (§3.3).
    const rows = await this.txHost.tx.customRole.findMany({
      where,
      select: SELECT,
      orderBy: [orderBy(query.sort), { id: 'asc' }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.customRole.count({ where });
    return { rows: rows.map(toRecord), total };
  }

  async findById(schoolId: SchoolId, id: bigint): Promise<CustomRoleRecord | null> {
    const row = await this.txHost.tx.customRole.findFirst({ where: { schoolId, id }, select: SELECT });
    return row ? toRecord(row) : null;
  }

  async findActiveIdByKey(schoolId: SchoolId, key: string): Promise<bigint | null> {
    const row = await this.txHost.tx.customRole.findFirst({
      where: { schoolId, key, status: 'active' },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /**
   * Locks the role row for the rest of the transaction and returns it as read under the lock, or
   * null when it is not in the school. The lock is a compare-and-set that rewrites updated_at
   * with its own value (readLocked), so taking it changes nothing visible: a no-op edit, an
   * archive of an archived role and a custom-role assignment leave updatedAt alone. The row is
   * read again under the lock because its holder count lives on user_roles and does not move
   * updated_at. Lock order: after the user row (contracts/slice-7.md §1).
   */
  async lock(schoolId: SchoolId, id: bigint): Promise<CustomRoleRecord | null> {
    // Wrapped so an absent row comes back as null instead of readLocked's 404.
    const { row } = await readLocked(
      async () => ({ row: await this.findById(schoolId, id) }),
      ({ row }) => (row === null ? Promise.resolve(true) : this.lockIfUnchanged(schoolId, row)),
    );
    return row === null ? null : this.findById(schoolId, id);
  }

  private async lockIfUnchanged(schoolId: SchoolId, row: CustomRoleRecord): Promise<boolean> {
    const { count } = await this.txHost.tx.customRole.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt, status: row.status },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  /** A new active role; a second active role of the key fails custom_roles_school_id_key_key. */
  async create(
    schoolId: SchoolId,
    data: { key: string; name: string; capabilityKeys: readonly string[]; addedBy: bigint; now: Date },
  ): Promise<bigint> {
    const role = await this.txHost.tx.customRole.create({
      data: { schoolId, key: data.key, name: data.name },
      select: { id: true },
    });
    await this.addCapabilities(schoolId, role.id, data.capabilityKeys, data.addedBy, data.now);
    return role.id;
  }

  /** A real edit (name and/or keys): sets updated_at, and the name when given. */
  async markEdited(schoolId: SchoolId, id: bigint, data: { name?: string; now: Date }): Promise<void> {
    await this.txHost.tx.customRole.updateMany({
      where: { schoolId, id },
      data: { ...(data.name === undefined ? {} : { name: data.name }), updatedAt: data.now },
    });
  }

  async archive(schoolId: SchoolId, id: bigint): Promise<void> {
    await this.txHost.tx.customRole.updateMany({
      where: { schoolId, id, status: 'active' },
      data: { status: 'archived' },
    });
  }

  async addCapabilities(
    schoolId: SchoolId,
    customRoleId: bigint,
    keys: readonly string[],
    addedBy: bigint,
    now: Date,
  ): Promise<void> {
    if (keys.length === 0) return;
    await this.txHost.tx.customRoleCapability.createMany({
      data: keys.map((capabilityKey) => ({
        schoolId,
        customRoleId,
        capabilityKey,
        addedBy,
        addedAt: now,
      })),
    });
  }

  /** Ends the live rows of these keys (never deletes). */
  async removeCapabilities(
    schoolId: SchoolId,
    customRoleId: bigint,
    keys: readonly string[],
    removedBy: bigint,
    now: Date,
  ): Promise<void> {
    if (keys.length === 0) return;
    await this.txHost.tx.customRoleCapability.updateMany({
      where: { schoolId, customRoleId, capabilityKey: { in: [...keys] }, removedAt: null },
      data: { removedAt: now, removedBy },
    });
  }

  /** The user's live custom-role rows with each role's live keys, in assignment order. */
  async liveForUser(schoolId: SchoolId, userId: bigint): Promise<UserCustomRole[]> {
    const rows = await this.txHost.tx.userRole.findMany({
      where: { schoolId, userId, endedAt: null, customRoleId: { not: null } },
      select: {
        id: true,
        customRole: {
          select: {
            id: true,
            name: true,
            status: true,
            capabilities: { where: { removedAt: null }, select: { capabilityKey: true } },
          },
        },
      },
      orderBy: { id: 'asc' },
    });
    return rows.flatMap((row) =>
      row.customRole
        ? [
            {
              userRoleId: row.id,
              customRoleId: row.customRole.id,
              name: row.customRole.name,
              status: row.customRole.status,
              capabilityKeys: row.customRole.capabilities.map((c) => c.capabilityKey),
            },
          ]
        : [],
    );
  }
}
