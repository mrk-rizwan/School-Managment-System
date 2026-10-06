import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { APP_VERSION_PATTERN, ErrorCode } from '@asms/shared';
import { ApiException, notFound } from './errors/api-exception';

export const API_PREFIX = 'api/v1';

/**
 * Sets the request id and Cache-Control: no-store. Runs first, before the body parser, so even a request that dies parsing its body has a
 * requestId and the envelope. The id is always ours: a client-sent X-Request-Id is ignored.
 */
export function requestIdAndNoStore(req: Request, res: Response, next: NextFunction): void {
  req.id = randomUUID();
  res.setHeader('X-Request-Id', req.id);
  // Responses carry tenant data; no browser or proxy may keep a copy.
  res.setHeader('Cache-Control', 'no-store');
  // Nest's not-found handler only covers the global prefix; everything outside it is ours to refuse.
  if (!req.path.startsWith('/api/')) {
    next(notFound());
    return;
  }
  next();
}

/**
 * Routes allowed to receive a non-JSON body, as `METHOD /path`. The multipart routes are
 * `POST /api/v1/uploads` (contracts/slice-6.md §6.1) and the guardian's own, `POST /api/v1/me/uploads`
 * (contracts/slice-21.md §1).
 */
export const NON_JSON_BODY_ROUTES: ReadonlySet<string> = new Set([
  `POST /${API_PREFIX}/uploads`,
  `POST /${API_PREFIX}/me/uploads`,
]);

/** 415 for any state-changing request whose body is not JSON. A bodiless POST is fine. */
export function requireJsonBody(req: Request, _res: Response, next: NextFunction): void {
  const hasBody =
    req.headers['transfer-encoding'] !== undefined ||
    (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0');
  if (
    hasBody &&
    req.method !== 'GET' &&
    req.method !== 'HEAD' &&
    !req.is('application/json') &&
    !NON_JSON_BODY_ROUTES.has(`${req.method} ${req.path}`)
  ) {
    next(new ApiException(415, ErrorCode.UNSUPPORTED_MEDIA_TYPE, 'Send the request body as application/json.'));
    return;
  }
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PLATFORM_PATH = `/${API_PREFIX}/platform/`;
const WEBHOOK_PATH = `/${API_PREFIX}/webhooks/`;
const HEALTH_PATH = `/${API_PREFIX}/health`;

/**
 * R65, R170 / contract slice-1 §1, slice-9 §1.3: a state-changing request that a browser could
 * have been tricked into sending must carry `Origin` exactly equal to the origin of APP_URL;
 * missing or different is 403 ORIGIN_REJECTED. Applies to every non-GET under /platform (the
 * platform API accepts no bearer and no app header), and to every school non-GET that carries
 * neither `Authorization` nor `X-App-Version` (the public auth routes included: login CSRF). A
 * browser cannot send either header cross-origin without a CORS preflight, which the API never
 * answers. Webhooks are exempt: their signature is their check. The reverse rule (a bearer token
 * together with `Origin` is refused) is in session resolution.
 */
export function originCheck(appUrl: string) {
  const allowed = new URL(appUrl).origin;
  return (req: Request, _res: Response, next: NextFunction): void => {
    // Lower-cased: Express matches routes case-insensitively, so /API/v1/Platform/... reaches them.
    const path = req.path.toLowerCase();
    if (SAFE_METHODS.has(req.method) || path.startsWith(WEBHOOK_PATH)) {
      next();
      return;
    }
    const platform = path.startsWith(PLATFORM_PATH);
    const appClient =
      req.headers.authorization !== undefined || req.headers['x-app-version'] !== undefined;
    if ((platform || !appClient) && req.headers.origin !== allowed) {
      next(new ApiException(403, ErrorCode.ORIGIN_REJECTED, 'This request came from an unexpected origin.'));
      return;
    }
    next();
  };
}

/** `1.4.12` → [1, 4, 12]; null unless it matches APP_VERSION_PATTERN. */
export function parseAppVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== 'string' || !APP_VERSION_PATTERN.test(value)) return null;
  const [major = 0, minor = 0, patch = 0] = value.split('.').map(Number);
  return [major, minor, patch];
}

/** Compares left to right: negative when `a` is below `b`. */
const compareVersions = (a: readonly number[], b: readonly number[]): number =>
  a.reduce((result, part, i) => (result !== 0 ? result : part - (b[i] ?? 0)), 0);

/**
 * R161 / contract slice-9 §1.4: the mobile app-version floor, before session resolution. Every
 * request carrying `Authorization: Bearer` or `X-App-Version` must send a well-formed version at
 * or above MOBILE_MIN_APP_VERSION; a bearer request without the header is below every floor.
 * Otherwise 426 UPGRADE_REQUIRED with details.minimumVersion, and nothing is read or counted.
 * Cookie clients (neither header), /health and webhooks are exempt.
 */
export function appVersionFloor(minimumVersion: string) {
  const floor = parseAppVersion(minimumVersion);
  if (floor === null) throw new Error('MOBILE_MIN_APP_VERSION is not a version');
  return (req: Request, _res: Response, next: NextFunction): void => {
    const path = req.path.toLowerCase();
    const header = req.headers['x-app-version'];
    const bearer = /^bearer\b/i.test(req.headers.authorization ?? '');
    if (
      (header === undefined && !bearer) ||
      path === HEALTH_PATH ||
      path.startsWith(WEBHOOK_PATH)
    ) {
      next();
      return;
    }
    const version = parseAppVersion(header);
    if (version === null || compareVersions(version, floor) < 0) {
      next(
        new ApiException(
          426,
          ErrorCode.UPGRADE_REQUIRED,
          'This version of the app is no longer supported. Update the app to continue.',
          { minimumVersion },
        ),
      );
      return;
    }
    next();
  };
}
