import { Inject, Injectable, Logger } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ErrorCode } from '@asms/shared';
import type { Request, Response } from 'express';
import {
  bindDeviceContext,
  deviceTokenInvalid,
  presentedDeviceTokenHash,
} from '../../common/auth/device-token';
import { ApiException } from '../../common/errors/api-exception';
import { enforceRateLimits, HOUR_MS, MINUTE_MS, RedisLockout } from '../../common/rate-limit';
import { DeviceTokenRepository } from '../../repositories/platform/device-token.repository';
import { schoolIdFromDeviceToken } from '../../tenancy/school-id.mint';

/**
 * The per-IP bad-token bucket (contracts/slice-44.md §1, slice-37.md §9): 10 refused tokens from
 * one address within a minute lock the address out of the device route for 15 minutes.
 */
export const DEVICE_TOKEN_LOCKOUT = { failures: 10, windowMs: MINUTE_MS, durationMs: 15 * MINUTE_MS } as const;

/** Per school, after the token resolved (§5.1): 600 requests an hour, whatever their size. */
export const DEVICE_PUNCHES_PER_HOUR = 600;

/** Keyed `asms:device-token-ip:{ip}`; with a storage other than Redis the route answers 503. */
@Injectable()
export class DeviceTokenLockout extends RedisLockout {
  constructor(@Inject(ThrottlerStorage) storage: ThrottlerStorage) {
    super(storage, 'device-token-ip', DEVICE_TOKEN_LOCKOUT, new Logger('DeviceTokenLockout'));
  }
}

const lockedOut = (res: Response | undefined): ApiException => {
  res?.setHeader('Retry-After', String(DEVICE_TOKEN_LOCKOUT.durationMs / 1000));
  return new ApiException(429, ErrorCode.RATE_LIMITED, 'Too many requests. Try again shortly.');
};

/**
 * Biometric staff attendance (Phase 5 rule 40, phase-5-extended.md §3.1; R344, R348). This file is
 * the named-exception site of the widened exception 4: the only importer of DeviceTokenRepository
 * and of schoolIdFromDeviceToken, and it imports no tenant repository (eslint.config.mjs, fixtures
 * in test/fixtures/lint). RouteAccessGuard calls authorise() for every @DeviceToken() route; the
 * handler then hands the bound school to PunchIntakeService, which reaches the tenant tables
 * through its own repositories (contracts/slice-44.md §2.2, §5).
 */
@Injectable()
export class DevicePunchService {
  private readonly logger = new Logger('DevicePunchService');

  constructor(
    private readonly tokens: DeviceTokenRepository,
    private readonly lockout: DeviceTokenLockout,
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
  ) {}

  /**
   * In order: the address's lockout (429, before the token is even read), the token (a missing,
   * malformed, unknown or rotated-out token, or a terminated school, is the one 401
   * DEVICE_TOKEN_INVALID with no further detail, and counts a failure against the address), then
   * the school's hourly bucket (429). A suspended school's device works, like its sessions (R80
   * lifted). The token itself is never logged.
   */
  async authorise(req: Request): Promise<void> {
    const ip = req.ip ?? 'unknown';
    if (await this.lockout.isLocked(ip)) throw lockedOut(req.res);
    const hash = presentedDeviceTokenHash(req);
    const school = hash === null ? null : await this.tokens.findByTokenHash(hash);
    if (school === null || school.status === 'terminated') {
      await this.lockout.recordFailure(ip);
      throw deviceTokenInvalid();
    }
    const schoolId = schoolIdFromDeviceToken(school);
    // Express always links the response; without it the bucket could not answer, so fail closed.
    if (req.res === undefined) throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    await enforceRateLimits(
      this.storage,
      req.res,
      [{ name: 'device-punches-hour', key: schoolId.toString(), limit: DEVICE_PUNCHES_PER_HOUR, ttlMs: HOUR_MS }],
      this.logger,
    );
    bindDeviceContext(req, { schoolId });
  }
}

/** For AppModule: RouteAccessGuard (an APP_GUARD) injects DevicePunchService. */
export const DEVICE_PUNCH_ACCESS_PROVIDERS = [DevicePunchService, DeviceTokenRepository, DeviceTokenLockout];
