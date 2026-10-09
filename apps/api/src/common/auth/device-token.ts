import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ErrorCode } from '@asms/shared';
import type { Request } from 'express';
import type { SchoolId } from '../../tenancy/school-id';
import { ApiException } from '../errors/api-exception';
import { sha256Hex } from './platform-session';
import { BEARER_TOKEN } from './school-session';

// Biometric device routes (Phase 5 rule 40, phase-5-extended.md §3.1, §5 slice 44; R344, R348):
// `@DeviceToken()` routes carry no session. The device sends the school's device token as a bearer
// token; its sha-256 names the school (DeviceTokenRepository, named exception 4 widened). Resolution
// is DevicePunchService.authorise (src/modules/staff-attendance/device-punch.service.ts), called by
// RouteAccessGuard; this file holds the request side: the presented credential, the per-request
// store and the handler's decorator.

/** 401: the only answer to a missing, malformed, unknown or rotated-out token (no detail). */
export const deviceTokenInvalid = (): ApiException =>
  new ApiException(401, ErrorCode.DEVICE_TOKEN_INVALID, 'The device token is not valid.');

/**
 * The presented device token's hash, or null when the request does not present exactly one well
 * formed token: `Authorization: Bearer <43 base64url characters>` (32 random bytes), with no
 * cookie and no `Origin` header (a device is not a browser page, R170's rule for bearer tokens).
 */
export function presentedDeviceTokenHash(req: Request): string | null {
  const header = req.headers.authorization;
  if (header === undefined || req.headers.cookie !== undefined || req.headers.origin !== undefined) return null;
  const token = /^Bearer (.+)$/.exec(header)?.[1];
  return token !== undefined && BEARER_TOKEN.test(token) ? sha256Hex(token) : null;
}

/** What a @DeviceToken() handler receives: the school the token named. */
export interface DeviceContext {
  readonly schoolId: SchoolId;
}

// Keyed by the request object, so nothing from the client can reach it.
const resolved = new WeakMap<Request, DeviceContext>();

/** Records the school a request's device token resolved to. Called only by DevicePunchService.authorise. */
export function bindDeviceContext(req: Request, context: DeviceContext): void {
  resolved.set(req, context);
}

/**
 * The device's school, for handlers declared with @DeviceToken(). Asking for it elsewhere is a
 * programming error (500), never a silent null.
 */
export const CurrentDevice = createParamDecorator(
  (_data: unknown, context: ExecutionContext): DeviceContext => {
    const device = resolved.get(context.switchToHttp().getRequest<Request>());
    if (!device) throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    return device;
  },
);
