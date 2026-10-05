import { z } from 'zod';
import { getDb } from './database';

// Read responses keyed by endpoint and canonical params, stamped with the server's time of the
// last refresh — the "as of" shown on screen (slice-15 §7.2). Evicted after 30 days.

const CACHE_MAX_AGE_DAYS = 30;

export type CacheParams = Record<string, string | number | undefined>;

/** `GET <path>?<params sorted by name>`; undefined params are left out. */
export function cacheKey(path: string, params: CacheParams = {}): string {
  const query = Object.keys(params)
    .filter((name) => params[name] !== undefined)
    .sort()
    .map((name) => `${encodeURIComponent(name)}=${encodeURIComponent(String(params[name]))}`)
    .join('&');
  return query === '' ? `GET ${path}` : `GET ${path}?${query}`;
}

export type Cached<T> = {
  body: T;
  /** ISO instant: the response's Date header, or the device clock when it had none. */
  serverTime: string;
  serverTimeIsDevice: boolean;
};

/** The "as of" of a response: its Date header, else the device clock, flagged. */
export function asOf(
  dateHeader: string | null,
  now: Date = new Date(),
): Omit<Cached<unknown>, 'body'> {
  const parsed = dateHeader === null ? Number.NaN : Date.parse(dateHeader);
  return Number.isNaN(parsed)
    ? { serverTime: now.toISOString(), serverTimeIsDevice: true }
    : { serverTime: new Date(parsed).toISOString(), serverTimeIsDevice: false };
}

const Row = z.object({
  body: z.string(),
  server_time: z.string(),
  server_time_is_device: z.number(),
});

export async function readCache<T>(key: string): Promise<Cached<T> | null> {
  const db = await getDb();
  const raw = await db.getFirstAsync<unknown>(
    'SELECT body, server_time, server_time_is_device FROM cache WHERE key = ?',
    [key],
  );
  if (raw === null) return null;
  const row = Row.parse(raw);
  return {
    body: JSON.parse(row.body) as T,
    serverTime: row.server_time,
    serverTimeIsDevice: row.server_time_is_device === 1,
  };
}

export async function writeCache<T>(
  key: string,
  body: T,
  dateHeader: string | null,
  now: Date = new Date(),
): Promise<Cached<T>> {
  const stamp = asOf(dateHeader, now);
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO cache (key, body, server_time, server_time_is_device, fetched_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET body = excluded.body, server_time = excluded.server_time,
       server_time_is_device = excluded.server_time_is_device, fetched_at = excluded.fetched_at`,
    [
      key,
      JSON.stringify(body),
      stamp.serverTime,
      stamp.serverTimeIsDevice ? 1 : 0,
      now.toISOString(),
    ],
  );
  return { body, ...stamp };
}

/** Deletes rows fetched more than 30 days ago. Returns the number deleted. */
export async function evictCache(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - CACHE_MAX_AGE_DAYS * 24 * 60 * 60_000).toISOString();
  const db = await getDb();
  const result = await db.runAsync('DELETE FROM cache WHERE fetched_at < ?', [cutoff]);
  return result.changes;
}
