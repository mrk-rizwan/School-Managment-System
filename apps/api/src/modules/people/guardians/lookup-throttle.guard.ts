import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { Response } from 'express';
import { enforceRateLimits, HOUR_MS, MINUTE_MS } from '../../../common/rate-limit';
import { SchoolContext } from '../../../common/school-context';

// POST /guardians/lookup is a CNIC existence oracle (contracts/slice-5.md §3.6): 30 per minute and
// 300 per hour per user, counted in Redis through the throttler's storage so the limit holds across
// API processes. Runs as a route guard, after the access guard has resolved the session.

@Injectable()
export class GuardianLookupThrottleGuard implements CanActivate {
  private readonly logger = new Logger('GuardianLookupThrottleGuard');

  constructor(
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
    private readonly context: SchoolContext,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // The access guard runs first and fails closed; this is only reachable with a session.
    const { schoolId, userId } = this.context.actor();
    const key = `${schoolId}:${userId}`;
    await enforceRateLimits(
      this.storage,
      context.switchToHttp().getResponse<Response>(),
      [
        { name: 'guardian-lookup-minute', key, limit: 30, ttlMs: MINUTE_MS },
        { name: 'guardian-lookup-hour', key, limit: 300, ttlMs: HOUR_MS },
      ],
      this.logger,
    );
    return true;
  }
}
