import { ApiError, ErrorCode } from '@asms/shared';
import { api, isNetworkError, setBearerToken, unwrap, unwrapWithDate } from '../api/client';
import type { MeDto } from '../api/contracts';
import { writeCache, type Cached } from '../db/cache';
import { log } from '../platform/log';
import { errorFields } from '../platform/scrub';
import { meOf, ME_CACHE_KEY } from './sign-in';
import { replaceToken } from './session-store';

// Account actions (slice-15 §4.4). All online-only (R162): never queued, disabled offline.

export type ChangePasswordResult =
  | { ok: true; me: Cached<MeDto> }
  | { ok: false; field: 'currentPassword' | 'newPassword' | null; message: string };

export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<ChangePasswordResult> {
  try {
    const { data, date } = await unwrapWithDate(
      api.POST('/api/v1/me/change-password', { body: { currentPassword, newPassword } }),
    );
    // The old token is dead on commit: the new one replaces it before anything else runs
    // (slice-9 §3.4, §14).
    if (data.bearerToken === null) throw new Error('A bearer password change returned no token');
    await replaceToken(data.bearerToken);
    setBearerToken(data.bearerToken);
    const me = await writeCache(ME_CACHE_KEY, meOf(data), date);
    log('info', 'auth.password_changed');
    return { ok: true, me };
  } catch (error) {
    if (isNetworkError(error)) {
      return {
        ok: false,
        field: null,
        message: 'No connection. Changing the password needs a connection.',
      };
    }
    if (!(error instanceof ApiError)) {
      log('error', 'auth.change_password_failed', errorFields(error));
      return { ok: false, field: null, message: 'The password could not be changed. Try again.' };
    }
    if (error.code === ErrorCode.CURRENT_PASSWORD_INCORRECT) {
      return { ok: false, field: 'currentPassword', message: error.message };
    }
    if (error.code === ErrorCode.EMAIL_NOT_VERIFIED) {
      return { ok: false, field: null, message: 'Add and verify an email on the web first.' };
    }
    const field = error.fieldErrors.find(
      (f) => f.path === 'newPassword' || f.path === 'currentPassword',
    );
    if (field)
      return {
        ok: false,
        field: field.path as 'newPassword' | 'currentPassword',
        message: field.message,
      };
    return { ok: false, field: null, message: error.message };
  }
}

export type RevokeOthersResult = { ok: true; revoked: number } | { ok: false; message: string };

export async function revokeOtherSessions(): Promise<RevokeOthersResult> {
  try {
    const { revoked } = await unwrap(api.POST('/api/v1/me/sessions/revoke-others'));
    return { ok: true, revoked };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, message: error.message };
    if (isNetworkError(error)) return { ok: false, message: 'No connection. This needs a connection.' };
    log('error', 'auth.revoke_others_failed', errorFields(error));
    return { ok: false, message: 'Something went wrong. Try again.' };
  }
}

/**
 * POST /auth/logout: the server revokes the session and its device first (R159). A 401 means the
 * session was already gone, which is signed out too. Returns false when the school could not be
 * reached or did not confirm (a 5xx): the caller asks "sign out anyway?".
 */
export async function logoutOnServer(): Promise<boolean> {
  try {
    const { response } = await api.POST('/api/v1/auth/logout');
    log('info', 'auth.logout', { status: response.status });
    return response.ok || response.status === 401;
  } catch {
    return false;
  }
}
