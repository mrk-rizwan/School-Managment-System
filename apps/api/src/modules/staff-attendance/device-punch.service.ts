import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import {
  bindDeviceContext,
  deviceTokenInvalid,
  presentedDeviceTokenHash,
} from '../../common/auth/device-token';
import { DeviceTokenRepository } from '../../repositories/platform/device-token.repository';
import { schoolIdFromDeviceToken } from '../../tenancy/school-id.mint';

/**
 * Biometric staff attendance (Phase 5 rule 40, phase-5-extended.md §3.1; R344, R348). This file is
 * the named-exception site of the widened exception 4: the only importer of DeviceTokenRepository
 * and of schoolIdFromDeviceToken, and it imports no tenant repository (eslint.config.mjs, fixtures
 * in test/fixtures/lint). The groundwork holds the token half only: RouteAccessGuard calls
 * authorise() for every @DeviceToken() route. Slice 44 adds the punch handling, which reaches the
 * tenant tables through services, never from here.
 */
@Injectable()
export class DevicePunchService {
  constructor(private readonly tokens: DeviceTokenRepository) {}

  /**
   * Resolves the request's device token to its school and binds it (CurrentDevice). A missing,
   * malformed, unknown or rotated-out token, or a terminated school, is 401 DEVICE_TOKEN_INVALID
   * with no further detail. A suspended school's device works, like its sessions (R80 lifted).
   */
  async authorise(req: Request): Promise<void> {
    const hash = presentedDeviceTokenHash(req);
    if (hash === null) throw deviceTokenInvalid();
    const school = await this.tokens.findByTokenHash(hash);
    if (school === null || school.status === 'terminated') throw deviceTokenInvalid();
    bindDeviceContext(req, { schoolId: schoolIdFromDeviceToken(school) });
  }
}

/** For AppModule: RouteAccessGuard (an APP_GUARD) injects DevicePunchService. */
export const DEVICE_PUNCH_ACCESS_PROVIDERS = [DevicePunchService, DeviceTokenRepository];
