/**
 * Response cache in front of the upstream providers.
 *
 * Free weather APIs rate-limit by IP and this service is one IP. Caching is
 * therefore about protecting the upstream, not about saving the caller
 * money — every request that reaches a route still settles on chain, cached
 * or not. That is stated plainly in the README because it is the kind of
 * thing people assume the other way around.
 */

interface Entry {
  readonly body: string;
  readonly contentType: string;
  readonly storedAt: number;
}

export interface CacheLookup {
  readonly body: string;
  readonly contentType: string;
  /** Seconds the entry still has left — surfaced as an `Age`-style header. */
  readonly ageSeconds: number;
}

export class TtlCache {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlSeconds: number, maxEntries = 500) {
    this.ttlMs = Math.max(0, ttlSeconds) * 1000;
    this.maxEntries = maxEntries;
  }

  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  get(key: string): CacheLookup | null {
    if (!this.enabled) return null;
    const entry = this.entries.get(key);
    if (!entry) return null;
    const ageMs = Date.now() - entry.storedAt;
    if (ageMs >= this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return {
      body: entry.body,
      contentType: entry.contentType,
      ageSeconds: Math.floor(ageMs / 1000),
    };
  }

  put(key: string, body: string, contentType: string): void {
    if (!this.enabled) return;
    // Cheap eviction: Map preserves insertion order, so the oldest key is first.
    // Not LRU, but the working set here is small and bounded.
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { body, contentType, storedAt: Date.now() });
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
