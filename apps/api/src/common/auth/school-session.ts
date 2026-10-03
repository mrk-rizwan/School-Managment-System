import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ErrorCode, type SchoolStatus } from '@asms/shared';
import type { Request, Response } from 'express';
import type { SchoolId } from '../../tenancy/school-id';
import type { Scope } from '../../tenancy/scope';
import type { UserAccess } from '../../modules/access/permissions.service';
import { ApiException } from '../errors/api-exception';
import { readCookie, sha256Hex } from './platform-session';

// School sessions (contracts/slice-2.md §1, plan §3.5): the cookie, the limits and the
// per-request store. Resolution itself is SchoolSessionResolver in src/tenancy (named exception
// 4). Nothing here reads the platform cookie or platform_sessions (R56).

/** The school cookie. `__Host-` makes the browser refuse it without Secure, a Domain or Path=/. */
export const SCHOOL_COOKIE = '__Host-asms_session';
const COOKIE_ATTRIBUTES = 'HttpOnly; Secure; SameSite=Lax; Path=/';

/** A bearer token is exactly a base64url 32-byte token. */
export const BEARER_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const SCHOOL_SESSION_LIMITS = {
  idleMs: 24 * 60 * 60_000,
  absoluteMs: 30 * 24 * 60 * 60_000,
  /** last_seen_at is written at most this often. */
  lastSeenWriteMs: 5 * 60_000,
} as const;

export type SessionChannelName = 'cookie' | 'bearer';

const DAY_MS = 24 * 60 * 60_000;

/**
 * Session lifetimes per channel and capacity (contracts/slice-9.md §1.5, R154). Cookie sessions
 * keep slice 2's 24 h idle / 30 d absolute. Bearer sessions: a login holding staff capacity gets
 * 14 d / 90 d (a lost teacher phone writes registers); guardian and student only, 30 d / 180 d.
 * The absolute lifetime is chosen at mint and stored in expires_at; idle is computed at every
 * resolution from the capacities then held, so gaining staff capacity tightens it at once.
 * Push resolution uses the same idle window (DeviceRepository.liveForUsers).
 */
export function sessionLifetime(
  channel: SessionChannelName,
  capacities: { readonly staff: boolean },
): { idleMs: number; absoluteMs: number } {
  if (channel === 'cookie') {
    return { idleMs: SCHOOL_SESSION_LIMITS.idleMs, absoluteMs: SCHOOL_SESSION_LIMITS.absoluteMs };
  }
  return capacities.staff
    ? { idleMs: 14 * DAY_MS, absoluteMs: 90 * DAY_MS }
    : { idleMs: 30 * DAY_MS, absoluteMs: 180 * DAY_MS };
}

/** What a school handler receives for the caller (built by SchoolSessionResolver). */
export interface SchoolSessionContext {
  schoolId: SchoolId;
  sessionId: bigint;
  tokenHash: string;
  channel: SessionChannelName;
  expiresAt: Date;
  school: { id: bigint; name: string; shortCode: string; status: SchoolStatus };
  /** Capacities and effective capabilities, computed from the database for this request (R69). */
  access: UserAccess;
}

/**
 * The presented credential: cookie or bearer, never both (contract slice-2 §1.1 step 1). A bearer
 * token sent with an `Origin` header is refused too (contracts/slice-9.md §1.3, R170): a script
 * running in a browser page can neither use nor mint a long-lived token.
 */
export type PresentedToken =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: SessionChannelName; token: string; tokenHash: string };

export function presentedSchoolToken(req: Request): PresentedToken {
  const header = req.headers.authorization;
  const cookieToken = readCookie(req, SCHOOL_COOKIE);
  if (header !== undefined) {
    if (cookieToken !== undefined || req.headers.origin !== undefined) return { kind: 'invalid' };
    const match = /^Bearer (.+)$/.exec(header);
    const token = match?.[1];
    if (token === undefined || !BEARER_TOKEN.test(token)) return { kind: 'invalid' };
    return { kind: 'bearer', token, tokenHash: sha256Hex(token) };
  }
  if (cookieToken === undefined || cookieToken === '') return { kind: 'none' };
  return { kind: 'cookie', token: cookieToken, tokenHash: sha256Hex(cookieToken) };
}

export function setSchoolCookie(res: Response, token: string, expiresAt: Date): void {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  res.setHeader('Set-Cookie', `${SCHOOL_COOKIE}=${token}; ${COOKIE_ATTRIBUTES}; Max-Age=${maxAge}`);
}

export function clearSchoolCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${SCHOOL_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`);
}

// The resolved session per request: a WeakMap keyed by the request object, so nothing from the
// client can reach it.
const resolved = new WeakMap<Request, SchoolSessionContext>();

/** Records the session resolved for this request. Called only by SchoolSessionResolver. */
export function bindSchoolSession(req: Request, session: SchoolSessionContext): void {
  resolved.set(req, session);
}

// The row scope the access guard computed on a @RequireCapability route, keyed by the session
// object of that request. A handler cannot take a Scope as a decorated parameter (lint: a
// request-bound parameter never carries a brand), so it takes @CurrentSchoolSession() and the
// service reads the scope with scopeOf(session).
interface GrantedScope {
  readonly scope: Scope;
}
const scopes = new WeakMap<SchoolSessionContext, GrantedScope>();

/** Records the scope the guard computed for this request's session. Called only by RouteAccessGuard. */
export function bindRequestScope(req: Request, scope: Scope): void {
  const session = resolved.get(req);
  if (!session) throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
  scopes.set(session, { scope });
}

/**
 * The row scope the caller's capability gives on this @RequireCapability route (plan §3.4):
 * `{ kind: 'all' }` for school-wide roles, `{ kind: 'sections', ids }` for a teacher, where an
 * empty list means no rows. A service reading student-linked rows requires it and passes it to
 * the repository. Asking for it from any other route's session is a programming error (500).
 */
export function scopeOf(session: SchoolSessionContext): Scope {
  const granted = scopes.get(session);
  if (!granted) throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
  return granted.scope;
}

/**
 * The caller's school session, for handlers declared with @AuthenticatedOnly, @RequireStaff or
 * @RequireCapability. Asking for it elsewhere is a programming error (500), never a silent null.
 */
export const CurrentSchoolSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SchoolSessionContext => {
    const session = resolved.get(context.switchToHttp().getRequest<Request>());
    if (!session) throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    return session;
  },
);
