import createClient, { type Middleware } from 'openapi-fetch';
import { ApiError, ErrorCode, toApiError } from '@asms/shared';
import { readAppVersion } from '../platform/app-version';
import { apiUrl } from '../platform/config';
import type { paths } from './school';

// The one openapi-fetch client and the only caller of the global fetch (lint). Every request
// carries X-App-Version and Accept, and the bearer token when signed in; never a cookie
// (credentials: 'omit') and never an Origin header (R170). A 401 that is not a failed login, and
// any 426, are routed to the session layer (slice-15 §2.5, §6).

export const READ_TIMEOUT_MS = 20_000;
export const WRITE_TIMEOUT_MS = 30_000;

let bearerToken: string | null = null;

/** The session layer keeps the token here in memory; the secure store is its only persistence. */
export function setBearerToken(token: string | null): void {
  bearerToken = token;
}

/** The token requests carry now; the outbox compares it before and after a send (review L1). */
export function currentBearerToken(): string | null {
  return bearerToken;
}

/**
 * True when a request was sent with the token the app holds now. A 401 to an older token (one
 * replaced by change-password or a new sign-in while the request was in flight) is not a loss
 * of the current session.
 */
function sentWithCurrentToken(request: Request): boolean {
  return bearerToken !== null && request.headers.get('Authorization') === `Bearer ${bearerToken}`;
}

export type UpgradeRequired = { minimumVersion: string | null; message: string };

const sessionLostListeners = new Set<() => void>();
const upgradeListeners = new Set<(event: UpgradeRequired) => void>();

/**
 * Fires on a 401 to a request that carried the current bearer token, other than login and
 * logout. A 401 to a stale token does not fire.
 */
export function onSessionLost(listener: () => void): () => void {
  sessionLostListeners.add(listener);
  return () => {
    sessionLostListeners.delete(listener);
  };
}

/** Fires on any 426 UPGRADE_REQUIRED, login included (R161). */
export function onUpgradeRequired(listener: (event: UpgradeRequired) => void): () => void {
  upgradeListeners.add(listener);
  return () => {
    upgradeListeners.delete(listener);
  };
}

/** Login answers 401 AUTH_FAILED for bad credentials; logout's 401 already means signed out. */
const SESSION_EVENT_EXEMPT = new Set(['/api/v1/auth/login', '/api/v1/auth/logout']);

function applyHeaders(headers: Headers): void {
  headers.set('X-App-Version', readAppVersion());
  headers.set('Accept', 'application/json');
  if (bearerToken !== null) headers.set('Authorization', `Bearer ${bearerToken}`);
  else headers.delete('Authorization');
  headers.delete('Origin');
  headers.delete('Cookie');
}

async function envelopeOf(response: Response): Promise<unknown> {
  try {
    return (await response.clone().json()) as unknown;
  } catch {
    return null;
  }
}

function pathOf(url: string): string {
  const match = /^[a-z]+:\/\/[^/]+(\/[^?#]*)/i.exec(url);
  return match?.[1] ?? url;
}

/** Routes a 401 or 426 to its listeners. The caller still receives the response. */
async function inspect(request: Request, response: Response): Promise<void> {
  if (response.status === 426) {
    const error = toApiError(response, await envelopeOf(response));
    const minimumVersion = (error.details as { minimumVersion?: unknown } | null)?.minimumVersion;
    const event: UpgradeRequired = {
      minimumVersion: typeof minimumVersion === 'string' ? minimumVersion : null,
      message: error.message,
    };
    for (const listener of upgradeListeners) listener(event);
    return;
  }
  if (response.status !== 401 || !sentWithCurrentToken(request)) return;
  if (SESSION_EVENT_EXEMPT.has(pathOf(request.url))) return;
  const error = toApiError(response, await envelopeOf(response));
  if (error.code === ErrorCode.AUTH_FAILED) return;
  for (const listener of sessionLostListeners) listener();
}

/** fetch with the slice's timeouts: 20 s for reads, 30 s for writes. A timeout is a network error. */
export async function timedFetch(request: Request): Promise<Response> {
  const controller = new AbortController();
  const timeout = request.method === 'GET' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(request, { signal: controller.signal, credentials: 'omit' });
  } finally {
    clearTimeout(timer);
  }
}

const middleware: Middleware = {
  onRequest({ request }) {
    applyHeaders(request.headers);
    return request;
  },
  async onResponse({ request, response }) {
    await inspect(request, response);
    return response;
  },
};

export const api = createClient<paths>({
  baseUrl: apiUrl(),
  credentials: 'omit',
  headers: { Accept: 'application/json' },
  fetch: timedFetch,
});
api.use(middleware);

/**
 * A request built from stored parts (the outbox's method, path and body), through the same
 * headers, timeouts and 401/426 routing as the typed client.
 */
export async function sendRaw(
  method: string,
  path: string,
  body: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const headers = new Headers({ 'Content-Type': 'application/json', ...extraHeaders });
  applyHeaders(headers);
  const request = new Request(`${apiUrl()}${path}`, { method, body, headers, credentials: 'omit' });
  const response = await timedFetch(request);
  await inspect(request, response);
  return response;
}

/**
 * A multipart upload (slice-16 §11): POST with FormData — React Native's file part is
 * `{ uri, name, type }` — through the same headers, write timeout and 401/426 routing. No
 * Content-Type is set: the runtime writes the multipart boundary. Used by the photo lane only.
 */
export async function sendMultipart(
  path: string,
  field: string,
  file: { uri: string; name: string; mime: string },
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const form = new FormData();
  // React Native reads a file part from this shape; the DOM typing does not know it.
  form.append(field, { uri: file.uri, name: file.name, type: file.mime } as unknown as Blob);
  const headers = new Headers(extraHeaders);
  applyHeaders(headers);
  headers.delete('Content-Type');
  const request = new Request(`${apiUrl()}${path}`, {
    method: 'POST',
    body: form,
    headers,
    credentials: 'omit',
  });
  const response = await timedFetch(request);
  await inspect(request, response);
  return response;
}

/**
 * The headers for a request the client does not make itself — an expo-image source, a PDF
 * download (slice-16 §11): the bearer travels in a header, never in a URL. No token when signed
 * out.
 */
export function authHeaders(accept = 'image/*'): Record<string, string> {
  const headers: Record<string, string> = { 'X-App-Version': readAppVersion(), Accept: accept };
  if (bearerToken !== null) headers.Authorization = `Bearer ${bearerToken}`;
  return headers;
}

type Call<T> = Promise<{ data?: T; error?: unknown; response: Response }>;

/** The data of an openapi-fetch call, or an ApiError thrown. A network failure rethrows as is. */
export async function unwrap<T>(call: Call<T>): Promise<T> {
  return (await unwrapWithDate(call)).data;
}

/** As unwrap, with the response's Date header (the "as of" of a cached read, slice-15 §7.2). */
export async function unwrapWithDate<T>(call: Call<T>): Promise<{ data: T; date: string | null }> {
  const { data, error, response } = await call;
  if (!response.ok) throw toApiError(response, error);
  return { data: data as T, date: response.headers.get('Date') };
}

/** True when a failure never reached the API (offline, timeout, DNS): not an ApiError. */
export function isNetworkError(error: unknown): boolean {
  return !(error instanceof ApiError);
}
