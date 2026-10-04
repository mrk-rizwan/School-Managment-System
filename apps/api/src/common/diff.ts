import type { MarkOutcome } from '@asms/shared';

/** One changed field as the audit log records it. A type alias, so it fits audit metadata. */
export type FieldChange<V> = { from: V; to: V };

type Defined<T> = Exclude<T, undefined>;

/** The changed fields' requested values (for the write) and their audit `changes`. */
export interface FieldDiff<W, K extends keyof W, V> {
  data: { [P in K]?: Defined<W[P]> };
  changes: Record<string, FieldChange<V>>;
}

/**
 * A PATCH compared with the row it changes. A key is changed when `wanted` holds it (not
 * `undefined`; `null` is a value) and `normalise(wanted) !== normalise(current)`, so values are
 * compared with `===` after `normalise` (default: as they are). `data` holds the changed keys'
 * requested values as given; `changes` their before and after values, normalised. No change:
 * both are empty.
 */
export function diffFields<
  K extends string,
  C extends Record<K, unknown>,
  W extends Partial<Record<K, unknown>>,
>(current: C, wanted: W, keys: readonly K[]): FieldDiff<W, K, C[K] | Defined<W[K]>>;
export function diffFields<
  K extends string,
  C extends Record<K, unknown>,
  W extends Partial<Record<K, unknown>>,
  V,
>(
  current: C,
  wanted: W,
  keys: readonly K[],
  normalise: (value: C[K] | Defined<W[K]>) => V,
): FieldDiff<W, K, V>;
export function diffFields(
  current: Record<string, unknown>,
  wanted: Record<string, unknown>,
  keys: readonly string[],
  normalise: (value: unknown) => unknown = (value) => value,
): { data: Record<string, unknown>; changes: Record<string, FieldChange<unknown>> } {
  const data: Record<string, unknown> = {};
  const changes: Record<string, FieldChange<unknown>> = {};
  for (const key of keys) {
    const to = wanted[key];
    if (to === undefined) continue;
    const before = normalise(current[key]);
    const after = normalise(to);
    if (after === before) continue;
    data[key] = to;
    changes[key] = { from: before, to: after };
  }
  return { data, changes };
}

/** One submitted mark against the stored row of the same key (slice-11 §4.2, slice-12 §4.2). */
export interface MarkDiff<I, R> {
  item: I;
  outcome: MarkOutcome;
  existing: R | undefined;
}

/**
 * A register or staff-sheet submit against the rows it read under their locks: `created` when no
 * row has the item's key, `unchanged` when `same` holds, else `amended`. Item order is kept.
 */
export function diffMarks<I, R, K>(
  items: readonly I[],
  current: ReadonlyMap<K, R>,
  keyOf: (item: I) => K,
  same: (item: I, row: R) => boolean,
): MarkDiff<I, R>[] {
  return items.map((item) => {
    const existing = current.get(keyOf(item));
    const outcome: MarkOutcome =
      existing === undefined ? 'created' : same(item, existing) ? 'unchanged' : 'amended';
    return { item, outcome, existing };
  });
}
