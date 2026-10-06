import { openDatabaseAsync } from 'expo-sqlite';
import { KEYS } from '../auth/session-store';
import { resetDevice } from '../test/fake-api';
import { secureStoreContents } from '../test/secure-store';
import {
  connectionLog,
  databaseFileExists,
  dropConnections,
  failNextCloses,
  filesStartingWith,
} from '../test/sqlite-adapter';
import { writeCache } from './cache';
import {
  bindOwner,
  DATABASE_NAME,
  discardExpiredUnsent,
  getDb,
  getMeta,
  inExclusiveTransaction,
  META,
  UNSENT_WINDOW_MS,
  wipeDatabase,
  wipeForSessionLoss,
} from './database';
import { enqueue, listUnfinished, NoOwnerError } from './outbox.repository';
import { META_DDL, MIGRATIONS, SCHEMA_VERSION } from './schema';

// Security review of slice 15: M1 (no SQLite residue after a wipe) and the §7.6 seven-day window.

beforeEach(resetDevice);

const device = { lane: 'device_register', method: 'POST', path: '/api/v1/me/devices' };

describe('M1: the wipe leaves nothing on disk', () => {
  test('rows are overwritten on delete (secure_delete is on)', async () => {
    const db = await getDb();
    expect(await db.getFirstAsync<{ secure_delete: number }>('PRAGMA secure_delete')).toEqual({
      secure_delete: 1,
    });
  });

  test('a wipe removes the file and its -wal and -shm siblings', async () => {
    await getDb();
    expect(filesStartingWith(DATABASE_NAME)).toEqual(
      [DATABASE_NAME, `${DATABASE_NAME}-shm`, `${DATABASE_NAME}-wal`].sort(),
    );
    expect(await wipeDatabase()).toBe(true);
    expect(filesStartingWith(DATABASE_NAME)).toEqual([]);
  });

  test('a close that fails is not a complete wipe: rows go now, the file at the next start', async () => {
    await bindOwner('41', '7');
    await writeCache('GET /api/v1/me', { fullName: 'x' }, null);
    await enqueue({ ...device, body: { platform: 'android', pushToken: 'p' } });
    const stuck = await getDb();
    failNextCloses();

    expect(await wipeDatabase()).toBe(false);
    expect(secureStoreContents()[KEYS.wipePending]).toBe('1');
    expect(databaseFileExists(DATABASE_NAME)).toBe(true);
    // The connection would not close; its rows were deleted through it.
    expect(await stuck.getFirstAsync('SELECT COUNT(*) AS n FROM cache')).toEqual({ n: 0 });
    expect(await stuck.getFirstAsync('SELECT COUNT(*) AS n FROM outbox')).toEqual({ n: 0 });
    expect(
      await stuck.getFirstAsync('SELECT COUNT(*) AS n FROM meta WHERE key = ?', [META.userId]),
    ).toEqual({ n: 0 });

    await stuck.runAsync("INSERT INTO meta (key, value) VALUES ('probe', '1')");

    // Next start: the stuck connection died with the process; the first open deletes the file.
    dropConnections();
    const fresh = await getDb();
    expect(secureStoreContents()[KEYS.wipePending]).toBeUndefined();
    expect(fresh).not.toBe(stuck);
    expect(await getMeta('probe')).toBeNull(); // a new file, not the old one
    expect(await listUnfinished()).toEqual([]);
  });
});

describe("exclusive transactions: their own connection, with the main connection's settings", () => {
  const statementsOf = () => connectionLog().filter((c) => c.newConnection);

  test('every transaction connection sets foreign_keys, busy_timeout and secure_delete before BEGIN', async () => {
    await bindOwner('41', '7');
    await enqueue({ ...device, body: {} }); // one of the app's transactions
    await wipeForSessionLoss(); // and another
    const opened = statementsOf();
    expect(opened.length).toBeGreaterThanOrEqual(2);
    for (const { statements } of opened) {
      const begin = statements.indexOf('BEGIN IMMEDIATE');
      expect(begin).toBeGreaterThan(0);
      const before = statements.slice(0, begin).join(' ');
      expect(before).toMatch(/PRAGMA foreign_keys = ON/);
      expect(before).toMatch(/PRAGMA busy_timeout = 5000/);
      expect(before).toMatch(/PRAGMA secure_delete = ON/);
      expect(statements[statements.length - 1]).toBe('COMMIT');
    }
    // Each was closed: the file can be deleted (deleteDatabaseAsync refuses while one is open).
    expect(await wipeDatabase()).toBe(true);
  });

  test('a task that throws rolls back and the error reaches the caller', async () => {
    await bindOwner('41', '7');
    const failing = inExclusiveTransaction(async (txn) => {
      await txn.runAsync('INSERT INTO meta (key, value) VALUES (?, ?)', ['probe', '1']);
      throw new Error('task failed');
    });
    await expect(failing).rejects.toThrow('task failed');
    expect(await getMeta('probe')).toBeNull();
    expect(statementsOf().at(-1)?.statements.at(-1)).toBe('ROLLBACK');
  });

  test('two at once run one after the other, never interleaved', async () => {
    const order: string[] = [];
    const step = (name: string) =>
      inExclusiveTransaction(async (txn) => {
        order.push(`${name}:start`);
        await txn.runAsync('INSERT INTO meta (key, value) VALUES (?, ?)', [name, '1']);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`${name}:end`);
      });
    await Promise.all([step('a'), step('b')]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });
});

describe('§7.6: unsent writes outlive their session by at most seven days', () => {
  const lostAt = new Date('2026-10-01T08:00:00.000Z');

  async function lostWithOneUnsent(): Promise<void> {
    await bindOwner('41', '7');
    await enqueue({ ...device, body: { platform: 'android', pushToken: 'p' } }, lostAt);
    await wipeForSessionLoss(lostAt);
  }

  test('a 401 stamps session_lost_at once; a second loss does not extend the window', async () => {
    await lostWithOneUnsent();
    expect(await getMeta(META.sessionLostAt)).toBe(lostAt.toISOString());
    await wipeForSessionLoss(new Date('2026-10-03T08:00:00.000Z'));
    expect(await getMeta(META.sessionLostAt)).toBe(lostAt.toISOString());
  });

  test('within seven days nothing is discarded', async () => {
    await lostWithOneUnsent();
    const inside = new Date(lostAt.getTime() + UNSENT_WINDOW_MS - 1);
    expect(await discardExpiredUnsent(inside)).toEqual([]);
    expect(await listUnfinished()).toHaveLength(1);
    expect(await getMeta(META.sessionLostAt)).not.toBeNull();
  });

  test('past seven days the unsent rows go and are returned with lane and date', async () => {
    await lostWithOneUnsent();
    const after = new Date(lostAt.getTime() + UNSENT_WINDOW_MS + 1);
    expect(await discardExpiredUnsent(after)).toEqual([
      { lane: 'device_register', createdAt: lostAt.toISOString() },
    ]);
    expect(await listUnfinished()).toEqual([]);
    expect(await getMeta(META.sessionLostAt)).toBeNull();
  });

  test('resuming within the window clears the stamp, so a later check discards nothing', async () => {
    await lostWithOneUnsent();
    await discardExpiredUnsent(new Date(lostAt.getTime() + 1000), true);
    expect(await getMeta(META.sessionLostAt)).toBeNull();
    expect(await discardExpiredUnsent(new Date(lostAt.getTime() + 30 * UNSENT_WINDOW_MS))).toEqual(
      [],
    );
    expect(await listUnfinished()).toHaveLength(1);
  });

  test('enqueue refuses when no user owns the rows', async () => {
    await expect(
      enqueue({ ...device, body: { platform: 'android', pushToken: 'p' } }),
    ).rejects.toBeInstanceOf(NoOwnerError);
    expect(await listUnfinished()).toEqual([]);
  });
});

describe('migration 3 (slice 16b): an outbox row written at v2 survives the upgrade', () => {
  test('open at v2, write a row, reopen at v3: the row is unfinished with responseDetails null', async () => {
    await wipeDatabase();
    const v2 = await openDatabaseAsync(DATABASE_NAME);
    await v2.execAsync(META_DDL);
    for (const ddl of MIGRATIONS.slice(0, 2)) await v2.execAsync(ddl);
    await v2.runAsync('INSERT INTO meta (key, value) VALUES (?, ?)', [META.schemaVersion, '2']);
    await v2.runAsync(
      `INSERT INTO outbox (id, lane, method, path, body, state, attempts, created_at, updated_at)
       VALUES ('row-v2', 'device_register', 'POST', '/api/v1/me/devices', '{}', 'pending', 0, ?, ?)`,
      ['2026-10-04T04:00:00.000Z', '2026-10-04T04:00:00.000Z'],
    );
    await v2.closeAsync();

    expect(await getMeta(META.schemaVersion)).toBe(String(SCHEMA_VERSION));
    expect(SCHEMA_VERSION).toBe(4);
    const rows = await listUnfinished();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'row-v2', state: 'pending', responseDetails: null });
  });
});
