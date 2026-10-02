import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ErrorCode } from '@asms/shared';
import { ApiException } from './errors/api-exception';

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
    next(new ApiException(404, ErrorCode.NOT_FOUND, 'Not found.'));
    return;
  }
  next();
}

/**
 * Routes allowed to receive a non-JSON body, as `METHOD /path`. Empty until slice 6 adds
 * `POST /api/v1/uploads` (multipart).
 */
export const NON_JSON_BODY_ROUTES: ReadonlySet<string> = new Set<string>();

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
