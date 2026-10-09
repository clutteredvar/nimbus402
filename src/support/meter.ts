/**
 * In-process usage counters.
 *
 * Deliberately dumb: a Map of counters, reset by a restart. Enough to answer
 * "is this service actually being used, and for which endpoints" from a
 * health probe, without standing up a metrics stack. If this ever needs to
 * survive a deploy it should become a real sink, not a bigger Map.
 */

interface MutableUsage {
  fetched: number;
  cached: number;
  stale: number;
  coalesced: number;
  settled: number;
  collected: bigint;
}

export interface RouteUsage {
  /** Requests that got a fresh upstream response. */
  readonly fetched: number;
  /** Requests served from cache instead of hitting the upstream. */
  readonly cached: number;
  /** Requests served a past-TTL entry while a refresh ran behind them. */
  readonly stale: number;
  /** Requests that waited on an upstream call that was already running. */
  readonly coalesced: number;
  /** Requests that settled on chain. */
  readonly settled: number;
  /** Atomic units collected on this route. */
  readonly collected: bigint;
}

export class UsageMeter {
  private readonly perRoute = new Map<string, MutableUsage>();
  private readonly payers = new Set<string>();
  private readonly startedAt = Date.now();

  private bucket(route: string): MutableUsage {
    const existing = this.perRoute.get(route);
    if (existing) return existing;
    const fresh: MutableUsage = { fetched: 0, cached: 0, stale: 0, coalesced: 0, settled: 0, collected: 0n };
    this.perRoute.set(route, fresh);
    return fresh;
  }

  recordFetch(route: string): void {
    this.bucket(route).fetched += 1;
  }

  recordCacheHit(route: string): void {
    this.bucket(route).cached += 1;
  }

  /** A past-TTL entry was handed to the caller; a refresh is running behind it. */
  recordStaleServed(route: string): void {
    this.bucket(route).stale += 1;
  }

  /** The caller rode along on an upstream call that was already in flight. */
  recordCoalesced(route: string): void {
    this.bucket(route).coalesced += 1;
  }

  /** Called after the facilitator confirms settlement for a paid call. */
  recordSettlement(route: string, payer: string | undefined, atomicAmount: string | undefined): void {
    const usage = this.bucket(route);
    usage.settled += 1;
    if (atomicAmount) {
      try {
        usage.collected += BigInt(atomicAmount);
      } catch {
        // A malformed amount from the facilitator is not worth failing a
        // successfully-served response over, but it should be visible.
        usage.collected += 0n;
      }
    }
    if (payer) this.payers.add(payer.toLowerCase());
  }

  uptimeSeconds(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  snapshot(): {
    uptimeSeconds: number;
    uniquePayers: number;
    totalSettled: number;
    routes: Record<
      string,
      { fetched: number; cached: number; stale: number; coalesced: number; settled: number; collected: string }
    >;
  } {
    const routes: Record<
      string,
      { fetched: number; cached: number; stale: number; coalesced: number; settled: number; collected: string }
    > = {};
    let totalSettled = 0;
    for (const [route, usage] of this.perRoute) {
      routes[route] = {
        fetched: usage.fetched,
        cached: usage.cached,
        stale: usage.stale,
        coalesced: usage.coalesced,
        settled: usage.settled,
        collected: usage.collected.toString(),
      };
      totalSettled += usage.settled;
    }
    return {
      uptimeSeconds: this.uptimeSeconds(),
      uniquePayers: this.payers.size,
      totalSettled,
      routes,
    };
  }

  reset(): void {
    this.perRoute.clear();
    this.payers.clear();
  }
}
