import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { PrismaTxAdapter } from '../prisma';

/** A platform user as the auth module needs it. Email is stored trimmed and lower-cased. */
export interface PlatformUserRow {
  id: bigint;
  email: string;
  passwordHash: string;
  totpSecret: string | null;
  totpEnrolledAt: Date | null;
  totpLastStep: bigint | null;
  mustChangePassword: boolean;
  status: 'active' | 'disabled';
}

const COLUMNS = {
  id: true,
  email: true,
  passwordHash: true,
  totpSecret: true,
  totpEnrolledAt: true,
  totpLastStep: true,
  mustChangePassword: true,
  status: true,
} as const;

/** platform_users (CLAUDE.md named exception 1). Every call joins the ambient transaction. */
@Injectable()
export class PlatformUserRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  findByEmail(email: string): Promise<PlatformUserRow | null> {
    return this.txHost.tx.platformUser.findUnique({ where: { email }, select: COLUMNS });
  }

  findById(id: bigint): Promise<PlatformUserRow | null> {
    return this.txHost.tx.platformUser.findUnique({ where: { id }, select: COLUMNS });
  }

  /**
   * Locks the user row for the rest of the transaction and returns it as read under the lock
   * (§3.3, R99: credential changes lock the user first). An UPDATE holds its row lock until
   * commit, so touching updated_at is a FOR UPDATE that needs no raw SQL. Null if absent.
   */
  async lockById(id: bigint): Promise<PlatformUserRow | null> {
    const { count } = await this.txHost.tx.platformUser.updateMany({
      where: { id },
      data: { updatedAt: new Date() },
    });
    return count === 0 ? null : this.findById(id);
  }

  async recordLogin(id: bigint, now: Date, totpStep: bigint | null): Promise<void> {
    await this.txHost.tx.platformUser.update({
      where: { id },
      data: { lastLoginAt: now, ...(totpStep === null ? {} : { totpLastStep: totpStep }) },
    });
  }

  /** Stores a new pending secret. False if the user has meanwhile completed enrolment. */
  async setPendingTotpSecret(id: bigint, encryptedSecret: string): Promise<boolean> {
    const { count } = await this.txHost.tx.platformUser.updateMany({
      where: { id, totpEnrolledAt: null },
      data: { totpSecret: encryptedSecret },
    });
    return count === 1;
  }

  async confirmTotp(id: bigint, step: bigint, now: Date): Promise<void> {
    await this.txHost.tx.platformUser.update({
      where: { id },
      data: { totpEnrolledAt: now, totpLastStep: step },
    });
  }

  async changePassword(id: bigint, passwordHash: string, now: Date): Promise<void> {
    await this.txHost.tx.platformUser.update({
      where: { id },
      data: { passwordHash, mustChangePassword: false, passwordChangedAt: now },
    });
  }

  /**
   * The seed's `INSERT ... ON CONFLICT (email) DO NOTHING`: an existing user is never touched.
   * Returns the new user's id, or null if the email already existed.
   */
  async insertIfAbsent(email: string, passwordHash: string): Promise<bigint | null> {
    const { count } = await this.txHost.tx.platformUser.createMany({
      data: [{ email, passwordHash, mustChangePassword: true, status: 'active' }],
      skipDuplicates: true,
    });
    if (count === 0) return null;
    const row = await this.findByEmail(email);
    return row?.id ?? null;
  }
}
