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
  /** Seconds since the entry was stored — surfaced as an `Age`-style header. */
  readonly ageSeconds: number;
  /** True when the entry is past its TTL and is being served while it refreshes. */
  readonly stale: boolean;
}

export class TtlCache {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly staleMs: number;
  private readonly maxEntries: number;

  constructor(ttlSeconds: number, maxEntries = 500, staleSeconds = 0) {
    this.ttlMs = Math.max(0, ttlSeconds) * 1000;
    // The stale window is what makes the difference between "the upstream is
    // slow" and "the service is down" for the caller: an entry that expired
    // half a minute ago is still a usable answer, and serving it costs the
    // upstream nothing.
    this.staleMs = Math.max(0, staleSeconds) * 1000;
    this.maxEntries = maxEntries;
  }

  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  /** Seconds past the TTL that an entry stays servable. Zero disables it. */
  get staleWindowSeconds(): number {
    return Math.floor(this.staleMs / 1000);
  }

  /**
   * A fresh entry, or null. Entry removal happens here rather than on a timer:
   * an entry is dropped the first time somebody looks and finds it beyond even
   * the stale window.
   */
  get(key: string): CacheLookup | null {
    if (!this.enabled) return null;
    const found = this.live(key);
    if (!found || found.ageMs >= this.ttlMs) return null;
    return {
      body: found.entry.body,
      contentType: found.entry.contentType,
      ageSeconds: Math.floor(found.ageMs / 1000),
      stale: false,
    };
  }

  /** An entry past its TTL but still inside the stale window, if there is one. */
  getStale(key: string): CacheLookup | null {
    if (!this.enabled || this.staleMs <= 0) return null;
    const found = this.live(key);
    if (!found || found.ageMs < this.ttlMs) return null;
    return {
      body: found.entry.body,
      contentType: found.entry.contentType,
      ageSeconds: Math.floor(found.ageMs / 1000),
      stale: true,
    };
  }

  /** The entry if it exists at all and has not aged out of both windows. */
  private live(key: string): { entry: Entry; ageMs: number } | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    const ageMs = Date.now() - entry.storedAt;
    if (ageMs >= this.ttlMs + this.staleMs) {
      this.entries.delete(key);
      return null;
    }
    return { entry, ageMs };
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
