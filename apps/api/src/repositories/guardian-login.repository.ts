import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

// The guardian side of the users table, for POST /guardians/:id/issue-login
// (contracts/slice-5.md §3.7). Reading, locking and listing users is UserRepository's.

@Injectable()
export class GuardianLoginRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** Sets guardian_id on a user that has none. Returns rows changed (0 or 1). */
  async linkGuardian(schoolId: SchoolId, userId: bigint, guardianId: bigint): Promise<number> {
    const { count } = await this.txHost.tx.user.updateMany({
      where: { schoolId, id: userId, guardianId: null },
      data: { guardianId },
    });
    return count;
  }

  /** A new parent login: default password, active, linked to the guardian. */
  async createGuardianUser(
    schoolId: SchoolId,
    data: { usernameHash: string; passwordHash: string; guardianId: bigint },
  ): Promise<bigint> {
    const row = await this.txHost.tx.user.create({
      data: {
        schoolId,
        usernameHash: data.usernameHash,
        passwordHash: data.passwordHash,
        passwordIsDefault: true,
        status: 'active',
        guardianId: data.guardianId,
      },
      select: { id: true },
    });
    return row.id;
  }
}
