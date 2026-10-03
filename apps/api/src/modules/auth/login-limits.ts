import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { normaliseIdentityDigits } from '@asms/shared';
import type { Request, Response } from 'express';
import { sha256Hex } from '../../common/auth/platform-session';
import { presentedSchoolToken } from '../../common/auth/school-session';
import { identityHash } from '../../common/identity';
import { enforceRateLimits, HOUR_MS, MINUTE_MS, RedisLockout } from '../../common/rate-limit';
import { ENV, type Env } from '../../config/env';

// Contract slice-2 §3 and §4: the school auth limits, the login lockout and the per-school spray
// counter. All live in Redis through the throttler's storage, so they hold across API processes.
// Redis unreachable at any step is 503 (R81): login is never evaluated without its counters.

/** A raw body field as a string, or '' (the guards run before validation). */
function rawField(req: Request, field: string): string {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null) return '';
  const value: unknown = Reflect.get(body, field);
  return typeof value === 'string' ? value : '';
}

/** The typed school code as the DTO normalises it. */
export const normaliseSchoolCode = (code: string): string => code.trim().toLowerCase();

/**
 * Keys the limits and the lockout by the typed school code and the username hash, normalised
 * as the DTO does, so absent schools and users are keyed (and lock) like real ones (R11). The
 * code is hashed into the key: it is user input and must not shape a Redis key.
 */
@Injectable()
export class LoginKeys {
  constructor(@Inject(ENV) private readonly env: Env) {}

  usernameHash(username: string): string {
    const digits = normaliseIdentityDigits(username);
    return digits === null ? '' : identityHash(digits, this.env.IDENTITY_HASH_KEY);
  }

  /** `${typedCode}:${usernameHash}`, the lockout and per-account throttle key (contract §3.1). */
  account(schoolCode: string, usernameHash: string): string {
    return `${sha256Hex(normaliseSchoolCode(schoolCode))}:${usernameHash}`;
  }

  fromBody(req: Request): { account: string; usernameHash: string } {
    const usernameHash = this.usernameHash(rawField(req, 'username'));
    return { account: this.account(rawField(req, 'schoolCode'), usernameHash), usernameHash };
  }
}

/** POST /auth/login: 5/min per code+username+IP, 10/min per username, 30/min per IP. */
@Injectable()
export class SchoolLoginThrottleGuard implements CanActivate {
  private readonly logger = new Logger('SchoolLoginThrottleGuard');

  constructor(
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
    private readonly keys: LoginKeys,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const { account, usernameHash } = this.keys.fromBody(req);
    const ip = req.ip ?? 'unknown';
    await enforceRateLimits(
      this.storage,
      context.switchToHttp().getResponse<Response>(),
      [
        { name: 'school-login-account-ip', key: `${account}:${ip}`, limit: 5, ttlMs: MINUTE_MS },
        { name: 'school-login-username', key: usernameHash, limit: 10, ttlMs: MINUTE_MS },
        { name: 'school-login-ip', key: ip, limit: 30, ttlMs: MINUTE_MS },
      ],
      this.logger,
    );
    return true;
  }
}

/** POST /auth/forgot-password: 3/hour per code+username, 30/min per IP. */
@Injectable()
export class ForgotPasswordThrottleGuard implements CanActivate {
  private readonly logger = new Logger('ForgotPasswordThrottleGuard');

  constructor(
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
    private readonly keys: LoginKeys,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const ip = req.ip ?? 'unknown';
    await enforceRateLimits(
      this.storage,
      context.switchToHttp().getResponse<Response>(),
      [
        {
          name: 'school-forgot-account',
          key: this.keys.fromBody(req).account,
          limit: 3,
          ttlMs: HOUR_MS,
        },
        { name: 'school-forgot-ip', key: ip, limit: 30, ttlMs: MINUTE_MS },
      ],
      this.logger,
    );
    return true;
  }
}

/** POST /auth/reset-password and /auth/verify-email: 10/min per IP. */
@Injectable()
export class TokenThrottleGuard implements CanActivate {
  private readonly logger = new Logger('TokenThrottleGuard');

  constructor(@Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    await enforceRateLimits(
      this.storage,
      context.switchToHttp().getResponse<Response>(),
      [{ name: 'school-token-ip', key: req.ip ?? 'unknown', limit: 10, ttlMs: MINUTE_MS }],
      this.logger,
    );
    return true;
  }
}

/** 5/min per session and route (change-email, change-password). Runs after the access guard. */
@Injectable()
export class SchoolSessionThrottleGuard implements CanActivate {
  private readonly logger = new Logger('SchoolSessionThrottleGuard');

  constructor(@Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const presented = presentedSchoolToken(req);
    const session =
      presented.kind === 'cookie' || presented.kind === 'bearer' ? presented.tokenHash : 'none';
    const route = sha256Hex(`${req.method} ${req.path}`.toLowerCase());
    await enforceRateLimits(
      this.storage,
      context.switchToHttp().getResponse<Response>(),
      [{ name: 'school-session-action', key: `${route}:${session}`, limit: 5, ttlMs: MINUTE_MS }],
      this.logger,
    );
    return true;
  }
}

/** Contract §3.1 step 2: 5 consecutive failures lock the account key for 15 minutes. */
export const LOCKOUT = { failures: 5, durationMs: 15 * MINUTE_MS } as const;
/** Contract §3.1 step 6: per-school failures in a 10-minute window; one audit row at the threshold. */
export const SPRAY = { threshold: 50, windowMs: 10 * MINUTE_MS } as const;

// A fixed window: the first failure starts it and records when.
const COUNT_SCHOOL_FAILURE = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[1])
end
return {n, redis.call('GET', KEYS[2])}`;

/**
 * The login lockout (keyed `asms:school-lockout:{account}`; a password reset, by token or by
 * the office, clears count and lock, R4) and the spray counter. Both use the throttler storage's
 * Redis connection; with any other storage Redis counts as unreachable (503).
 */
@Injectable()
export class SchoolLoginLockout extends RedisLockout {
  constructor(@Inject(ThrottlerStorage) storage: ThrottlerStorage) {
    super(storage, 'school-lockout', LOCKOUT, new Logger('SchoolLoginLockout'));
  }

  /** Counts one failed login against a resolved school; the count and when its window started. */
  async countSchoolFailure(
    schoolId: bigint,
    now: Date,
  ): Promise<{ failures: number; windowStartedAt: string }> {
    const result = await this.run('EVAL', [
      COUNT_SCHOOL_FAILURE,
      '2',
      `asms:school-login-spray:{${schoolId}}:count`,
      `asms:school-login-spray:{${schoolId}}:started`,
      String(SPRAY.windowMs),
      now.toISOString(),
    ]);
    const [count, started] = Array.isArray(result) ? (result as unknown[]) : [];
    return {
      failures: typeof count === 'number' ? count : 0,
      windowStartedAt: typeof started === 'string' ? started : now.toISOString(),
    };
  }
}
