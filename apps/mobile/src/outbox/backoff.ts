// Network, timeout and 5xx retries (slice-15 §7.4): 5 s, 30 s, 2 min, 10 min, 30 min, then every
// 30 min. No give-up: a weekend offline must still sync on Monday.

export const BACKOFF_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000, 1_800_000];

/** The wait after the `attempts`-th failed attempt (1-based). */
export function backoff(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1;
  return BACKOFF_MS[index] ?? 1_800_000;
}
