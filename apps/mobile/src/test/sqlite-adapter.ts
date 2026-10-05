import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

// The subset of expo-sqlite's async API the app uses, over Node's built-in SQLite (slice-15
// §13.1 allows a stand-in behind the same interface when the native module cannot load in Jest;
// recorded: node:sqlite, so no extra dependency). Real SQL, real constraints: the partial unique
// index, CHECKs and transactions behave as on the device. Files are in memory, keyed by name;
// deleteDatabaseAsync removes one, so "the database file does not exist" is testable.
//
// The file system is modelled as the native module behaves (expo-sqlite 57, SQLiteModule.kt):
// deleteDatabaseAsync refuses while a connection is open and deletes the main file ONLY. The
// -wal and -shm siblings appear when a connection sets journal_mode = WAL and go only when it
// sets journal_mode = DELETE — pessimistic (a clean close also removes them on a device), so a
// wipe that forgets the journal switch fails its test (security review M1).

//
// Connections share the file's one in-memory engine (node:sqlite cannot share :memory: between
// connections), so per-connection settings cannot be observed from SQL. Each connection records
// the statements it ran instead; connectionLog() lets a test prove that a connection opened with
// useNewConnection (an exclusive transaction's) set foreign_keys and busy_timeout before BEGIN.

const files = new Map<string, DatabaseSync>();
const connections: { name: string; newConnection: boolean; statements: string[] }[] = [];
const openConnections = new Map<string, number>();
const siblings = new Set<string>();
let failCloses = 0;

type Params = SQLInputValue[] | undefined;

function bind(params: unknown): SQLInputValue[] {
  if (params === undefined) return [];
  return (Array.isArray(params) ? params : [params]) as SQLInputValue[];
}

/** Rows come back as plain objects (node:sqlite returns null-prototype ones). */
const plain = (row: unknown) => (row === undefined ? null : { ...(row as object) });

class TestDatabase {
  private closed = false;
  constructor(
    private readonly raw: DatabaseSync,
    private readonly name: string,
    private readonly statements: string[],
  ) {}

  async execAsync(sql: string): Promise<void> {
    this.statements.push(sql);
    this.raw.exec(sql);
    if (/journal_mode\s*=\s*WAL/i.test(sql)) {
      siblings.add(`${this.name}-wal`);
      siblings.add(`${this.name}-shm`);
    }
    if (/journal_mode\s*=\s*DELETE/i.test(sql)) {
      siblings.delete(`${this.name}-wal`);
      siblings.delete(`${this.name}-shm`);
    }
  }

  async runAsync(
    sql: string,
    params?: Params,
  ): Promise<{ lastInsertRowId: number; changes: number }> {
    const result = this.raw.prepare(sql).run(...bind(params));
    return { lastInsertRowId: Number(result.lastInsertRowid), changes: Number(result.changes) };
  }

  async getFirstAsync<T>(sql: string, params?: Params): Promise<T | null> {
    return plain(this.raw.prepare(sql).get(...bind(params))) as T | null;
  }

  async getAllAsync<T>(sql: string, params?: Params): Promise<T[]> {
    return this.raw
      .prepare(sql)
      .all(...bind(params))
      .map((row) => plain(row) as T);
  }

  closeAsync(): Promise<void> {
    if (failCloses > 0) {
      failCloses -= 1;
      return Promise.reject(new Error('Unable to close the database'));
    }
    if (!this.closed) {
      this.closed = true;
      openConnections.set(this.name, Math.max(0, (openConnections.get(this.name) ?? 1) - 1));
    }
    return Promise.resolve();
  }
}

export function openDatabaseAsync(
  name: string,
  options: { useNewConnection?: boolean } = {},
): Promise<TestDatabase> {
  let raw = files.get(name);
  if (raw === undefined) {
    raw = new DatabaseSync(':memory:');
    files.set(name, raw);
  }
  openConnections.set(name, (openConnections.get(name) ?? 0) + 1);
  const connection = {
    name,
    newConnection: options.useNewConnection === true,
    statements: [] as string[],
  };
  connections.push(connection);
  return Promise.resolve(new TestDatabase(raw, name, connection.statements));
}

/** Test-only: every connection opened since the last reset, with the statements it executed. */
export const connectionLog = () =>
  connections.map((c) => ({ ...c, statements: [...c.statements] }));

export function deleteDatabaseAsync(name: string): Promise<void> {
  if ((openConnections.get(name) ?? 0) > 0) {
    return Promise.reject(new Error(`Database ${name} is open and cannot be deleted`));
  }
  const raw = files.get(name);
  if (raw === undefined) return Promise.reject(new Error(`Database ${name} not found`));
  raw.close();
  files.delete(name);
  return Promise.resolve();
}

/** Test-only: whether the named database "file" exists. */
export const databaseFileExists = (name: string): boolean => files.has(name);

/** Test-only: every file on the "disk" whose name starts with `prefix` (asms.db, -wal, -shm). */
export const filesStartingWith = (prefix: string): string[] =>
  [...files.keys(), ...siblings].filter((file) => file.startsWith(prefix)).sort();

/** Test-only: the next `n` closeAsync calls fail, as a native close can. */
export function failNextCloses(n = 1): void {
  failCloses = n;
}

/** Test-only: forget every database between tests. */
export function resetDatabases(): void {
  for (const raw of files.values()) raw.close();
  files.clear();
  connections.length = 0;
  openConnections.clear();
  siblings.clear();
  failCloses = 0;
}

/** Test-only: the process ends — every connection is gone, the files stay. */
export function dropConnections(): void {
  openConnections.clear();
}
