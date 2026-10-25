/**
 * @fileoverview Unit and integration tests for `@ipscope/sdk-node`.
 */

import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  createIpScopeClient,
  IpLookupResponse,
  IpScopeAuthenticationError,
  IpScopeClient,
  IpScopeRateLimitError,
  IpScopeTimeoutError,
  IpScopeValidationError,
} from './index';

function buildFixtureIpResponse(ip: string): IpLookupResponse {
  return {
    ip,
    ip_version: ip.includes(':') ? 6 : 4,
    matched_network: ip.includes(':') ? '2606:4700::/32' : '1.1.1.0/24',
    geo: {
      country_code: 'US',
      city: 'San Francisco',
      location_type: 'anycast',
      confidence: 0.96,
    },
    network: {
      asn: 13335,
      organization: 'Cloudflare, Inc.',
    },
    security: {
      is_vpn: false,
      is_hosting: true,
      is_tor_exit: false,
      is_proxy: false,
      anonymizer_type: 'none',
      confidence: 0.98,
      reason_codes: ['ASN_CLOUDFLARE_ANYCAST'],
    },
    dataset_version: '2026-10-25T00:00:00Z.v1',
    updated_at: '2026-10-25T00:00:00Z',
  };
}

describe('@ipscope/sdk-node (Official Node.js Server-Side SDK)', () => {
  it('validates API keys, IPv4/IPv6 addresses, CIDR prefixes, and exposes zero account/billing methods', () => {
    expect(() => createIpScopeClient({ apiKey: '' })).toThrow(
      IpScopeValidationError,
    );
    expect(() =>
      createIpScopeClient({ apiKey: 'ips_live_bad\r\ninjection' }),
    ).toThrow(IpScopeValidationError);

    const client = createIpScopeClient({
      apiKey: 'ips_live_valid_key_12345',
    });

    // Verify no account, billing, wallet, or key management methods exist on IpScopeClient
    const protoMethods = Object.getOwnPropertyNames(IpScopeClient.prototype);
    expect(protoMethods).not.toContain('createApiKey');
    expect(protoMethods).not.toContain('revokeApiKey');
    expect(protoMethods).not.toContain('getWallet');
    expect(protoMethods).not.toContain('createCheckout');
    expect(protoMethods).not.toContain('getMe');
  });

  it('performs single IP lookups, parses user rate-limit headers, caches in O(1) LRU, and coalesces concurrent in-flight requests', async () => {
    let fetchCalls = 0;
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      fetchCalls += 1;
      const headers = new Headers(init?.headers);
      expect(headers.get('x-api-key')).toBe('ips_live_test_sdk_key');
      expect(headers.get('authorization')).toBe('Bearer ips_live_test_sdk_key');

      await new Promise((r) => setTimeout(r, 15));
      const url = String(input);
      const ip = decodeURIComponent(url.split('/v1/ip/')[1] ?? '1.1.1.1');

      return new Response(JSON.stringify(buildFixtureIpResponse(ip)), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-limit': '1800',
          'x-ratelimit-remaining': '1799',
          'x-ratelimit-reset': '1792920000',
          'x-ratelimit-scope': 'user',
          'x-ratelimit-burst': '150',
          'x-ratelimit-rps': '30',
        },
      });
    };

    const client = createIpScopeClient({
      apiKey: 'ips_live_test_sdk_key',
      baseUrl: 'https://api.ipscope.test',
      fetch: mockFetch,
    });

    // Reject invalid IP locally before touching network
    await expect(client.lookupIp('not-an-ip')).rejects.toThrow(
      IpScopeValidationError,
    );
    expect(fetchCalls).toBe(0);

    // Fire 5 concurrent lookups for 1.1.1.1 -> coalesced into a single HTTP request!
    const concurrentResults = await Promise.all([
      client.lookupIpWithMeta('1.1.1.1'),
      client.lookupIpWithMeta('1.1.1.1'),
      client.lookupIpWithMeta('1.1.1.1'),
      client.lookupIpWithMeta('1.1.1.1'),
      client.lookupIpWithMeta('1.1.1.1'),
    ]);

    expect(fetchCalls).toBe(1);
    for (const res of concurrentResults) {
      expect(res.data.ip).toBe('1.1.1.1');
      expect(res.data.network.asn).toBe(13335);
    }

    // Subsequent lookup hits warm LRU cache with 0 additional HTTP requests
    const cachedRes = await client.lookupIpWithMeta('1.1.1.1');
    expect(cachedRes.fromCache).toBe(true);
    expect(fetchCalls).toBe(1);

    const stats = client.getCacheStats();
    expect(stats.hits).toBe(1);
    expect(stats.coalescedInFlightHits).toBe(4);

    // Verify parsed user-scoped rate-limit headers
    const rl = client.getLastRateLimit();
    expect(rl).toEqual({
      limitPerMinute: 1800,
      remaining: 1799,
      resetEpochSeconds: 1792920000,
      scope: 'user',
      burstCapacity: 150,
      rateLimitRps: 30,
    });
  });

  it('deduplicates batch IPs, reuses warm cache entries, and supports chunked batch lookups (>100 IPs)', async () => {
    const sentBatches: string[][] = [];
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/ip/batch')) {
        const body = JSON.parse(String(init?.body)) as { ips: string[] };
        sentBatches.push(body.ips);
        return new Response(
          JSON.stringify({
            dataset_version: '2026-10-25T00:00:00Z.v1',
            count: body.ips.length,
            results: body.ips.map((ip) => buildFixtureIpResponse(ip)),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const client = createIpScopeClient({
      apiKey: 'ips_live_batch_key',
      fetch: mockFetch,
    });

    // Batch with duplicates: ['1.1.1.1', '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']
    const batch1 = await client.lookupBatch([
      '1.1.1.1',
      '8.8.8.8',
      '1.1.1.1',
      '2606:4700:4700::1111',
    ]);
    expect(sentBatches).toHaveLength(1);
    // Only the 3 unique IPs were sent over the wire
    expect(sentBatches[0]).toEqual([
      '1.1.1.1',
      '8.8.8.8',
      '2606:4700:4700::1111',
    ]);
    // Returned results match all 4 caller positions in order
    expect(batch1.count).toBe(4);
    expect(batch1.results.map((r) => r.ip)).toEqual([
      '1.1.1.1',
      '8.8.8.8',
      '1.1.1.1',
      '2606:4700:4700::1111',
    ]);

    // Second batch where '1.1.1.1' and '8.8.8.8' are already in cache, and only '9.9.9.9' is new
    const batch2 = await client.lookupBatch(['1.1.1.1', '9.9.9.9', '8.8.8.8']);
    expect(sentBatches).toHaveLength(2);
    expect(sentBatches[1]).toEqual(['9.9.9.9']);
    expect(batch2.results.map((r) => r.ip)).toEqual([
      '1.1.1.1',
      '9.9.9.9',
      '8.8.8.8',
    ]);

    // Chunked batch for 150 unique IPs -> splits into chunks of 100 and 50
    client.clearCache();
    sentBatches.length = 0;
    const largeList = Array.from(
      { length: 150 },
      (_, i) => `10.0.${Math.floor(i / 250)}.${(i % 250) + 1}`,
    );
    const chunkedRes = await client.lookupBatchChunked(largeList, {
      chunkSize: 100,
      concurrency: 2,
    });
    expect(sentBatches).toHaveLength(2);
    expect(sentBatches[0]).toHaveLength(100);
    expect(sentBatches[1]).toHaveLength(50);
    expect(chunkedRes.count).toBe(150);
    expect(chunkedRes.results[0]?.ip).toBe('10.0.0.1');
    expect(chunkedRes.results[149]?.ip).toBe('10.0.0.150');
  });

  it('supports network CIDR lookup, caller IP lookup, dataset metadata, feedback submission, and status', async () => {
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/ip/me')) {
        return new Response(JSON.stringify(buildFixtureIpResponse('203.0.113.5')), {
          status: 200,
        });
      }
      if (url.endsWith('/v1/networks/1.1.1.0/24')) {
        return new Response(
          JSON.stringify({
            queried_cidr: '1.1.1.0/24',
            family: 4,
            dataset_version: '2026-10-25T00:00:00Z.v1',
            record: {
              prefix: '1.1.1.0/24',
              family: 4,
              asn: 13335,
              organization: 'Cloudflare, Inc.',
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/v1/metadata/datasets')) {
        return new Response(
          JSON.stringify({
            active_version: '2026-10-25T00:00:00Z.v1',
            previous_version: null,
            snapshots: [
              {
                snapshot_version: '2026-10-25T00:00:00Z.v1',
                digest: 'abc123',
                ruleset_version: 'v1',
                published_at: '2026-10-25T00:00:00Z',
                ipv4_prefix_count: 1000,
                ipv6_prefix_count: 500,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/v1/feedback') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            id: 'fb_test_123',
            ...body,
            createdAt: '2026-10-25T00:00:00Z',
            status: 'pending_review',
          }),
          { status: 201 },
        );
      }
      if (url.endsWith('/v1/status')) {
        return new Response(
          JSON.stringify({
            status: 'healthy',
            snapshot: { currentVersion: '2026-10-25T00:00:00Z.v1', previousVersion: null },
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const client = createIpScopeClient({
      apiKey: 'ips_live_ops_key',
      fetch: mockFetch,
    });

    const caller = await client.lookupCallerIp();
    expect(caller.ip).toBe('203.0.113.5');

    const netRes = await client.lookupNetwork('1.1.1.0/24');
    expect(netRes.queried_cidr).toBe('1.1.1.0/24');
    expect(netRes.record?.asn).toBe(13335);

    const ds = await client.getDatasetsMetadata();
    expect(ds.active_version).toBe('2026-10-25T00:00:00Z.v1');

    const fb = await client.submitFeedback({
      prefix_or_ip: '1.1.1.0/24',
      role: 'network_operator',
      issue_type: 'wrong_city',
      requested_correction: { city: 'Los Angeles' },
    });
    expect(fb.id).toBe('fb_test_123');
    expect(fb.status).toBe('pending_review');

    const status = await client.getStatus();
    expect(status.status).toBe('healthy');
  });

  it('retries automatically on 429 rate-limit and 503 transient errors, and throws typed errors on 401/429/timeout', async () => {
    let attempts = 0;
    const retryFetch: typeof globalThis.fetch = async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ message: 'Rate limit exceeded' }), {
          status: 429,
          headers: { 'retry-after': '0.01' },
        });
      }
      if (attempts === 2) {
        return new Response(JSON.stringify({ message: 'Bad Gateway' }), {
          status: 502,
        });
      }
      return new Response(JSON.stringify(buildFixtureIpResponse('8.8.8.8')), {
        status: 200,
      });
    };

    const retryClient = createIpScopeClient({
      apiKey: 'ips_live_retry_key',
      fetch: retryFetch,
      retry: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50 },
    });

    const recovered = await retryClient.lookupIp('8.8.8.8');
    expect(recovered.ip).toBe('8.8.8.8');
    expect(attempts).toBe(3);

    // 401 Unauthorized throws IpScopeAuthenticationError without retrying
    let authCalls = 0;
    const unauthorizedClient = createIpScopeClient({
      apiKey: 'ips_live_revoked_key',
      fetch: async () => {
        authCalls += 1;
        return new Response(JSON.stringify({ message: 'Invalid API key' }), {
          status: 401,
        });
      },
    });
    await expect(unauthorizedClient.lookupIp('1.1.1.1')).rejects.toThrow(
      IpScopeAuthenticationError,
    );
    expect(authCalls).toBe(1);

    // Exhausted 429 throws IpScopeRateLimitError
    const rateLimitedClient = createIpScopeClient({
      apiKey: 'ips_live_rl_key',
      retry: { maxRetries: 0 },
      fetch: async () =>
        new Response(JSON.stringify({ message: 'User rate limit exceeded' }), {
          status: 429,
          headers: { 'retry-after': '2' },
        }),
    });
    await expect(rateLimitedClient.lookupIp('1.1.1.1')).rejects.toThrow(
      IpScopeRateLimitError,
    );

    // Timeout throws IpScopeTimeoutError
    const slowClient = createIpScopeClient({
      apiKey: 'ips_live_slow_key',
      timeoutMs: 100,
      retry: { maxRetries: 0 },
      fetch: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const abortErr = new Error('The operation was aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
          });
        }),
    });
    await expect(slowClient.lookupIp('1.1.1.1')).rejects.toThrow(
      IpScopeTimeoutError,
    );
  });

  it('prevents memory leaks: strictly bounds LRU cache size, cleans up rejected in-flight promises, and removes all AbortSignal listeners in finally blocks', async () => {
    const sharedAbortController = new AbortController();
    let shouldFail = false;

    const client = createIpScopeClient({
      apiKey: 'ips_live_leak_test_key',
      cache: { enabled: true, maxEntries: 3, ttlMs: 60_000 },
      retry: { maxRetries: 1, baseDelayMs: 5, maxDelayMs: 10 },
      fetch: async (input) => {
        if (shouldFail) {
          return new Response(JSON.stringify({ message: 'Server error' }), {
            status: 500,
          });
        }
        const url = String(input);
        const ip = decodeURIComponent(url.split('/v1/ip/')[1] ?? '1.1.1.1');
        return new Response(JSON.stringify(buildFixtureIpResponse(ip)), {
          status: 200,
        });
      },
    });

    // 1. Insert 50 unique IPs with a reused AbortSignal -> cache size must never exceed maxEntries (3)
    for (let i = 1; i <= 50; i++) {
      await client.lookupIp(`192.0.2.${i}`, {
        signal: sharedAbortController.signal,
      });
      expect(client.getCacheStats().size).toBeLessThanOrEqual(3);
    }
    expect(client.getCacheStats().size).toBe(3);

    // 2. Reused AbortSignal must have 0 lingering 'abort' listeners after 50 requests
    expect(getEventListeners(sharedAbortController.signal, 'abort')).toHaveLength(
      0,
    );

    // 3. Rejected in-flight request cleans up inFlight map so a subsequent retry succeeds cleanly
    shouldFail = true;
    await expect(
      Promise.all([
        client.lookupIp('198.51.100.77', {
          signal: sharedAbortController.signal,
        }),
        client.lookupIp('198.51.100.77', {
          signal: sharedAbortController.signal,
        }),
      ]),
    ).rejects.toThrow();

    expect(getEventListeners(sharedAbortController.signal, 'abort')).toHaveLength(
      0,
    );

    shouldFail = false;
    const recoveredAfterFailure = await client.lookupIp('198.51.100.77', {
      signal: sharedAbortController.signal,
    });
    expect(recoveredAfterFailure.ip).toBe('198.51.100.77');
    expect(getEventListeners(sharedAbortController.signal, 'abort')).toHaveLength(
      0,
    );

    // 4. Rejects oversized upstream payloads (> 2 MiB) via Content-Length guard before buffering
    const oversizedClient = createIpScopeClient({
      apiKey: 'ips_live_oversized_guard',
      retry: { maxRetries: 0 },
      fetch: async () =>
        new Response('too big', {
          status: 200,
          headers: { 'content-length': String(10 * 1024 * 1024) },
        }),
    });
    await expect(oversizedClient.lookupIp('1.1.1.1')).rejects.toThrow(
      /exceeds 2 MiB safety limit/,
    );
  });
});
