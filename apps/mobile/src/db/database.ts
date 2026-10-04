import { deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { clearWipePending, isWipePending, markWipePending } from '../auth/session-store';
import { log } from '../platform/log';
import { errorFields } from '../platform/scrub';
import { META_DDL, MIGRATIONS, SCHEMA_VERSION } from './schema';

// The ONLY importer of expo-sqlite (lint). One file, asms.db: opened, configured, migrated,
// wiped (slice-15 §7.1, §4.6, §7.6). Callers get the database through getDb() and the Db type.

export type Db = SQLiteDatabase;

export const DATABASE_NAME = 'asms.db';

export const META = {
  schemaVersion: 'schema_version',
  userId: 'user_id',
  schoolId: 'school_id',
  pushPermissionAskedAt: 'push_permission_asked_at',
  /** When a 401 ended the session (§7.6): unsent rows older than the window are discarded. */
  sessionLostAt: 'session_lost_at',
} as const;

let opening: Promise<Db> | null = null;

/** Before a delete: the WAL folded in and the journal off WAL, so no -wal or -shm stays behind. */
const LEAVE_NO_SIBLINGS = 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;';

/** The open, migrated database; opened on first use. */
export function getDb(): Promise<Db> {
  if (opening === null) {
    const attempt = openAndMigrate();
    opening = attempt;
    attempt.catch(() => {
      if (opening === attempt) opening = null;
    });
  }
  return opening;
}

async function open(): Promise<Db> {
  const db = await openDatabaseAsync(DATABASE_NAME);
  await db.execAsync(
    // secure_delete: a deleted row's bytes are overwritten, not left in free pages (review M1).
    'PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON; PRAGMA foreign_keys = ON; ' +
      'PRAGMA busy_timeout = 5000;',
  );
  await db.execAsync(META_DDL);
  return db;
}

async function versionOf(db: Db): Promise<number> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
    META.schemaVersion,
  ]);
  return row === null ? 0 : Number(row.value);
}

/** A previous wipe could not close the file: delete it before anything reads it. */
async function finishPendingWipe(): Promise<void> {
  if (!(await isWipePending())) return;
  // Still open (the stuck connection of this run): the marker stays for the next start.
  if (!(await deleteFile())) return;
  await clearWipePending();
  log('info', 'db.pending_wipe_finished');
}

async function openAndMigrate(): Promise<Db> {
  await finishPendingWipe();
  let db = await open();
  let version = await versionOf(db);
  if (version > SCHEMA_VERSION) {
    // The file is newer than this app (a downgrade): wipe rather than guess.
    log('warn', 'db.downgrade_wiped', { fileVersion: version, appVersion: SCHEMA_VERSION });
    await db.execAsync(LEAVE_NO_SIBLINGS);
    await db.closeAsync();
    await deleteDatabaseAsync(DATABASE_NAME);
    db = await open();
    version = 0;
  }
  if (version < SCHEMA_VERSION) {
    await db.withExclusiveTransactionAsync(async (txn) => {
      for (const ddl of MIGRATIONS.slice(version)) await txn.execAsync(ddl);
      await txn.runAsync(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [META.schemaVersion, String(SCHEMA_VERSION)],
      );
    });
  }
  return db;
}

/**
 * Deletes the database file. The next getDb() starts from an empty, migrated file. The WAL is
 * checkpointed and the journal switched to DELETE first, so no -wal or -shm sibling outlives the
 * file (expo-sqlite deletes the main file only). If the connection will not close, the file cannot
 * be deleted: the rows are deleted instead (secure_delete overwrites them), the wipe is marked
 * pending and finished at the next open, and false is returned — the wipe is not complete.
 */
export async function wipeDatabase(): Promise<boolean> {
  const current = opening;
  opening = null;
  let db: Db | null = null;
  if (current !== null) {
    try {
      db = await current;
    } catch {
      db = null; // it never opened: nothing to close
    }
  }
  if (db !== null) {
    try {
      await db.execAsync(LEAVE_NO_SIBLINGS);
    } catch (error) {
      log('warn', 'db.checkpoint_failed', errorFields(error));
    }
    try {
      await db.closeAsync();
    } catch (error) {
      log('warn', 'db.close_failed', errorFields(error));
      await markWipePending();
      await clearRows(db);
      log('warn', 'db.wipe_incomplete');
      return false;
    }
  }
  if (!(await deleteFile())) {
    await markWipePending();
    log('warn', 'db.wipe_incomplete');
    return false;
  }
  await clearWipePending();
  return true;
}

/** True when the file is gone: deleted now, or there was none (the state we want). */
async function deleteFile(): Promise<boolean> {
  try {
    await deleteDatabaseAsync(DATABASE_NAME);
    return true;
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) return true;
    log('warn', 'db.delete_failed', errorFields(error));
    return false;
  }
}

/** The fallback when the file cannot go: every row of every table, best effort. */
async function clearRows(db: Db): Promise<void> {
  try {
    await db.execAsync(
      `DELETE FROM cache; DELETE FROM outbox; DELETE FROM meta WHERE key != '${META.schemaVersion}';`,
    );
  } catch (error) {
    log('warn', 'db.clear_rows_failed', errorFields(error));
  }
}

/**
 * Session loss, the slice-15 §7.6 rule as confirmed by the wave-E security review: every
 * read-cache row and every finished (done or failed) outbox row go; pending and sending writes
 * survive, still bound to meta.user_id and school_id, for the same user's next sign-in — for at
 * most UNSENT_WINDOW_MS after the loss, stamped in meta.session_lost_at (the first loss counts;
 * a second 401 does not extend the window). Returns the number of unsent items kept.
 */
export async function wipeForSessionLoss(now: Date = new Date()): Promise<number> {
  const db = await getDb();
  let kept = 0;
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync('DELETE FROM cache');
    await txn.runAsync("DELETE FROM outbox WHERE state IN ('done', 'failed')");
    await txn.runAsync('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING', [
      META.sessionLostAt,
      now.toISOString(),
    ]);
    const row = await txn.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM outbox');
    kept = row?.n ?? 0;
  });
  return kept;
}

/** Unsent writes outlive their session by at most seven days (§7.6, R155). */
export const UNSENT_WINDOW_MS = 7 * 24 * 60 * 60_000;

export type DiscardedItem = { lane: string; createdAt: string };

/**
 * Startup and before the queue resumes (§7.6): if a 401 ended the session more than seven days
 * ago, the unsent (pending and sending) rows it left are deleted and returned, so the screen can
 * say what was lost. Within the window nothing changes. The stamp is cleared once the rows are
 * gone or `resuming` (the same user is back and the queue runs again).
 */
export async function discardExpiredUnsent(
  now: Date = new Date(),
  resuming = false,
): Promise<DiscardedItem[]> {
  const db = await getDb();
  let discarded: DiscardedItem[] = [];
  await db.withExclusiveTransactionAsync(async (txn) => {
    const stamp = await txn.getFirstAsync<{ value: string }>(
      'SELECT value FROM meta WHERE key = ?',
      [META.sessionLostAt],
    );
    if (stamp === null) return;
    const expired = now.getTime() - Date.parse(stamp.value) > UNSENT_WINDOW_MS;
    if (expired) {
      discarded = await txn.getAllAsync<DiscardedItem>(
        `SELECT lane, created_at AS createdAt FROM outbox WHERE state IN ('pending', 'sending')
         ORDER BY created_at, id`,
      );
      await txn.runAsync("DELETE FROM outbox WHERE state IN ('pending', 'sending')");
    }
    if (expired || resuming) {
      await txn.runAsync('DELETE FROM meta WHERE key = ?', [META.sessionLostAt]);
    }
  });
  if (discarded.length > 0) log('warn', 'outbox.unsent_discarded', { count: discarded.length });
  return discarded;
}

export async function getMeta(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
    key,
  ]);
  return row?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}

/** The ids the stored rows belong to (ids only: never a name, number or token). */
export async function readOwner(): Promise<{ userId: string; schoolId: string } | null> {
  const [userId, schoolId] = [await getMeta(META.userId), await getMeta(META.schoolId)];
  return userId === null || schoolId === null ? null : { userId, schoolId };
}

export async function bindOwner(userId: string, schoolId: string): Promise<void> {
  await setMeta(META.userId, userId);
  await setMeta(META.schoolId, schoolId);
}

/**
 * Startup and sign-in check (slice-15 §4.1 step 3): rows written for another user or school are
 * never shown to this one. Returns true when the file was wiped.
 */
export async function wipeUnlessOwnedBy(userId: string, schoolId: string): Promise<boolean> {
  const owner = await readOwner();
  if (owner === null || (owner.userId === userId && owner.schoolId === schoolId)) return false;
  await wipeDatabase();
  return true;
}
