import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@asms/shared';
import type { Request } from 'express';
import {
  bindPlatformSession,
  PLATFORM_COOKIE,
  PLATFORM_SESSION_LIMITS,
  readCookie,
  sha256Hex,
} from '../../../common/auth/platform-session';
import type { PlatformSessionLevel } from '../../../common/auth/route-access';
import { ApiException } from '../../../common/errors/api-exception';
import {
  PlatformSessionRepository,
  type PlatformSessionWithUser,
} from '../../../repositories/platform/platform-session.repository';

const authRequired = () => new ApiException(401, ErrorCode.AUTH_REQUIRED, 'Sign in to continue.');

/**
 * The @PlatformSession(level) check, called by RouteAccessGuard (contracts/slice-1.md §1). Order:
 * refuse any Authorization header → read only the platform cookie → load by token hash from
 * platform_sessions → refuse revoked, expired, idle or inactive-user sessions → stage check →
 * password gate. It lives here, not in src/common/auth, because only src/modules/platform may use
 * the platform repositories.
 */
@Injectable()
export class PlatformSessionAccess {
  constructor(private readonly sessions: PlatformSessionRepository) {}

  async authorise(req: Request, level: PlatformSessionLevel): Promise<void> {
    // The platform API accepts no bearer token at all, valid or not.
    if (req.headers.authorization !== undefined) throw authRequired();
    const token = readCookie(req, PLATFORM_COOKIE);
    if (!token) throw authRequired();
    const tokenHash = sha256Hex(token);
    const session = await this.sessions.findByTokenHash(tokenHash);
    const now = new Date();
    if (!session || !isLive(session, now)) throw authRequired();

    if (level !== 'any' && session.stage !== 'full') {
      throw new ApiException(403, ErrorCode.TOTP_REQUIRED, 'Set up your authenticator to continue.');
    }
    if (level === 'full' && session.user.mustChangePassword) {
      throw new ApiException(
        403,
        ErrorCode.PASSWORD_CHANGE_REQUIRED,
        'Change your password to continue.',
      );
    }

    // Outside any request transaction: the guard runs before the handler opens one.
    if (now.getTime() - session.lastSeenAt.getTime() >= PLATFORM_SESSION_LIMITS.lastSeenWriteMs) {
      const notBefore = new Date(now.getTime() - PLATFORM_SESSION_LIMITS.lastSeenWriteMs);
      await this.sessions.touch(session.id, now, notBefore);
    }
    bindPlatformSession(req, {
      sessionId: session.id,
      tokenHash,
      stage: session.stage,
      expiresAt: session.expiresAt,
      userId: session.user.id,
      email: session.user.email,
      totpEnrolled: session.user.totpEnrolledAt !== null,
      mustChangePassword: session.user.mustChangePassword,
    });
  }
}

/** Not revoked, before its absolute expiry, within the idle limit (full stage), user active. */
function isLive(session: PlatformSessionWithUser, now: Date): boolean {
  if (session.revokedAt !== null) return false;
  if (session.expiresAt.getTime() <= now.getTime()) return false;
  if (session.user.status !== 'active') return false;
  // The enrolment stage has only its 10-minute absolute expiry; no idle extension.
  if (
    session.stage === 'full' &&
    now.getTime() - session.lastSeenAt.getTime() >= PLATFORM_SESSION_LIMITS.fullIdleMs
  ) {
    return false;
  }
  return true;
}
