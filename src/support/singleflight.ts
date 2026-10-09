/**
 * In-flight request coalescing.
 *
 * The upstreams behind this service rate-limit by IP, and the service is one
 * IP. A popular point — a city at 6am, a grid cell someone is polling — draws
 * several callers at once, and without coalescing each of them opens its own
 * connection to open-meteo for a byte-identical answer. Under a burst that is
 * how the quota disappears and every caller starts getting 502s.
 *
 * So: the first caller for a key does the work, everyone who arrives while it
 * is still running waits on the same promise. Callers are still billed
 * individually — coalescing is about protecting the upstream, not about
 * giving the second caller a free ride. See the README.
 */

export class SingleFlight<T> {
  private readonly inflight = new Map<string, Promise<T>>();
  private joinedCount = 0;

  /**
   * Run `work` for `key`, or wait on the run already in progress.
   *
   * `onJoin` fires for callers that piggybacked instead of starting their own
   * run, so the caller can tell the difference in its metrics.
   */
  run(key: string, work: () => Promise<T>, onJoin?: () => void): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) {
      this.joinedCount += 1;
      onJoin?.();
      return existing;
    }

    // The async wrapper turns a synchronous throw inside `work` into a
    // rejection, so every caller sees the same failure mode.
    const promise = (async () => await work())();
    this.inflight.set(key, promise);
    const release = () => {
      // Identity check: a later run for the same key must not be evicted by
      // this one settling.
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    };
    void promise.then(release, release);
    return promise;
  }

  /** Number of keys with a run in progress right now. */
  get size(): number {
    return this.inflight.size;
  }

  /** Callers that waited on someone else's run over this instance's lifetime. */
  get joined(): number {
    return this.joinedCount;
  }
}
