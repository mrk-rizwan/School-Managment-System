import { type CanActivate, type ExecutionContext, Inject, Injectable, Logger, mixin, type Type } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ErrorCode } from '@asms/shared';
import type { Request, Response } from 'express';
import { platformSessionOf, type PlatformSessionContext } from '../../../common/auth/platform-session';
import { ApiException, notFound } from '../../../common/errors/api-exception';
import { isIdString } from '../../../common/ids';
import { enforceRateLimits, HOUR_MS, MINUTE_MS } from '../../../common/rate-limit';
import { SupportSessionsService } from './support-sessions.service';

// Phase 5 slice 45 (contracts/slice-45.md §1). Both guards run after RouteAccessGuard (a global
// guard), which has resolved the platform session (@PlatformSession('full')).

function callerOf(req: Request): PlatformSessionContext {
  const session = platformSessionOf(req);
  // Reached only behind @PlatformSession; anything else is a wiring error, refused closed.
  if (!session) throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
  return session;
}

/**
 * `perMinute` and `perHour` hits per platform user (the school-side perUserThrottle reads a school
 * session, which a platform route has none of): `support-reads` 120/2000 (§5.1), `support-open`.
 */
export function platformUserThrottle(name: string, perMinute: number, perHour: number): Type<CanActivate> {
  @Injectable()
  class PlatformUserThrottleGuard implements CanActivate {
    private readonly logger = new Logger(`${name}-throttle`);

    constructor(@Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
      const http = context.switchToHttp();
      const key = `platform:${callerOf(http.getRequest<Request>()).userId}`;
      await enforceRateLimits(
        this.storage,
        http.getResponse<Response>(),
        [
          { name: `${name}-minute`, key, limit: perMinute, ttlMs: MINUTE_MS },
          { name: `${name}-hour`, key, limit: perHour, ttlMs: HOUR_MS },
        ],
        this.logger,
      );
      return true;
    }
  }
  return mixin(PlatformUserThrottleGuard);
}

/** phase-5-extended.md §5.1: every support view. */
export const SupportReadsThrottleGuard = platformUserThrottle('support-reads', 120, 2000);
/** Opening needs a fresh TOTP: few attempts, so a stolen cookie cannot guess codes. */
export const SupportOpenThrottleGuard = platformUserThrottle('support-open', 5, 20);

/**
 * R352: the `:id` support session is open and the caller's own. Another admin's session or an
 * unknown id is 404 (its existence is not the caller's business); closed, revoked or past its time
 * is 403 SUPPORT_SESSION_ENDED { reason }. The read re-checks inside its own transaction, so a
 * revoke landing between the two still ends the read.
 */
@Injectable()
export class SupportSessionGuard implements CanActivate {
  constructor(private readonly sessions: SupportSessionsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const id: unknown = req.params.id;
    if (!isIdString(id)) throw notFound();
    await this.sessions.assertOpenOwned(callerOf(req).userId, BigInt(id));
    return true;
  }
}
