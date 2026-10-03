import { ErrorCode } from '@asms/shared';
import { ApiException, notFound } from './errors/api-exception';

/** Reads before giving up when the row keeps changing between the read and the lock. */
const ATTEMPTS = 3;

/**
 * Reads a row and locks it only if it still holds what was read (otherwise reads again), so the
 * caller decides on current data under the lock. `lock` is a repository's lockIfUnchanged: a
 * compare-and-set UPDATE that holds the row lock to the end of the transaction. `missing` is the
 * refusal for an absent row. Call inside a transaction.
 */
export async function readLocked<T>(
  read: () => Promise<T | null>,
  lock: (row: T) => Promise<boolean>,
  missing: () => ApiException = notFound,
): Promise<T> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const row = await read();
    if (row === null) throw missing();
    if (await lock(row)) return row;
  }
  throw new ApiException(
    409,
    ErrorCode.CONCURRENT_UPDATE,
    'The record changed while this request ran. Reload and try again.',
  );
}
