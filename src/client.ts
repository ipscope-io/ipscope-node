/**
 * @fileoverview Official IPScope Node.js Server-Side Client (`IpScopeClient`).
 *
 * Provides strictly IP-intelligence operations (single IP lookup, visitor IP
 * lookup, batch & chunked batch IP lookup, network CIDR prefix inspection,
 * dataset snapshot metadata, geolocation/anonymity feedback submission, and
 * service status) with:
 * - Full compile-time TypeScript safety and runtime input validation
 * - O(1) LRU + TTL caching and in-flight singleflight request coalescing
 * - Batch deduplication & cache-aware batch hydration
 * - User-scoped rate-limit header tracking (`x-ratelimit-*`)
 * - Exponential backoff with jitter on `429` and transient `5xx` errors
 */

import { CacheStats, LruTtlCache } from './cache';
import { IpScopeValidationError } from './errors';
import { IpScopeHttpClient } from './http-client';
import {
  BatchChunkedOptions,
  BatchLookupResponse,
  DatasetsMetadataResponse,
  FeedbackSubmissionInput,
  FeedbackSubmissionResponse,
  IpLookupResponse,
  IpScopeClientOptions,
  IpScopeResultWithMeta,
  NetworkPrefixLookupResponse,
  RateLimitMetadata,
  RequestOptions,
  ServiceStatusResponse,
} from './types';
import {
  validateAndDeduplicateBatchIps,
  validateCidrPrefix,
  validateIpAddress,
} from './validation';

const MAX_SINGLE_BATCH_SIZE = 100;

/**
 * Official IPScope Node.js Server-Side SDK Client.
 *
 * @example
 * ```ts
 * import { IpScopeClient } from '@ipscope/sdk-node';
 *
 * const ipscope = new IpScopeClient({
 *   apiKey: process.env.IPSCOPE_API_KEY!,
 * });
 *
 * const single = await ipscope.lookupIp('1.1.1.1');
 * const batch = await ipscope.lookupBatch(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']);
 * ```
 */
export class IpScopeClient {
  private readonly http: IpScopeHttpClient;
  private readonly ipCache: LruTtlCache<IpLookupResponse>;
  private readonly networkCache: LruTtlCache<NetworkPrefixLookupResponse>;

  constructor(options: IpScopeClientOptions) {
    if (!options || typeof options !== 'object') {
      throw new IpScopeValidationError(
        'IpScopeClientOptions object is required',
        'options',
      );
    }
    this.http = new IpScopeHttpClient(options);
    this.ipCache = new LruTtlCache<IpLookupResponse>(options.cache);
    this.networkCache = new LruTtlCache<NetworkPrefixLookupResponse>({
      ...options.cache,
      maxEntries: Math.min(128, options.cache?.maxEntries ?? 128),
    });
  }

  /**
   * Looks up geolocation, ASN, hosting, connection, and anonymity intelligence
   * for a single IPv4 or IPv6 address (`GET /v1/ip/:ip`).
   *
   * Concurrent calls for the same IP are automatically coalesced into a single
   * HTTP request and cached in the O(1) LRU cache.
   */
  async lookupIp(
    rawIp: string,
    options?: RequestOptions,
  ): Promise<IpLookupResponse> {
    const result = await this.lookupIpWithMeta(rawIp, options);
    return result.data;
  }

  /**
   * Looks up a single IPv4 or IPv6 address and returns both the `IpLookupResponse`
   * and response metadata (`status`, `rateLimit`, `fromCache`).
   */
  async lookupIpWithMeta(
    rawIp: string,
    options?: RequestOptions,
  ): Promise<IpScopeResultWithMeta<IpLookupResponse>> {
    const { ip } = validateIpAddress(rawIp);
    const bypassCache = options?.bypassCache ?? false;

    let lastStatus = 200;
    let lastRateLimit: RateLimitMetadata = this.http.getLastRateLimit() ?? {
      limitPerMinute: null,
      remaining: null,
      resetEpochSeconds: null,
      scope: null,
      burstCapacity: null,
      rateLimitRps: null,
    };

    const { value, fromCache } = await this.ipCache.getOrCompute(
      ip,
      bypassCache,
      async () => {
        const res = await this.http.request<IpLookupResponse>({
          method: 'GET',
          path: `/v1/ip/${encodeURIComponent(ip)}`,
          options,
        });
        lastStatus = res.status;
        lastRateLimit = res.rateLimit;
        return res.data;
      },
    );

    return {
      data: value,
      status: lastStatus,
      rateLimit: this.http.getLastRateLimit() ?? lastRateLimit,
      fromCache,
    };
  }

  /**
   * Looks up intelligence for the caller's own server-observed IP address
   * (`GET /v1/ip/me`).
   */
  async lookupCallerIp(options?: RequestOptions): Promise<IpLookupResponse> {
    const res = await this.http.request<IpLookupResponse>({
      method: 'GET',
      path: '/v1/ip/me',
      options,
    });
    return res.data;
  }

  /**
   * Performs a batch lookup for 1..100 IPv4/IPv6 addresses (`POST /v1/ip/batch`).
   *
   * Optimizations:
   * 1. Validates all IPs locally before making any network request.
   * 2. Reuses warm LRU cache entries when `bypassCache` is not set.
   * 3. Deduplicates duplicate IPs within the batch so only unique cache-miss IPs
   *    are sent over the wire.
   * 4. Populates the LRU cache with newly fetched results and returns the full
   *    array in the exact order requested by the caller.
   */
  async lookupBatch(
    rawIps: readonly string[],
    options?: RequestOptions,
  ): Promise<BatchLookupResponse> {
    const { orderedNormalizedIps, uniqueIps } = validateAndDeduplicateBatchIps(
      rawIps,
      MAX_SINGLE_BATCH_SIZE,
    );
    const bypassCache = options?.bypassCache ?? false;

    const resolvedByInputIp = new Map<string, IpLookupResponse>();
    const missingIps: string[] = [];

    if (!bypassCache) {
      for (const ip of uniqueIps) {
        const cached = this.ipCache.get(ip);
        if (cached) {
          resolvedByInputIp.set(ip, cached);
        } else {
          missingIps.push(ip);
        }
      }
    } else {
      missingIps.push(...uniqueIps);
    }

    let datasetVersion = '';

    if (missingIps.length > 0) {
      const res = await this.http.request<BatchLookupResponse>({
        method: 'POST',
        path: '/v1/ip/batch',
        body: { ips: missingIps },
        options,
      });

      datasetVersion = res.data.dataset_version;
      for (let i = 0; i < missingIps.length; i++) {
        const requestedIp = missingIps[i]!;
        const item = res.data.results[i];
        if (item) {
          resolvedByInputIp.set(requestedIp, item);
          this.ipCache.set(requestedIp, item);
          const canonicalLower = item.ip.toLowerCase();
          if (canonicalLower !== requestedIp) {
            this.ipCache.set(canonicalLower, item);
          }
        }
      }
    }

    const orderedResults: IpLookupResponse[] = orderedNormalizedIps.map(
      (ip) => resolvedByInputIp.get(ip)!,
    );

    if (!datasetVersion && orderedResults.length > 0) {
      datasetVersion = orderedResults[0]!.dataset_version;
    }

    return {
      dataset_version: datasetVersion,
      count: orderedResults.length,
      results: orderedResults,
    };
  }

  /**
   * Performs a batch lookup for arbitrarily large IP lists (e.g., 500 or 5,000 IPs)
   * by automatically deduplicating, chunking into batches of up to 100 IPs, and
   * executing with bounded concurrency (`default: 4`).
   */
  async lookupBatchChunked(
    rawIps: readonly string[],
    options?: BatchChunkedOptions,
  ): Promise<BatchLookupResponse> {
    if (!Array.isArray(rawIps) || rawIps.length === 0) {
      throw new IpScopeValidationError(
        'Batch IPs array must contain at least 1 IP address',
        'ips',
      );
    }

    const chunkSize = Math.min(
      MAX_SINGLE_BATCH_SIZE,
      Math.max(1, options?.chunkSize ?? MAX_SINGLE_BATCH_SIZE),
    );
    const concurrency = Math.min(
      16,
      Math.max(1, options?.concurrency ?? 4),
    );

    const orderedNormalizedIps: string[] = new Array(rawIps.length);
    const uniqueSet = new Set<string>();
    for (let i = 0; i < rawIps.length; i++) {
      const { ip } = validateIpAddress(rawIps[i]);
      orderedNormalizedIps[i] = ip;
      uniqueSet.add(ip);
    }

    const uniqueIps = Array.from(uniqueSet);
    const chunks: string[][] = [];
    for (let i = 0; i < uniqueIps.length; i += chunkSize) {
      chunks.push(uniqueIps.slice(i, i + chunkSize));
    }

    const resolvedByIp = new Map<string, IpLookupResponse>();
    let datasetVersion = '';
    let nextChunkIdx = 0;

    const worker = async (): Promise<void> => {
      while (nextChunkIdx < chunks.length) {
        const idx = nextChunkIdx++;
        const chunk = chunks[idx];
        if (!chunk) break;
        const batchRes = await this.lookupBatch(chunk, options);
        if (!datasetVersion && batchRes.dataset_version) {
          datasetVersion = batchRes.dataset_version;
        }
        for (let i = 0; i < chunk.length; i++) {
          const item = batchRes.results[i];
          if (item) {
            resolvedByIp.set(chunk[i]!, item);
          }
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, chunks.length) },
      () => worker(),
    );
    await Promise.all(workers);

    const orderedResults = orderedNormalizedIps.map(
      (ip) => resolvedByIp.get(ip)!,
    );

    return {
      dataset_version: datasetVersion,
      count: orderedResults.length,
      results: orderedResults,
    };
  }

  /**
   * Constant-RAM async generator (`for await (const batch of client.lookupBatchStream(ips))`)
   * for streaming very large IP lists (10,000+ IPs) in chunks of up to 100 IPs
   * without holding the entire output array in memory at once.
   */
  async *lookupBatchStream(
    rawIps: Iterable<string>,
    options?: BatchChunkedOptions,
  ): AsyncGenerator<BatchLookupResponse, void, undefined> {
    const chunkSize = Math.min(
      MAX_SINGLE_BATCH_SIZE,
      Math.max(1, options?.chunkSize ?? MAX_SINGLE_BATCH_SIZE),
    );
    let currentChunk: string[] = [];

    for (const rawIp of rawIps) {
      const { ip } = validateIpAddress(rawIp);
      currentChunk.push(ip);
      if (currentChunk.length >= chunkSize) {
        const toSend = currentChunk;
        currentChunk = [];
        yield await this.lookupBatch(toSend, options);
      }
    }

    if (currentChunk.length > 0) {
      yield await this.lookupBatch(currentChunk, options);
    }
  }

  /**
   * Inspects canonical network prefix intelligence by CIDR notation
   * (`GET /v1/networks/:prefix/:length`, e.g. `"1.1.1.0/24"` or `"2606:4700::/32"`).
   */
  async lookupNetwork(
    rawCidr: string,
    options?: RequestOptions,
  ): Promise<NetworkPrefixLookupResponse> {
    const { address, prefixLength, normalizedCidr } =
      validateCidrPrefix(rawCidr);
    const bypassCache = options?.bypassCache ?? false;

    const { value } = await this.networkCache.getOrCompute(
      normalizedCidr,
      bypassCache,
      async () => {
        const res = await this.http.request<NetworkPrefixLookupResponse>({
          method: 'GET',
          path: `/v1/networks/${encodeURIComponent(address)}/${prefixLength}`,
          options,
        });
        return res.data;
      },
    );

    return value;
  }

  /**
   * Lists active and historical dataset snapshot versions (`GET /v1/metadata/datasets`).
   */
  async getDatasetsMetadata(
    options?: RequestOptions,
  ): Promise<DatasetsMetadataResponse> {
    const res = await this.http.request<DatasetsMetadataResponse>({
      method: 'GET',
      path: '/v1/metadata/datasets',
      options,
    });
    return res.data;
  }

  /**
   * Submits geolocation, ASN, or anonymity correction feedback (`POST /v1/feedback`).
   */
  async submitFeedback(
    input: FeedbackSubmissionInput,
    options?: RequestOptions,
  ): Promise<FeedbackSubmissionResponse> {
    if (!input || typeof input !== 'object') {
      throw new IpScopeValidationError(
        'Feedback submission input object is required',
        'input',
      );
    }
    const prefixOrIp =
      typeof input.prefix_or_ip === 'string' ? input.prefix_or_ip.trim() : '';
    if (!prefixOrIp) {
      throw new IpScopeValidationError(
        'prefix_or_ip must be a non-empty IP address or CIDR string',
        'prefix_or_ip',
      );
    }
    if (prefixOrIp.includes('/')) {
      validateCidrPrefix(prefixOrIp);
    } else {
      validateIpAddress(prefixOrIp);
    }

    const res = await this.http.request<FeedbackSubmissionResponse>({
      method: 'POST',
      path: '/v1/feedback',
      body: {
        ...input,
        prefix_or_ip: prefixOrIp,
      },
      options,
    });
    return res.data;
  }

  /**
   * Fetches public service health and active snapshot status (`GET /v1/status`).
   */
  async getStatus(options?: RequestOptions): Promise<ServiceStatusResponse> {
    const res = await this.http.request<ServiceStatusResponse>({
      method: 'GET',
      path: '/v1/status',
      options,
      requiresAuth: false,
    });
    return res.data;
  }

  /**
   * Returns the most recently observed user-scoped rate-limit headers
   * (`x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`, etc.),
   * or `null` if no HTTP response has been received yet.
   */
  getLastRateLimit(): RateLimitMetadata | null {
    return this.http.getLastRateLimit();
  }

  /**
   * Returns current hit/miss/coalescing statistics for the in-memory IP LRU cache.
   */
  getCacheStats(): CacheStats {
    return this.ipCache.getStats();
  }

  /**
   * Clears the in-memory IP and network prefix LRU caches.
   */
  clearCache(): void {
    this.ipCache.clear();
    this.networkCache.clear();
  }
}

/**
 * Convenience factory function to create an `IpScopeClient` instance.
 */
export function createIpScopeClient(
  options: IpScopeClientOptions,
): IpScopeClient {
  return new IpScopeClient(options);
}
