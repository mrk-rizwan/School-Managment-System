import { ApiError, ErrorCode, normaliseIdentityDigits, rateLimitMessage } from '@asms/shared';
import { api, isNetworkError, setBearerToken, unwrapWithDate } from '../api/client';
import type { LoginResultDto, MeDto } from '../api/contracts';
import { cacheKey, writeCache, type Cached } from '../db/cache';
import { bindOwner, wipeUnlessOwnedBy } from '../db/database';
import { log } from '../platform/log';
import { errorFields } from '../platform/scrub';
import { clearPushToken, readSession, remember, writeSession } from './session-store';

// Sign-in (slice-15 §4.2): POST /auth/login with channel bearer, presenting the old token when the
// secure store still holds one (the server revokes it and its device, R159). Online only.

export const ME_CACHE_KEY = cacheKey('/api/v1/me');

export type SignInInput = { schoolCode: string; identity: string; password: string };

export type SignInFailure =
  | { kind: 'invalid_identity'; message: string }
  | { kind: 'auth_failed'; message: string }
  | { kind: 'rate_limited'; message: string }
  | { kind: 'busy'; message: string }
  | { kind: 'network'; message: string }
  | { kind: 'upgrade'; message: string }
  | { kind: 'failed'; message: string };

export type SignInResult = { ok: true; me: Cached<MeDto> } | ({ ok: false } & SignInFailure);

/** The /me part of a login result: the token never reaches the cache. */
export function meOf(result: LoginResultDto): MeDto {
  const { bearerToken: _token, ...me } = result;
  return me;
}

/**
 * Stores a fresh session: wipes rows of another user (a phone handed over), forgets the previous
 * session's push registration, writes the token and ids, binds the database to the owner and
 * caches the result as GET /me.
 */
export async function storeSession(
  result: LoginResultDto,
  dateHeader: string | null,
): Promise<Cached<MeDto>> {
  const token = result.bearerToken;
  if (token === null) throw new Error('A bearer login returned no token');
  await wipeUnlessOwnedBy(result.id, result.school.id);
  await clearPushToken();
  await writeSession({ token, userId: result.id, schoolId: result.school.id });
  setBearerToken(token);
  await bindOwner(result.id, result.school.id);
  return writeCache(ME_CACHE_KEY, meOf(result), dateHeader);
}

export async function signIn(input: SignInInput): Promise<SignInResult> {
  const username = normaliseIdentityDigits(input.identity.trim());
  if (username === null) {
    return {
      ok: false,
      kind: 'invalid_identity',
      message: 'Enter the 13-digit CNIC or B-Form number.',
    };
  }
  const schoolCode = input.schoolCode.trim().toLowerCase();
  const previous = await readSession();
  setBearerToken(previous?.token ?? null);
  try {
    const { data, date } = await unwrapWithDate(
      api.POST('/api/v1/auth/login', {
        body: { schoolCode, username, password: input.password, channel: 'bearer' },
      }),
    );
    const me = await storeSession(data, date);
    await remember(schoolCode, username);
    log('info', 'auth.signed_in', { userId: data.id, schoolId: data.school.id });
    return { ok: true, me };
  } catch (error) {
    setBearerToken(null);
    return { ok: false, ...describeSignInFailure(error) };
  }
}

export function describeSignInFailure(error: unknown): SignInFailure {
  if (isNetworkError(error)) {
    log('info', 'auth.sign_in_network', errorFields(error));
    return { kind: 'network', message: 'No connection. Sign-in needs a connection.' };
  }
  if (!(error instanceof ApiError)) {
    // Not the network and not the server's answer: a fault on this phone. Never "No connection".
    log('error', 'auth.sign_in_failed', errorFields(error));
    return { kind: 'failed', message: 'Sign-in failed. Try again.' };
  }
  log('info', 'auth.sign_in_refused', { status: error.status, code: error.code });
  if (error.status === 401) return { kind: 'auth_failed', message: error.message };
  if (error.status === 426) return { kind: 'upgrade', message: error.message };
  if (error.status === 429) return { kind: 'rate_limited', message: rateLimitMessage(error) };
  if (error.status === 503 || error.code === ErrorCode.SERVICE_UNAVAILABLE) {
    return { kind: 'busy', message: 'The school’s system is busy. Try again shortly.' };
  }
  if (error.status === 422) {
    const onSchoolCode = error.fieldErrors.some((field) => field.path === 'schoolCode');
    if (onSchoolCode) return { kind: 'failed', message: 'Check the school code.' };
    // 422 on channel is impossible while the header is sent: a bug, shown as a generic failure.
    log('error', 'auth.sign_in_unexpected_422', {
      fields: error.fieldErrors.map((field) => field.path),
    });
  }
  return { kind: 'failed', message: 'Sign-in failed. Try again.' };
}

/** The remembered identity number as shown: 3520112345671 → 35201-*****-1. */
export function maskIdentity(digits: string): string {
  return `${digits.slice(0, 5)}-*****-${digits.slice(-1)}`;
}
