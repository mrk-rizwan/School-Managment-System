import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

export type UserTokenPurposeValue = 'password_reset' | 'email_verify';

/**
 * user_tokens (tenant): password-reset and email-verification tokens, stored as SHA-256 only.
 * Consumed by one conditional update, never read-then-write. Voiding sets expires_at = now
 * (contract slice-2 decision 5); used_at means consumed only.
 */
@Injectable()
export class UserTokenRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async create(
    schoolId: SchoolId,
    token: {
      userId: bigint;
      purpose: UserTokenPurposeValue;
      tokenHash: string;
      /** The address a verify token is bound to; null for a reset token (CHECK user_tokens_email_check). */
      email: string | null;
      createdAt: Date;
      expiresAt: Date;
    },
  ): Promise<void> {
    await this.txHost.tx.userToken.create({
      data: { schoolId, ...token },
      select: { id: true },
    });
  }

  /**
   * The user of a usable token, read without locking anything: the caller locks that user row
   * first and only then consumes the token, so token flows take locks in the same order as every
   * other user write (user, then tokens). Null for anything consume would refuse.
   */
  async findUsableUserId(
    schoolId: SchoolId,
    tokenHash: string,
    purpose: UserTokenPurposeValue,
    now: Date,
  ): Promise<bigint | null> {
    const row = await this.txHost.tx.userToken.findFirst({
      where: { schoolId, tokenHash, purpose, usedAt: null, expiresAt: { gt: now } },
      select: { userId: true },
    });
    return row?.userId ?? null;
  }

  /**
   * Marks the token used if it is unused, unexpired and of this purpose in this school, and
   * returns its user and bound address. Null for anything else: unknown, used, expired, another
   * school's (a token from school A sent with school B's code), another purpose.
   */
  async consume(
    schoolId: SchoolId,
    tokenHash: string,
    purpose: UserTokenPurposeValue,
    now: Date,
  ): Promise<{ userId: bigint; email: string | null } | null> {
    const rows = await this.txHost.tx.userToken.updateManyAndReturn({
      where: { schoolId, tokenHash, purpose, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
      select: { userId: true, email: true },
    });
    return rows[0] ?? null;
  }

  /** Voids the user's outstanding tokens of the given purposes (all purposes by default). */
  async voidOutstanding(
    schoolId: SchoolId,
    userId: bigint,
    now: Date,
    purposes: readonly UserTokenPurposeValue[] = ['password_reset', 'email_verify'],
  ): Promise<number> {
    const { count } = await this.txHost.tx.userToken.updateMany({
      where: {
        schoolId,
        userId,
        purpose: { in: [...purposes] },
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { expiresAt: now },
    });
    return count;
  }

  /** Outstanding (usable) tokens of a user; for tests of voiding. */
  countOutstanding(schoolId: SchoolId, userId: bigint, now: Date): Promise<number> {
    return this.txHost.tx.userToken.count({
      where: { schoolId, userId, usedAt: null, expiresAt: { gt: now } },
    });
  }
}
