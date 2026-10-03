import type { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { ErrorCode } from '@asms/shared';
import type { Response } from 'express';
import { ApiException } from './errors/api-exception';

// The rate limits and lockouts of the auth routes and the guardian lookup. Every counter lives in
// Redis through the throttler's own storage, so it holds across API processes. Redis unreachable
// is 503: a guarded action is never evaluated without its counters.

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;

/** One counter: `limit` hits per `ttlMs`, stored at `asms:${name}:${key}`. */
export interface RateLimit {
  name: string;
  key: string;
  limit: number;
  ttlMs: number;
}

export const storageUnavailable = (): ApiException =>
  new ApiException(503, ErrorCode.SERVICE_UNAVAILABLE, 'The service is temporarily unavailable.');

/** Counts one hit against each limit; 429 with Retry-After (seconds) if any is exceeded. */
export async function enforceRateLimits(
  storage: ThrottlerStorage,
  res: Response,
  limits: readonly RateLimit[],
  logger: Logger,
): Promise<void> {
  let retryAfter = 0;
  for (const { name, key, limit, ttlMs } of limits) {
    let record;
    try {
      record = await storage.increment(`asms:${name}:${key}`, ttlMs, limit, ttlMs, name);
    } catch (error) {
      logger.error({ err: error }, 'rate-limit storage unreachable');
      throw storageUnavailable();
    }
    if (record.isBlocked) retryAfter = Math.max(retryAfter, record.timeToBlockExpire, 1);
  }
  if (retryAfter > 0) {
    // The plain header, whatever the limit's name: the global throttler's named limits would
    // write Retry-After-<name>, which no client reads.
    res.setHeader('Retry-After', String(retryAfter));
    throw new ApiException(429, ErrorCode.RATE_LIMITED, 'Too many requests. Try again shortly.');
  }
}

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
      this.logger.error({ err: error }, 'lockout storage unreachable');
      throw storageUnavailable();
    }
  }

  private countKey = (key: string) => `asms:${this.prefix}:{${key}}:failures`;
  private lockKey = (key: string) => `asms:${this.prefix}:{${key}}:locked`;
}
