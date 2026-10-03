import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@asms/shared';
import type { Request } from 'express';
import {
  bindSchoolSession,
  presentedSchoolToken,
  SCHOOL_SESSION_LIMITS,
  sessionLifetime,
  type SchoolSessionContext,
} from '../common/auth/school-session';
import { ApiException } from '../common/errors/api-exception';
import { PermissionsService } from '../modules/access/permissions.service';
import { OwnSchoolRepository } from '../repositories/own-school.repository';
import { SessionRepository } from '../repositories/session.repository';
import { schoolIdFromSession } from './school-id.mint';
import { SessionEstablisher } from './session-establisher';

const authRequired = () => new ApiException(401, ErrorCode.AUTH_REQUIRED, 'Sign in to continue.');

/**
 * School session resolution (CLAUDE.md named exception 4; contract slice-2 §1.1). Called by the
 * access guard for @AuthenticatedOnly, @RequireStaff and @RequireCapability routes. Reads only
 * the school cookie or a bearer token, never the platform cookie or platform_sessions (R56).
 *
 * 1. cookie xor bearer, bearer well-formed; 2. live row by token hash, not idle, same channel;
 * 3. school not terminated, user active with an active capacity; 4. the tenant is set on the
 * request context; 5. last_seen_at refreshed at most every 5 minutes, outside any transaction.
 * Every refusal is the same 401 AUTH_REQUIRED.
 */
@Injectable()
export class SchoolSessionResolver {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly ownSchool: OwnSchoolRepository,
    private readonly permissions: PermissionsService,
    private readonly establisher: SessionEstablisher,
  ) {}

  async resolve(req: Request): Promise<SchoolSessionContext> {
    const presented = presentedSchoolToken(req);
    if (presented.kind === 'none' || presented.kind === 'invalid') throw authRequired();

    const row = await this.sessions.findActiveByTokenHash(presented.tokenHash);
    const now = new Date();
    const idleFor = row ? now.getTime() - row.lastSeenAt.getTime() : 0;
    // The longest idle window of the channel first (no capacity can make it longer), so an
    // idle session is refused before any further read.
    if (
      !row ||
      row.channel !== presented.kind ||
      idleFor >= sessionLifetime(row.channel, { staff: false }).idleMs
    ) {
      throw authRequired();
    }

    const schoolId = schoolIdFromSession(row);
    const school = await this.ownSchool.find(schoolId);
    if (!school || school.status === 'terminated') throw authRequired();
    const access = await this.permissions.load(schoolId, row.userId);
    // R71: a disabled user, or one with no active capacity, has no live session.
    if (!access || access.status !== 'active' || !this.permissions.hasAnyCapacity(access)) {
      throw authRequired();
    }
    // R154: idle per channel and the capacities held now (a bearer staff session idles at 14 d).
    if (idleFor >= sessionLifetime(row.channel, access.capacities).idleMs) throw authRequired();

    this.establisher.establishSession({ schoolId, userId: row.userId, sessionId: row.id });

    if (now.getTime() - row.lastSeenAt.getTime() >= SCHOOL_SESSION_LIMITS.lastSeenWriteMs) {
      const notBefore = new Date(now.getTime() - SCHOOL_SESSION_LIMITS.lastSeenWriteMs);
      await this.sessions.touch(schoolId, row.id, now, notBefore);
    }

    const session: SchoolSessionContext = {
      schoolId,
      sessionId: row.id,
      tokenHash: presented.tokenHash,
      channel: row.channel,
      expiresAt: row.expiresAt,
      school: { id: school.id, name: school.name, shortCode: school.shortCode, status: school.status },
      access,
    };
    bindSchoolSession(req, session);
    return session;
  }

  /**
   * Login revokes whatever school session came with the request (plan §3.5: login always mints a
   * fresh token), in whichever school it lives. Joins the caller's transaction.
   */
  async revokePresented(req: Request, now: Date): Promise<void> {
    const presented = presentedSchoolToken(req);
    if (presented.kind === 'none' || presented.kind === 'invalid') return;
    const row = await this.sessions.findActiveByTokenHash(presented.tokenHash);
    if (row) await this.sessions.revoke(schoolIdFromSession(row), row.id, now);
  }
}
