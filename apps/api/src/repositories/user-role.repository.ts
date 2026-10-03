import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SystemRole } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

/** One user_roles row (contracts/slice-4.md §2 UserRoleDto). */
export interface UserRoleRecord {
  id: bigint;
  userId: bigint;
  systemRole: SystemRole | null;
  /** Null for the platform's principal assignment. */
  assignedBy: bigint | null;
  assignedAt: Date;
  endedAt: Date | null;
  endedBy: bigint | null;
}

const RECORD_SELECT = {
  id: true,
  userId: true,
  systemRole: true,
  assignedBy: true,
  assignedAt: true,
  endedAt: true,
  endedBy: true,
} as const satisfies Prisma.UserRoleSelect;

/** user_roles (tenant). Rows are ended, never deleted. */
@Injectable()
export class UserRoleRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /**
   * Holders of R72's invariant: a live principal row on an `active` user whose staff record is
   * `active`. `exceptUserId` asks "how many would remain without this user".
   */
  countActivePrincipals(schoolId: SchoolId, exceptUserId?: bigint): Promise<number> {
    return this.txHost.tx.userRole.count({
      where: {
        schoolId,
        systemRole: 'principal',
        endedAt: null,
        ...(exceptUserId === undefined ? {} : { userId: { not: exceptUserId } }),
        user: { status: 'active', staff: { status: 'active' } },
      },
    });
  }

  /**
   * R72: removing this user's principal capacity would leave none. True when the user is counted
   * (live principal row, user and staff active) and nobody else is.
   */
  async isLastActivePrincipal(schoolId: SchoolId, userId: bigint): Promise<boolean> {
    const others = await this.countActivePrincipals(schoolId, userId);
    return others === 0 && (await this.countActivePrincipals(schoolId)) > 0;
  }

  /** User ids of the active principals (as countActivePrincipals counts them). */
  async activePrincipalUserIds(schoolId: SchoolId): Promise<bigint[]> {
    const rows = await this.txHost.tx.userRole.findMany({
      where: {
        schoolId,
        systemRole: 'principal',
        endedAt: null,
        user: { status: 'active', staff: { status: 'active' } },
      },
      select: { userId: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => r.userId);
  }

  async hasLivePrincipalRole(schoolId: SchoolId, userId: bigint): Promise<boolean> {
    const row = await this.txHost.tx.userRole.findFirst({
      where: { schoolId, userId, systemRole: 'principal', endedAt: null },
      select: { id: true },
    });
    return row !== null;
  }

  /** The platform's principal assignment: no school-user assigner (CHECK user_roles_assigned_by_check). */
  async insertPlatformPrincipal(schoolId: SchoolId, userId: bigint, now: Date): Promise<void> {
    await this.txHost.tx.userRole.create({
      data: { schoolId, userId, systemRole: 'principal', assignedBy: null, assignedAt: now },
      select: { id: true },
    });
  }

  /** Live system roles of each user, in assignment order; users with none are absent. */
  async liveRolesByUser(
    schoolId: SchoolId,
    userIds: readonly bigint[],
  ): Promise<Map<bigint, SystemRole[]>> {
    const byUser = new Map<bigint, SystemRole[]>();
    if (userIds.length === 0) return byUser;
    const rows = await this.txHost.tx.userRole.findMany({
      where: { schoolId, userId: { in: [...userIds] }, endedAt: null },
      select: { userId: true, systemRole: true },
      orderBy: { id: 'asc' },
    });
    for (const row of rows) {
      if (row.systemRole === null) continue;
      byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row.systemRole]);
    }
    return byUser;
  }

  /** A page of the user's rows, newest assignment first. */
  async listForUser(
    schoolId: SchoolId,
    userId: bigint,
    query: { includeEnded: boolean; skip: number; take: number },
  ): Promise<{ rows: UserRoleRecord[]; total: number }> {
    const where: Prisma.UserRoleWhereInput = {
      schoolId,
      userId,
      ...(query.includeEnded ? {} : { endedAt: null }),
    };
    // Sequential, not Promise.all (§3.3).
    const rows = await this.txHost.tx.userRole.findMany({
      where,
      select: RECORD_SELECT,
      orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.userRole.count({ where });
    return { rows, total };
  }

  findById(schoolId: SchoolId, id: bigint): Promise<UserRoleRecord | null> {
    return this.txHost.tx.userRole.findFirst({ where: { schoolId, id }, select: RECORD_SELECT });
  }

  /** The user's live row of this system role (at most one: the partial unique index). */
  findLive(
    schoolId: SchoolId,
    userId: bigint,
    systemRole: SystemRole,
  ): Promise<UserRoleRecord | null> {
    return this.txHost.tx.userRole.findFirst({
      where: { schoolId, userId, systemRole, endedAt: null },
      select: RECORD_SELECT,
    });
  }

  /**
   * A school user assigning a system role (issue-login, role assignment). A second live row of
   * the role fails user_roles_school_id_user_id_system_role_key. The caller holds the user lock.
   */
  assign(
    schoolId: SchoolId,
    data: { userId: bigint; systemRole: SystemRole; assignedBy: bigint; now: Date },
  ): Promise<UserRoleRecord> {
    return this.txHost.tx.userRole.create({
      data: {
        schoolId,
        userId: data.userId,
        systemRole: data.systemRole,
        assignedBy: data.assignedBy,
        assignedAt: data.now,
      },
      select: RECORD_SELECT,
    });
  }

  /** Ends one live row. Returns rows changed (0 when it was already ended). */
  async end(schoolId: SchoolId, id: bigint, endedBy: bigint, now: Date): Promise<number> {
    const { count } = await this.txHost.tx.userRole.updateMany({
      where: { schoolId, id, endedAt: null },
      data: { endedAt: now, endedBy },
    });
    return count;
  }

  /** Ends every live row of the user (staff left, R17). Returns how many. */
  async endAllForUser(
    schoolId: SchoolId,
    userId: bigint,
    endedBy: bigint,
    now: Date,
  ): Promise<number> {
    const { count } = await this.txHost.tx.userRole.updateMany({
      where: { schoolId, userId, endedAt: null },
      data: { endedAt: now, endedBy },
    });
    return count;
  }
}
