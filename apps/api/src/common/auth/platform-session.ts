import { createHash, randomBytes } from 'node:crypto';
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ErrorCode } from '@asms/shared';
import type { Request, Response } from 'express';
import { ApiException } from '../errors/api-exception';

// Platform-admin sessions (contracts/slice-1.md §1, §2): the cookie, the token, the limits and
// the per-request store. Resolution itself (which needs the platform repositories) is
// PlatformSessionAccess in src/modules/platform/auth. Separate from school sessions in every
// respect: its own cookie, its own table, its own request store. Nothing here touches the school
// RequestContext or SessionEstablisher, and nothing here reads the school cookie (R56).

/** The platform cookie. `__Host-` makes the browser refuse it without Secure, with a Domain or off Path=/. */
export const PLATFORM_COOKIE = '__Host-asms_platform';
const COOKIE_ATTRIBUTES = 'HttpOnly; Secure; SameSite=Strict; Path=/';

/** The two session stages (contract §2); the OpenAPI enum and the repository use this list. */
export const PLATFORM_SESSION_STAGES = ['totp_enrolment', 'full'] as const;
export type PlatformSessionStage = (typeof PLATFORM_SESSION_STAGES)[number];

/** Contract §2. */
export const PLATFORM_SESSION_LIMITS = {
  /** Absolute lifetime of a password-only session that may only enrol the authenticator. */
  enrolmentAbsoluteMs: 10 * 60_000,
  fullIdleMs: 2 * 60 * 60_000,
  fullAbsoluteMs: 12 * 60 * 60_000,
  /** last_seen_at is written at most this often. */
  lastSeenWriteMs: 5 * 60_000,
} as const;

/** What a platform handler receives for the caller. */
export interface PlatformSessionContext {
  sessionId: bigint;
  /** SHA-256 hex of the presented token. */
  tokenHash: string;
  stage: PlatformSessionStage;
  expiresAt: Date;
  userId: bigint;
  email: string;
  totpEnrolled: boolean;
  mustChangePassword: boolean;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** A new session token (32 random bytes, base64url) and the hash that is all the database keeps. */
export function newSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: sha256Hex(token) };
}

/**
 * The value of one cookie from the Cookie header, or undefined. A name sent twice is treated as
 * absent: a second copy can only come from a cookie planted by something other than this API.
 */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  const values = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return values.length === 1 ? values[0] : undefined;
}

export function setPlatformCookie(res: Response, token: string): void {
  // No Max-Age: a browser-session cookie. The server enforces expiry.
  res.setHeader('Set-Cookie', `${PLATFORM_COOKIE}=${token}; ${COOKIE_ATTRIBUTES}`);
}

export function clearPlatformCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${PLATFORM_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`);
}

/** The SHA-256 of the platform cookie presented with the request, if any. */
export function presentedPlatformTokenHash(req: Request): string | undefined {
  const token = readCookie(req, PLATFORM_COOKIE);
  return token ? sha256Hex(token) : undefined;
}

// The resolved platform session per request. A WeakMap keyed by the request object, not a
// property on it: nothing from the client can reach it, and it needs no type augmentation.
const resolved = new WeakMap<Request, PlatformSessionContext>();

/** Records the session resolved for this request. Called only by PlatformSessionAccess. */
export function bindPlatformSession(req: Request, session: PlatformSessionContext): void {
  resolved.set(req, session);
}

/**
 * The caller's platform session, for handlers declared with @PlatformSession. A handler without
 * that decorator has none, and asking for it is a programming error (500), never a silent null.
 */
export const CurrentPlatformSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): PlatformSessionContext => {
    const session = resolved.get(context.switchToHttp().getRequest<Request>());
    if (!session) {
      throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    }
    return session;
  },
);
