import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

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
}
