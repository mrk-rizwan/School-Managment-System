import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SessionChannelName } from '../common/auth/school-session';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

/** A live session row as session resolution reads it (contract slice-2 §1.1 step 2). */
export interface ActiveSessionRow {
  readonly id: bigint;
  readonly schoolId: bigint;
  readonly userId: bigint;
  readonly channel: SessionChannelName;
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
}

interface RawSessionRow {
  id: bigint;
  school_id: bigint;
  user_id: bigint;
  channel: string;
  expires_at: Date;
  last_seen_at: Date;
}

export interface NewSchoolSession {
  userId: bigint;
  /** SHA-256 hex; the token itself is never stored. */
  tokenHash: string;
  channel: SessionChannelName;
  createdAt: Date;
  expiresAt: Date;
  userAgent: string | null;
  ip: string | null;
}

const isChannel = (value: string): value is SessionChannelName =>
  value === 'cookie' || value === 'bearer';

/**
 * School sessions. Every method but one takes the SchoolId. The exception is
 * findActiveByTokenHash: the session token is what establishes the tenant (CLAUDE.md named
 * exception 4), so it cannot be scoped. It is raw SQL because the query guard refuses any
 * tenant-model operation without a schoolId, which is the point of the guard; this file is
 * listed in RAW_SQL_FILES (eslint.config.mjs) and has its own isolation test
 * (test/school-auth/repositories.e2e-spec.ts).
 */
@Injectable()
export class SessionRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** Not revoked and before its absolute expiry. Idle and channel checks are the caller's. */
  async findActiveByTokenHash(tokenHash: string): Promise<ActiveSessionRow | null> {
    const rows = await this.txHost.tx.$queryRaw<RawSessionRow[]>`
      SELECT id, school_id, user_id, channel::text AS channel, expires_at, last_seen_at
        FROM sessions
       WHERE token_hash = ${tokenHash}
         AND revoked_at IS NULL
         AND expires_at > now()`;
    const row = rows[0];
    if (!row || !isChannel(row.channel)) return null;
    return {
      id: row.id,
      schoolId: row.school_id,
      userId: row.user_id,
      channel: row.channel,
      expiresAt: row.expires_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  async create(schoolId: SchoolId, session: NewSchoolSession): Promise<{ id: bigint; expiresAt: Date }> {
    return this.txHost.tx.session.create({
      data: {
        schoolId,
        userId: session.userId,
        tokenHash: session.tokenHash,
        channel: session.channel,
        createdAt: session.createdAt,
        lastSeenAt: session.createdAt,
        expiresAt: session.expiresAt,
        userAgent: session.userAgent,
        ip: session.ip,
      },
      select: { id: true, expiresAt: true },
    });
  }

  /** last_seen_at = now, unless another request already wrote it after `notBefore`. */
  async touch(schoolId: SchoolId, id: bigint, now: Date, notBefore: Date): Promise<void> {
    await this.txHost.tx.session.updateMany({
      where: { schoolId, id, lastSeenAt: { lt: notBefore } },
      data: { lastSeenAt: now },
    });
  }

  async revoke(schoolId: SchoolId, id: bigint, now: Date): Promise<void> {
    await this.txHost.tx.session.updateMany({
      where: { schoolId, id, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  /** Every live session of the user, optionally sparing one (the caller's own, before rotation). */
  async revokeAllForUser(
    schoolId: SchoolId,
    userId: bigint,
    now: Date,
    exceptId?: bigint,
  ): Promise<number> {
    const { count } = await this.txHost.tx.session.updateMany({
      where: {
        schoolId,
        userId,
        revokedAt: null,
        ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
      },
      data: { revokedAt: now },
    });
    return count;
  }

  /**
   * Re-checks the request's own session after a user-row lock is held: a session revoked while
   * the request waited for the lock (office reset, principal link, disable) must not finish its
   * write (wave-A security re-check).
   */
  async isLive(schoolId: SchoolId, id: bigint, now: Date): Promise<boolean> {
    const count = await this.txHost.tx.session.count({
      where: { schoolId, id, revokedAt: null, expiresAt: { gt: now } },
    });
    return count === 1;
  }

  /** Live (unrevoked, unexpired) sessions of a user; for tests of revocation and for R70. */
  countLiveForUser(schoolId: SchoolId, userId: bigint, now: Date): Promise<number> {
    return this.txHost.tx.session.count({
      where: { schoolId, userId, revokedAt: null, expiresAt: { gt: now } },
    });
  }
}
