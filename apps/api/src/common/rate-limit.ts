import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  mixin,
  type Type,
} from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { ErrorCode } from '@asms/shared';
import type { Request, Response } from 'express';
import { failureLog } from './errors/failure-log';
import { ApiException } from './errors/api-exception';
import { SchoolContext } from './school-context';

// The rate limits and lockouts of the auth routes and the guardian lookup. Every counter lives in
// Redis through the throttler's own storage, so it holds across API processes. Redis unreachable
// is 503: a guarded action is never evaluated without its counters.

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;

/**
 * One counter: `limit` hits per `ttlMs`, stored at `asms:${name}:${key}`. `cost` (default 1) is
 * how many hits this request counts for.
 */
export interface RateLimit {
  name: string;
  key: string;
  limit: number;
  ttlMs: number;
  cost?: number;
}

export const storageUnavailable = (): ApiException =>
  new ApiException(503, ErrorCode.SERVICE_UNAVAILABLE, 'The service is temporarily unavailable.');

/** Counts `cost` hits against each limit; 429 with Retry-After (seconds) if any is exceeded. */
export async function enforceRateLimits(
  storage: ThrottlerStorage,
  res: Response,
  limits: readonly RateLimit[],
  logger: Logger,
): Promise<void> {
  let retryAfter = 0;
  for (const { name, key, limit, ttlMs, cost = 1 } of limits) {
    // Once one limit refuses, the later limits are not charged: a refused retry must not burn the
    // hour budget for work that was never done.
    if (retryAfter > 0) break;
    // The storage counts one hit per call, so a request costing several calls it that often,
    // stopping once the limit blocks.
    for (let spent = 0; spent < cost; spent++) {
      let record;
      try {
        record = await storage.increment(`asms:${name}:${key}`, ttlMs, limit, ttlMs, name);
      } catch (error) {
        logger.error(failureLog(error), 'rate-limit storage unreachable');
        throw storageUnavailable();
      }
      if (record.isBlocked) {
        retryAfter = Math.max(retryAfter, record.timeToBlockExpire, 1);
        break;
      }
    }
  }
  if (retryAfter > 0) {
    // The plain header, whatever the limit's name: the global throttler's named limits would
    // write Retry-After-<name>, which no client reads.
    res.setHeader('Retry-After', String(retryAfter));
    throw new ApiException(429, ErrorCode.RATE_LIMITED, 'Too many requests. Try again shortly.');
  }
}

/** How many hits a request counts for. Reads the raw body: guards run before validation. */
export type RequestCost = (req: Request) => number;

/**
 * A route guard counting `perMinute` and `perHour` hits per school user under `${name}-minute`
 * and `${name}-hour`. Guards built with the same name share one bucket, whichever route they
 * guard. `cost` says how many hits a request counts for (default one; 0 means it does not count).
 * Runs after the access guard, so it is only reached with a session. Call once per guard, at
 * module level.
 */
export function perUserThrottle(
  name: string,
  perMinute: number,
  perHour: number,
  cost: RequestCost = () => 1,
): Type<CanActivate> {
  @Injectable()
  class PerUserThrottleGuard implements CanActivate {
    private readonly logger = new Logger(`${name}-throttle`);

    constructor(
      @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
      private readonly context: SchoolContext,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
      const http = context.switchToHttp();
      const hits = cost(http.getRequest<Request>());
      if (hits <= 0) return true;
      const { schoolId, userId } = this.context.actor();
      const key = `${schoolId}:${userId}`;
      await enforceRateLimits(
        this.storage,
        http.getResponse<Response>(),
        [
          { name: `${name}-minute`, key, limit: perMinute, ttlMs: MINUTE_MS, cost: hits },
          { name: `${name}-hour`, key, limit: perHour, ttlMs: HOUR_MS, cost: hits },
        ],
        this.logger,
      );
      return true;
    }
  }
  // mixin: a unique class name per guard, so two guards from this factory never share a token.
  return mixin(PerUserThrottleGuard);
}

/**
 * One per-user budget for every route that can tell its caller whether an identity number (a
 * B-Form or a CNIC) exists in the school: the lookups, admission and a B-Form patch
 * (contracts/slice-5.md §3.6, slice-6.md §3.4). 30 a minute and 300 an hour in all, so spreading
 * probes across routes gains nothing. The budget is per identity number, not per request: `cost`
 * counts the numbers one request can test (default one).
 */
export const identityProbeThrottle = (cost?: RequestCost): Type<CanActivate> =>
  perUserThrottle('identity-probe', 30, 300, cost);

/** The lookups test one number per request. */
export const IdentityProbeThrottleGuard = identityProbeThrottle();

/** True when the JSON body has `field` as a string (a value to check, not a clearing null). */
export const bodyHasString =
  (field: string) =>
  (req: Request): boolean => {
    const body: unknown = req.body;
    return (
      typeof body === 'object' &&
      body !== null &&
      field in body &&
      typeof Reflect.get(body, field) === 'string'
    );
  };

/** One hit when the JSON body has `field` as a string, otherwise none. */
export const oneIfBodyHasString =
  (field: string): RequestCost =>
  (req) =>
    bodyHasString(field)(req) ? 1 : 0;

/** Guardian and staff create and patch: only a body carrying a CNIC can answer *_CNIC_EXISTS. */
export const CnicProbeThrottleGuard = identityProbeThrottle(oneIfBodyHasString('cnic'));

/** `failures` consecutive failures for one key lock it for `durationMs`. */
export interface LockoutPolicy {
  failures: number;
  durationMs: number;
}

// Atomic: count the failure and, at the threshold, set the lock and clear the count.
const RECORD_FAILURE = `
local n = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[1])
if n >= tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[1])
  redis.call('DEL', KEYS[1])
end
return n`;

/**
 * A consecutive-failure lockout under `asms:${prefix}:{key}`. It needs plain Redis operations
 * (a success resets the count), so it uses the connection of the throttler's Redis storage; with
 * any other storage (a test double, or the in-memory default) Redis counts as unreachable (503).
 */
export class RedisLockout {
  constructor(
    private readonly storage: ThrottlerStorage,
    private readonly prefix: string,
    private readonly policy: LockoutPolicy,
    private readonly logger: Logger,
  ) {}

  async isLocked(key: string): Promise<boolean> {
    return (await this.run('EXISTS', [this.lockKey(key)])) === 1;
  }

  async recordFailure(key: string): Promise<void> {
    await this.run('EVAL', [
      RECORD_FAILURE,
      '2',
      this.countKey(key),
      this.lockKey(key),
      String(this.policy.durationMs),
      String(this.policy.failures),
    ]);
  }

  /** After a successful login: the consecutive-failure count only, never a lock. */
  async resetCount(key: string): Promise<void> {
    await this.run('DEL', [this.countKey(key)]);
  }

  /** The count and the lock. */
  async clear(key: string): Promise<void> {
    await this.run('DEL', [this.countKey(key), this.lockKey(key)]);
  }

  /** One Redis command on the throttler storage's connection; 503 if it cannot run. */
  protected async run(command: string, args: string[]): Promise<unknown> {
    if (!(this.storage instanceof ThrottlerStorageRedisService)) throw storageUnavailable();
    try {
      return await this.storage.redis.call(command, ...args);
    } catch (error) {
      this.logger.error(failureLog(error), 'lockout storage unreachable');
      throw storageUnavailable();
    }
  }

  private countKey = (key: string) => `asms:${this.prefix}:{${key}}:failures`;
  private lockKey = (key: string) => `asms:${this.prefix}:{${key}}:locked`;
}
