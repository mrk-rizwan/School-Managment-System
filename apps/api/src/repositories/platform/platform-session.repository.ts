import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { PlatformSessionStage } from '../../common/auth/platform-session';
import type { PrismaTxAdapter } from '../prisma';

export interface PlatformSessionRow {
  id: bigint;
  platformUserId: bigint;
  stage: PlatformSessionStage;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

const COLUMNS = {
  id: true,
  platformUserId: true,
  stage: true,
  lastSeenAt: true,
  expiresAt: true,
  revokedAt: true,
} as const;

/** A session with the user fields the access check needs. */
export interface PlatformSessionWithUser extends PlatformSessionRow {
  user: {
    id: bigint;
    email: string;
    status: 'active' | 'disabled';
    totpEnrolledAt: Date | null;
    mustChangePassword: boolean;
  };
}

const USER_COLUMNS = {
  id: true,
  email: true,
  status: true,
  totpEnrolledAt: true,
  mustChangePassword: true,
} as const;

export interface NewPlatformSession {
  platformUserId: bigint;
  /** SHA-256 hex; the token itself is never stored. */
  tokenHash: string;
  stage: PlatformSessionStage;
  createdAt: Date;
  expiresAt: Date;
  userAgent: string | null;
  ip: string | null;
}

/** platform_sessions (CLAUDE.md named exception 1). Every call joins the ambient transaction. */
@Injectable()
export class PlatformSessionRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  create(session: NewPlatformSession): Promise<PlatformSessionRow> {
    return this.txHost.tx.platformSession.create({
      data: {
        platformUserId: session.platformUserId,
        tokenHash: session.tokenHash,
        stage: session.stage,
        createdAt: session.createdAt,
        lastSeenAt: session.createdAt,
        expiresAt: session.expiresAt,
        userAgent: session.userAgent,
        ip: session.ip,
      },
      select: COLUMNS,
    });
  }

  /**
   * The session with its user, or null. Two statements, not a join: the query guard refuses
   * `include` and relation `select` on every non-tenant model (src/repositories/query-guard.ts).
   */
  async findByTokenHash(tokenHash: string): Promise<PlatformSessionWithUser | null> {
    const session = await this.txHost.tx.platformSession.findUnique({
      where: { tokenHash },
      select: COLUMNS,
    });
    if (!session) return null;
    const user = await this.txHost.tx.platformUser.findUnique({
      where: { id: session.platformUserId },
      select: USER_COLUMNS,
    });
    return user ? { ...session, user } : null;
  }

  /** last_seen_at = now, unless it is already later than `notBefore` (another request wrote it). */
  async touch(id: bigint, now: Date, notBefore: Date): Promise<void> {
    await this.txHost.tx.platformSession.updateMany({
      where: { id, lastSeenAt: { lt: notBefore } },
      data: { lastSeenAt: now },
    });
  }

  async revokeByTokenHash(tokenHash: string, now: Date): Promise<void> {
    await this.txHost.tx.platformSession.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  async revokeAllForUser(platformUserId: bigint, now: Date): Promise<void> {
    await this.txHost.tx.platformSession.updateMany({
      where: { platformUserId, revokedAt: null },
      data: { revokedAt: now },
    });
  }
}
