import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { presentedPlatformTokenHash, sha256Hex } from '../../../common/auth/platform-session';
import {
  enforceRateLimits,
  MINUTE_MS,
  RedisLockout,
  type RateLimit,
} from '../../../common/rate-limit';
import { normaliseEmail } from '../../../config/env';

// Contract slice-1 §3.1 (login) and §3.5 / §3.6 (confirm, change-password). All counters live in
// Redis through the throttler's own storage, so they hold across API processes. If Redis cannot
// be reached the request is refused with 503: login is never evaluated without its counters.

/** The email as the counters key it: SHA-256 of the normalised address, never the address. */
export const emailKey = (email: string): string => sha256Hex(normaliseEmail(email));

/** Every platform limit counts per minute. */
const perMinute = (limits: Omit<RateLimit, 'ttlMs'>[]): RateLimit[] =>
  limits.map((limit) => ({ ...limit, ttlMs: MINUTE_MS }));

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
    await enforceRateLimits(
      this.storage,
      context.switchToHttp().getResponse<Response>(),
      perMinute([
        { name: 'platform-login-email-ip', key: `${email}:${ip}`, limit: 5 },
        { name: 'platform-login-email', key: email, limit: 10 },
        { name: 'platform-login-ip', key: ip, limit: 30 },
      ]),
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
    await enforceRateLimits(
      this.storage,
      context.switchToHttp().getResponse<Response>(),
      perMinute([
        {
          name: 'platform-session-action',
          key: `${sha256Hex(route)}:${presentedPlatformTokenHash(req) ?? 'none'}`,
          limit: 5,
        },
      ]),
      this.logger,
    );
    return true;
  }
}

/** 5 consecutive failures for one email lock it for 15 minutes (contract §3.1 step 2). */
export const LOCKOUT = { failures: 5, durationMs: 15 * MINUTE_MS } as const;

/**
 * The per-email lockout, keyed `asms:platform-lockout:{key}`. With a storage other than Redis
 * login answers 503.
 */
@Injectable()
export class LoginLockout extends RedisLockout {
  constructor(@Inject(ThrottlerStorage) storage: ThrottlerStorage) {
    super(storage, 'platform-lockout', LOCKOUT, new Logger('LoginLockout'));
  }

  /** After a successful login. A lock itself is never cleared by a success (one cannot happen during it). */
  reset(key: string): Promise<void> {
    return this.resetCount(key);
  }
}
