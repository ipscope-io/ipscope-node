# `@ipscope/sdk-node`

Official, zero-dependency, type-safe Node.js Server-Side SDK for **IPScope IP Intelligence**.

Provides strictly IP-related lookup operations (no account, wallet, or billing operations):
- Single IPv4 / IPv6 lookup (`lookupIp`, `lookupIpWithMeta`)
- Caller / visitor IP lookup (`lookupCallerIp`)
- Batch IP lookup up to 100 IPs (`lookupBatch`) with automatic cache hydration & deduplication
- Large-scale chunked batch IP lookup (`lookupBatchChunked`) with bounded concurrency
- Constant-memory streaming over any `Iterable<string>` or `AsyncIterable<string>` (`lookupBatchStream`)
- Canonical network CIDR prefix inspection (`lookupNetwork`)
- Dataset snapshot metadata (`getDatasetsMetadata`)
- Geolocation / anonymity correction feedback (`submitFeedback`)
- Service health & active snapshot status (`getStatus`)

## Install

```sh
npm install @ipscope/sdk-node
```

Requires Node.js 18+. The package is published as CommonJS with TypeScript
declarations. ES modules can import it too, through Node's CommonJS interop:
`import { IpScopeClient } from '@ipscope/sdk-node'` works, as does `require`.

## Quick Start

API keys have the form `<public>:<private>`.

```ts
import { IpScopeClient } from '@ipscope/sdk-node';

const ipscope = new IpScopeClient({
  apiKey: process.env.IPSCOPE_API_KEY!, // "<public>:<private>"
  baseUrl: 'https://api.ipscope.io', // optional
  timeoutMs: 5000,                   // optional (default: 5000ms)
  cache: {
    enabled: true,                   // O(1) LRU + TTL cache & singleflight coalescing
    maxEntries: 512,                 // default: 512
    ttlMs: 60_000,                   // default: 60s
  },
  retry: {
    maxRetries: 2,
    retryOnRateLimit: true,
  },
});

// 1. Single IPv4 or IPv6 lookup
const res = await ipscope.lookupIp('1.1.1.1');
console.log(res.geo.country_code, res.geo.latitude, res.geo.longitude);
console.log(res.network.asn, res.security.is_vpn, res.security.is_relay);
// Abuse velocity score, 0–100 (when security_extensions is on your plan)
console.log(res.security_extensions?.abuse_velocity_score);

// 2. Batch lookup (1..100 IPs)
const batch = await ipscope.lookupBatch([
  '1.1.1.1',
  '8.8.8.8',
  '2606:4700:4700::1111',
]);
console.log(batch.dataset_version, batch.results.length);

// 3. Large list lookup (>100 IPs, auto-chunked with bounded concurrency)
const manyIps = Array.from({ length: 250 }, (_, i) => `10.0.${i >> 8}.${i & 255}`);
const largeBatch = await ipscope.lookupBatchChunked(manyIps, {
  chunkSize: 100,
  concurrency: 4,
});
console.log(largeBatch.count);

// 4. Inspect network CIDR prefix
const netInfo = await ipscope.lookupNetwork('1.1.1.0/24');
console.log(netInfo.queried_cidr, netInfo.matched_network, netInfo.bgp_prefix_length);
console.log(netInfo.record?.asn, netInfo.lookup?.geo.country_code);
```

## Streaming large lists

`lookupBatchStream` reads its input lazily, so a file with millions of lines
never sits in memory. It accepts arrays, sets, generators, async generators and
`readline` interfaces.

```ts
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { IpScopeClient } from '@ipscope/sdk-node';

const ipscope = new IpScopeClient({ apiKey: process.env.IPSCOPE_API_KEY! });
const lines = createInterface({ input: createReadStream('ips.txt') });

for await (const chunk of ipscope.lookupBatchStream(lines, { chunkSize: 100 })) {
  for (const r of chunk.results) {
    console.log(r.ip, r.geo.country_code);
  }
}
```

## Rate limits

Every authenticated response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
`X-RateLimit-Reset` (seconds until the window resets) and `X-RateLimit-Scope`.

```ts
const { data, rateLimit } = await ipscope.lookupIpWithMeta('8.8.8.8');
console.log(data.ip, rateLimit.remaining, rateLimit.resetAfterSeconds);
```

On `429`, the client waits for `Retry-After` (or, failing that, `X-RateLimit-Reset`),
capped by `retry.maxDelayMs`, and retries. `resetEpochSeconds` is a deprecated alias of
`resetAfterSeconds` (same value in seconds); `burstCapacity` and `rateLimitRps` are
deprecated and always `null`.

## Feedback

```ts
const fb = await ipscope.submitFeedback({
  prefix_or_ip: '203.0.113.0/24',
  role: 'network_owner',            // 'network_owner' | 'user' | 'researcher'
  issue_type: 'wrong_city',         // see FeedbackIssueType
  requested_correction: { city: 'Amsterdam', country_code: 'NL' },
  evidence_url: 'https://example.net/geofeed.csv',
  contact_consent: true,
  contact_email: 'noc@example.net',
});
console.log(fb.id, fb.status, fb.createdAt);
```

`issue_type` is one of `wrong_country`, `wrong_city`, `false_positive_vpn`,
`false_positive_hosting`, `false_positive_tor`, `virtual_location_mismatch`, `other`.
