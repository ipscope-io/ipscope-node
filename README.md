# `@ipscope/sdk-node`

Official, zero-dependency, type-safe Node.js Server-Side SDK for **IPScope IP Intelligence**.

Provides strictly IP-related lookup operations (no account, wallet, or billing operations):
- Single IPv4 / IPv6 lookup (`lookupIp`, `lookupIpWithMeta`)
- Caller / visitor IP lookup (`lookupCallerIp`)
- Batch IP lookup up to 100 IPs (`lookupBatch`) with automatic cache hydration & deduplication
- Large-scale chunked batch IP lookup (`lookupBatchChunked`) with bounded concurrency
- Canonical network CIDR prefix inspection (`lookupNetwork`)
- Dataset snapshot metadata (`getDatasetsMetadata`)
- Geolocation / anonymity correction feedback (`submitFeedback`)
- Service health & active snapshot status (`getStatus`)

## Quick Start

```ts
import { IpScopeClient } from '@ipscope/sdk-node';

const ipscope = new IpScopeClient({
  apiKey: process.env.IPSCOPE_API_KEY!,
  baseUrl: 'https://api.ipscope.io', // optional
  timeoutMs: 5000,                   // optional (default: 5000ms)
  cache: {
    enabled: true,                   // O(1) LRU + TTL cache & singleflight coalescing
    maxEntries: 5000,
    ttlMs: 60_000,
  },
  retry: {
    maxRetries: 2,
    retryOnRateLimit: true,
  },
});

// 1. Single IPv4 or IPv6 lookup
const res = await ipscope.lookupIp('1.1.1.1');
console.log(res.geo.country_code, res.network.asn, res.security.is_vpn);

// 2. Batch lookup (1..100 IPs)
const batch = await ipscope.lookupBatch([
  '1.1.1.1',
  '8.8.8.8',
  '2606:4700:4700::1111',
]);
console.log(batch.dataset_version, batch.results.length);

// 3. Large list lookup (>100 IPs, auto-chunked with bounded concurrency)
const largeBatch = await ipscope.lookupBatchChunked(manyIps, {
  chunkSize: 100,
  concurrency: 4,
});

// 4. Inspect network CIDR prefix
const netInfo = await ipscope.lookupNetwork('1.1.1.0/24');
console.log(netInfo.queried_cidr, netInfo.record?.asn);
```
