import { newIdempotencyKey } from '@asms/shared';
import { z } from 'zod';
import { mergeBodies } from '../outbox/coalesce';
import type { OutboxItem } from '../outbox/machine';
import { getDb, inExclusiveTransaction, readOwner, type Db } from './database';
import { PURGE_ORPHAN_LOCAL_ROWS } from './schema';

// The only SQL on the outbox table (slice-15 §7.2). Rows are validated at the boundary.

const PURGE_AFTER_MS = 7 * 24 * 60 * 60_000;

const Row = z.object({
  id: z.string(),
  lane: z.string(),
  method: z.string(),
  path: z.string(),
  natural_key: z.string().nullable(),
  body: z.string(),
  state: z.enum(['pending', 'sending', 'done', 'failed']),
  attempts: z.number(),
  next_attempt_at: z.string().nullable(),
  sending_since: z.string().nullable(),
  response_status: z.number().nullable(),
  response_code: z.string().nullable(),
  response_message: z.string().nullable(),
  response_details: z.string().nullable(),
  domain_table: z.string().nullable(),
  domain_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

function toItem(raw: unknown): OutboxItem {
  const r = Row.parse(raw);
  return {
    id: r.id,
    lane: r.lane,
    method: r.method,
    path: r.path,
    naturalKey: r.natural_key,
    body: r.body,
    state: r.state,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    sendingSince: r.sending_since,
    responseStatus: r.response_status,
    responseCode: r.response_code,
    responseMessage: r.response_message,
    responseDetails: r.response_details,
    domainTable: r.domain_table,
    domainId: r.domain_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLUMNS =
  'id, lane, method, path, natural_key, body, state, attempts, next_attempt_at, sending_since, ' +
  'response_status, response_code, response_message, response_details, domain_table, domain_id, ' +
  'created_at, updated_at';

function values(item: OutboxItem) {
  return [
    item.id,
    item.lane,
    item.method,
    item.path,
    item.naturalKey,
    item.body,
    item.state,
    item.attempts,
    item.nextAttemptAt,
    item.sendingSince,
    item.responseStatus,
    item.responseCode,
    item.responseMessage,
    item.responseDetails,
    item.domainTable,
    item.domainId,
    item.createdAt,
    item.updatedAt,
  ];
}

export type EnqueueInput = {
  lane: string;
  method: string;
  path: string;
  body: unknown;
  naturalKey?: string | null;
  domainTable?: string | null;
  domainId?: string | null;
};

async function insertItem(db: Db, item: OutboxItem): Promise<void> {
  await db.runAsync(
    `INSERT INTO outbox (${COLUMNS}) VALUES (${COLUMNS.split(',')
      .map(() => '?')
      .join(', ')})`,
    values(item),
  );
}

/**
 * Adds a write, inside the caller's transaction (slice 16 writes its domain row in the same one).
 * A natural key with a pending row merges into it; otherwise a new pending row. Returns its id.
 */
export async function enqueueIn(txn: Db, input: EnqueueInput, now: Date): Promise<string> {
  const stamp = now.toISOString();
  const body = JSON.stringify(input.body);
  const naturalKey = input.naturalKey ?? null;
  if (naturalKey !== null) {
    const pending = await txn.getFirstAsync<unknown>(
      `SELECT ${COLUMNS} FROM outbox WHERE natural_key = ? AND state = 'pending'`,
      [naturalKey],
    );
    if (pending !== null) {
      const item = toItem(pending);
      await txn.runAsync('UPDATE outbox SET body = ?, updated_at = ? WHERE id = ?', [
        mergeBodies(item.body, body),
        stamp,
        item.id,
      ]);
      return item.id;
    }
  }
  const id = newIdempotencyKey();
  await insertItem(txn, {
    id,
    lane: input.lane,
    method: input.method,
    path: input.path,
    naturalKey,
    body,
    state: 'pending',
    attempts: 0,
    nextAttemptAt: null,
    sendingSince: null,
    responseStatus: null,
    responseCode: null,
    responseMessage: null,
    responseDetails: null,
    domainTable: input.domainTable ?? null,
    domainId: input.domainId ?? null,
    createdAt: stamp,
    updatedAt: stamp,
  });
  return id;
}

/**
 * Rewrites the body of the pending row of `naturalKey`, if any, inside the caller's transaction
 * (slice 30: a marks entry queued behind one that just landed is re-based on the mark it made).
 */
export async function rewritePendingIn(
  txn: Db,
  naturalKey: string,
  rewrite: (body: string) => string,
  now: Date,
): Promise<void> {
  const pending = await txn.getFirstAsync<{ id: string; body: string }>(
    "SELECT id, body FROM outbox WHERE natural_key = ? AND state = 'pending'",
    [naturalKey],
  );
  if (pending === null) return;
  const body = rewrite(pending.body);
  if (body === pending.body) return;
  await txn.runAsync('UPDATE outbox SET body = ?, updated_at = ? WHERE id = ?', [
    body,
    now.toISOString(),
    pending.id,
  ]);
}

/** Refused when no user owns the device rows: a write is never stored without its owner (§7.6). */
export class NoOwnerError extends Error {
  constructor() {
    super('No signed-in owner: the write was not stored');
    this.name = 'NoOwnerError';
  }
}

export async function enqueue(input: EnqueueInput, now: Date = new Date()): Promise<string> {
  if ((await readOwner()) === null) throw new NoOwnerError();
  let id = '';
  await inExclusiveTransaction(async (txn) => {
    id = await enqueueIn(txn, input, now);
  });
  return id;
}

/** Pending items that are due, oldest first. */
export async function listDue(now: Date): Promise<OutboxItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<unknown>(
    `SELECT ${COLUMNS} FROM outbox WHERE state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY created_at, id`,
    [now.toISOString()],
  );
  return rows.map(toItem);
}

/** Every item the sync sheet shows: everything not done, oldest first. */
export async function listUnfinished(): Promise<OutboxItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<unknown>(
    `SELECT ${COLUMNS} FROM outbox WHERE state != 'done' ORDER BY lane, created_at, id`,
  );
  return rows.map(toItem);
}

export async function listByState(state: OutboxItem['state']): Promise<OutboxItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<unknown>(
    `SELECT ${COLUMNS} FROM outbox WHERE state = ? ORDER BY created_at`,
    [state],
  );
  return rows.map(toItem);
}

export async function findItem(id: string): Promise<OutboxItem | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<unknown>(`SELECT ${COLUMNS} FROM outbox WHERE id = ?`, [id]);
  return row === null ? null : toItem(row);
}

/**
 * pending -> sending, atomically: only a row still pending is claimed, and the row is read back
 * after it left pending, so its body includes every merge that landed before the claim and none
 * can land after it (a merge only ever touches a pending row). Null when it was no longer pending.
 */
export async function claimPending(id: string, now: Date): Promise<OutboxItem | null> {
  const db = await getDb();
  const stamp = now.toISOString();
  const result = await db.runAsync(
    `UPDATE outbox SET state = 'sending', attempts = attempts + 1, sending_since = ?, updated_at = ?
       WHERE id = ? AND state = 'pending'`,
    [stamp, stamp, id],
  );
  if (result.changes === 0) return null;
  const row = await db.getFirstAsync<unknown>(`SELECT ${COLUMNS} FROM outbox WHERE id = ?`, [id]);
  return row === null ? null : toItem(row);
}

/** Writes an item's state after a transition. */
export async function saveItem(item: OutboxItem): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE outbox SET state = ?, attempts = ?, next_attempt_at = ?, sending_since = ?, response_status = ?,
       response_code = ?, response_message = ?, response_details = ?, body = ?, updated_at = ?
       WHERE id = ?`,
    [
      item.state,
      item.attempts,
      item.nextAttemptAt,
      item.sendingSince,
      item.responseStatus,
      item.responseCode,
      item.responseMessage,
      item.responseDetails,
      item.body,
      item.updatedAt,
      item.id,
    ],
  );
}

/** "Retry now": every pending item becomes due. */
export async function makeAllDue(): Promise<void> {
  const db = await getDb();
  await db.runAsync("UPDATE outbox SET next_attempt_at = NULL WHERE state = 'pending'");
}

/** The earliest future attempt among pending items, for the foreground timer. */
export async function earliestAttempt(): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ at: string | null }>(
    "SELECT MIN(next_attempt_at) AS at FROM outbox WHERE state = 'pending'",
  );
  return row?.at ?? null;
}

/** Items not yet on the server (pending or sending). */
export async function countUnsent(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM outbox WHERE state IN ('pending', 'sending')",
  );
  return row?.n ?? 0;
}

/** Done and failed rows older than seven days. */
export async function purgeFinished(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - PURGE_AFTER_MS).toISOString();
  let changes = 0;
  await inExclusiveTransaction(async (txn) => {
    const result = await txn.runAsync(
      "DELETE FROM outbox WHERE state IN ('done', 'failed') AND updated_at < ?",
      [cutoff],
    );
    changes = result.changes;
    // Their local rows go with them (slice-16 §8).
    await txn.execAsync(PURGE_ORPHAN_LOCAL_ROWS);
  });
  return changes;
}
