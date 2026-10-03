import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { ErrorCode } from '@asms/shared';
import type { Request, Response } from 'express';
import { presentedPlatformTokenHash, sha256Hex } from '../../../common/auth/platform-session';
import { ApiException } from '../../../common/errors/api-exception';
import { normaliseEmail } from '../../../config/env';

// Contract slice-1 §3.1 (login) and §3.5 / §3.6 (confirm, change-password). All counters live in
// Redis through the throttler's own storage, so they hold across API processes. If Redis cannot
// be reached the request is refused with 503: login is never evaluated without its counters.

const MINUTE_MS = 60_000;

interface Limit {
  name: string;
  key: string;
  limit: number;
}

const unavailable = () =>
  new ApiException(503, ErrorCode.SERVICE_UNAVAILABLE, 'The service is temporarily unavailable.');

/** The email as the counters key it: SHA-256 of the normalised address, never the address. */
export const emailKey = (email: string): string => sha256Hex(normaliseEmail(email));

/** Counts one hit against each limit; 429 with Retry-After (seconds) if any is exceeded. */
async function enforce(
  storage: ThrottlerStorage,
  res: Response,
  limits: Limit[],
  logger: Logger,
): Promise<void> {
  let retryAfter = 0;
  for (const { name, key, limit } of limits) {
    let record;
    try {
      record = await storage.increment(`asms:${name}:${key}`, MINUTE_MS, limit, MINUTE_MS, name);
    } catch (error) {
      logger.error({ err: error }, 'rate-limit storage unreachable');
      throw unavailable();
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

/**
 * POST /auth/login: 5/min per email+IP, 10/min per email, 30/min per IP, whether or not the
 * account exists. Reads the raw body (the guard runs before validation); an absent or non-string
 * email is keyed as the empty string, which the IP limit still covers.
 */
@Injectable()
export class LoginThrottleGuard implements CanActivate {
  private readonly logger = new Logger('LoginThrottleGuard');

  constructor(@Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const body: unknown = req.body;
    const email =
      typeof body === 'object' && body !== null && 'email' in body && typeof body.email === 'string'
        ? emailKey(body.email)
        : emailKey('');
    const ip = req.ip ?? 'unknown';
    await enforce(
      this.storage,
      context.switchToHttp().getResponse<Response>(),
      [
        { name: 'platform-login-email-ip', key: `${email}:${ip}`, limit: 5 },
        { name: 'platform-login-email', key: email, limit: 10 },
        { name: 'platform-login-ip', key: ip, limit: 30 },
      ],
      this.logger,
    );
    return true;
  }
}

/** 5/min per session (TOTP confirm, change-password). Runs after the access guard resolved it. */
@Injectable()
export class SessionThrottleGuard implements CanActivate {
  private readonly logger = new Logger('SessionThrottleGuard');

  constructor(@Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const route = `${req.method} ${req.path}`.toLowerCase();
    await enforce(
      this.storage,
      context.switchToHttp().getResponse<Response>(),
      [
        {
          name: 'platform-session-action',
          key: `${sha256Hex(route)}:${presentedPlatformTokenHash(req) ?? 'none'}`,
          limit: 5,
        },
      ],
      this.logger,
    );
    return true;
  }
}

/** 5 consecutive failures for one email lock it for 15 minutes (contract §3.1 step 2). */
export const LOCKOUT = { failures: 5, durationMs: 15 * MINUTE_MS } as const;

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
 * The per-email lockout. It needs plain Redis operations (a success resets the count), so it
 * uses the connection of the throttler's Redis storage; with any other storage (a test double,
 * or the in-memory default) Redis counts as unreachable and login answers 503.
 */
@Injectable()
export class LoginLockout {
  private readonly logger = new Logger('LoginLockout');

  constructor(@Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage) {}

  async isLocked(key: string): Promise<boolean> {
    const result = await this.run('EXISTS', [this.lockKey(key)]);
    return result === 1;
  }

  async recordFailure(key: string): Promise<void> {
    await this.run('EVAL', [
      RECORD_FAILURE,
      '2',
      this.countKey(key),
      this.lockKey(key),
      String(LOCKOUT.durationMs),
      String(LOCKOUT.failures),
    ]);
  }

  /** After a successful login. A lock itself is never cleared by a success (one cannot happen during it). */
  async reset(key: string): Promise<void> {
    await this.run('DEL', [this.countKey(key)]);
  }

  private countKey = (key: string) => `asms:platform-lockout:{${key}}:failures`;
  private lockKey = (key: string) => `asms:platform-lockout:{${key}}:locked`;

  private async run(command: string, args: string[]): Promise<unknown> {
    if (!(this.storage instanceof ThrottlerStorageRedisService)) throw unavailable();
    try {
      return await this.storage.redis.call(command, ...args);
    } catch (error) {
      this.logger.error({ err: error }, 'lockout storage unreachable');
      throw unavailable();
    }
  }
}
