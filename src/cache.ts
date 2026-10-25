/**
 * @fileoverview O(1) In-Memory LRU + TTL Cache and In-Flight Singleflight
 * Request Coalescer (`LruTtlCache`).
 *
 * Uses V8's `Map` insertion-order iterator for O(1) get/set/eviction and
 * coalesces concurrent requests for the same key so parallel lookups for the
 * same IP address share a single HTTP round-trip.
 */

export interface CacheStats {
  readonly enabled: boolean;
  readonly size: number;
  readonly maxEntries: number;
  readonly ttlMs: number;
  readonly hits: number;
  readonly misses: number;
  readonly coalescedInFlightHits: number;
}

interface CacheEntry<V> {
  readonly value: V;
  readonly expiresAtMs: number;
}

/**
 * Bounded O(1) Least-Recently-Used (LRU) cache with time-to-live (TTL)
 * expiration and in-flight Promise deduplication.
 */
export class LruTtlCache<V> {
  private readonly store = new Map<string, CacheEntry<V>>();
  private readonly inFlight = new Map<string, Promise<V>>();
  private readonly enabled: boolean;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private hits = 0;
  private misses = 0;
  private coalescedInFlightHits = 0;

  constructor(options: {
    enabled?: boolean;
    maxEntries?: number;
    ttlMs?: number;
  } = {}) {
    this.enabled = options.enabled ?? true;
    this.maxEntries = Math.max(1, options.maxEntries ?? 512);
    this.ttlMs = Math.max(100, options.ttlMs ?? 60_000);
  }

  /**
   * Retrieves a non-expired value from the cache and promotes it to MRU position.
   *
   * @complexity Time: O(1). Space: O(1).
   */
  get(key: string, nowMs = Date.now()): V | undefined {
    if (!this.enabled) {
      this.misses += 1;
      return undefined;
    }
    const entry = this.store.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAtMs <= nowMs) {
      this.store.delete(key);
      this.misses += 1;
      return undefined;
    }
    // Promote to most-recently-used by re-inserting
    this.store.delete(key);
    this.store.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  /**
   * Stores a value in the cache, evicting expired or oldest LRU entries if
   * `maxEntries` is reached.
   *
   * @complexity Time: O(1). Space: O(1).
   */
  set(key: string, value: V, nowMs = Date.now()): void {
    if (!this.enabled) return;

    if (this.store.has(key)) {
      this.store.delete(key);
    } else {
      // Opportunistically evict expired entries at the oldest end of the Map
      for (const [k, entry] of this.store) {
        if (entry.expiresAtMs <= nowMs || this.store.size >= this.maxEntries) {
          this.store.delete(k);
        }
        if (this.store.size < this.maxEntries) {
          break;
        }
      }
    }

    this.store.set(key, {
      value,
      expiresAtMs: nowMs + this.ttlMs,
    });
  }

  /**
   * Deduplicates concurrent asynchronous producers for the same cache key
   * (singleflight pattern). Even when persistent caching is disabled, concurrent
   * in-flight calls share the same Promise and free it in `finally`.
   */
  async getOrCompute(
    key: string,
    bypassCache: boolean,
    producer: () => Promise<V>,
  ): Promise<{ value: V; fromCache: boolean }> {
    if (!bypassCache) {
      if (this.enabled) {
        const cached = this.get(key);
        if (cached !== undefined) {
          return { value: cached, fromCache: true };
        }
      }

      const existingFlight = this.inFlight.get(key);
      if (existingFlight) {
        this.coalescedInFlightHits += 1;
        const value = await existingFlight;
        return { value, fromCache: true };
      }
    }

    const promise = (async () => {
      try {
        const result = await producer();
        if (this.enabled && !bypassCache) {
          this.set(key, result);
        }
        return result;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    if (!bypassCache) {
      this.inFlight.set(key, promise);
    }

    const value = await promise;
    return { value, fromCache: false };
  }

  /**
   * Clears all cached entries and resets hit/miss counters.
   */
  clear(): void {
    this.store.clear();
    this.inFlight.clear();
    this.hits = 0;
    this.misses = 0;
    this.coalescedInFlightHits = 0;
  }

  /**
   * Returns current cache telemetry.
   */
  getStats(): CacheStats {
    return {
      enabled: this.enabled,
      size: this.store.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
      hits: this.hits,
      misses: this.misses,
      coalescedInFlightHits: this.coalescedInFlightHits,
    };
  }
}
