import { setBearerToken } from '../api/client';
import { queryClient } from '../api/query-client';
import { wipeDatabase, wipeForSessionLoss } from '../db/database';
import { outboxWorker } from '../outbox/runtime';
import { log } from '../platform/log';
import { clearSession } from './session-store';

/**
 * The wipe (slice-15 §4.6): sign-out, "forget me", a store-owner mismatch and a different user's
 * sign-in. The database file is deleted, TanStack Query cleared, every asms.session.* and
 * asms.push.* key removed. Only the two asms.remembered.* keys survive.
 */
export async function wipeAll(): Promise<boolean> {
  outboxWorker.stop();
  setBearerToken(null);
  await clearSession();
  queryClient.clear();
  const complete = await wipeDatabase();
  // An incomplete wipe (the file would not close) has deleted the rows and is finished at the
  // next open; it is not reported as done.
  if (complete) log('info', 'session.wiped');
  else log('warn', 'session.wipe_incomplete');
  return complete;
}

/**
 * Session loss — any 401 outside the login form (slice-15 §4.5, §7.6): the token and session ids
 * leave at once, read caches and TanStack Query are cleared, the queue pauses, and pending writes
 * are kept for the same user's next sign-in, for at most seven days (meta.session_lost_at).
 * Returns how many unsent items wait.
 */
export async function loseSession(): Promise<number> {
  outboxWorker.pause();
  setBearerToken(null);
  await clearSession();
  queryClient.clear();
  const kept = await wipeForSessionLoss();
  log('info', 'session.lost', { unsentKept: kept });
  return kept;
}
