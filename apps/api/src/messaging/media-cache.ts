/**
 * An announcement's attachment is the same object for every recipient, so a fan-out to 3,000
 * parents would read one 5 MB PDF from object storage 3,000 times (15 GB; security review of slice
 * 14). The message processor reads it through this per-process cache instead: one read per object
 * key while an entry lives, concurrent reads of one key share the read in flight, and a failed
 * read is not kept. Keys are `{school_id}/{ULID}.{ext}`: an object never changes under its key, so
 * the time limit bounds memory, not staleness. The caller asserts the school prefix before asking.
 */
export class MediaCache {
  readonly #entries = new Map<string, { bytes: Promise<Buffer>; size: number; expiresAt: number }>();
  #bytes = 0;

  /**
   * @param ttlMs how long an entry lives after its read: a fan-out's message jobs run within
   *   minutes of each other (concurrency 10), and a paced WhatsApp retry comes back within the hour.
   * @param maxBytes the most the cache holds: six 5 MB attachments. The oldest goes first.
   */
  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly maxBytes = 32 * 1024 * 1024,
  ) {}

  /** The bytes under `key`, read with `load` only when no live entry holds them. */
  async get(key: string, load: () => Promise<Buffer>, now: number = Date.now()): Promise<Buffer> {
    this.evict(now);
    const hit = this.#entries.get(key);
    if (hit) return hit.bytes;
    const entry = { bytes: load(), size: 0, expiresAt: now + this.ttlMs };
    this.#entries.set(key, entry);
    try {
      const bytes = await entry.bytes;
      if (this.#entries.get(key) === entry) {
        entry.size = bytes.length;
        this.#bytes += bytes.length;
        this.evict(now);
      }
      return bytes;
    } catch (error) {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
      throw error;
    }
  }

  /** Bytes held (for tests). */
  get size(): number {
    return this.#bytes;
  }

  private evict(now: number): void {
    for (const [key, entry] of this.#entries) {
      // Map order is insertion order: expired first, then the oldest while over the cap.
      if (entry.expiresAt > now && this.#bytes <= this.maxBytes) break;
      this.#entries.delete(key);
      this.#bytes -= entry.size;
    }
  }
}
