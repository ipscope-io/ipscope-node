<div align="center">
  <br />
  <a href="https://ipscope.io">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/ipscope-io/.github/main/assets/logo-dark.svg" />
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/ipscope-io/.github/main/assets/logo-light.svg" />
      <img alt="ipscope" src="https://raw.githubusercontent.com/ipscope-io/.github/main/assets/logo-light.svg" height="32" />
    </picture>
  </a>
  <h1>@ipscope/sdk-node</h1>
  <p><strong>Official Node.js and TypeScript server SDK for ipscope — IP geolocation, BGP ASN, and VPN/proxy detection</strong></p>
  <p>
    <a href="https://www.npmjs.com/package/@ipscope/sdk-node"><img src="https://img.shields.io/npm/v/@ipscope/sdk-node.svg?style=flat-square&label=npm&color=0f172a" alt="npm version" /></a>
    <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-0f172a?style=flat-square" alt="Node >= 18" />
    <img src="https://img.shields.io/badge/typescript-strict-0f172a?style=flat-square" alt="TypeScript" />
    <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-0f172a?style=flat-square" alt="MIT licence" /></a>
    <a href="https://ipscope.io/docs/sdks/node"><img src="https://img.shields.io/badge/docs-ipscope.io-0f172a?style=flat-square" alt="Documentation" /></a>
  </p>
  <br />
  <a href="https://ipscope.io">
    <img alt="ipscope Node.js SDK" src="https://raw.githubusercontent.com/ipscope-io/.github/main/assets/banner.webp" width="100%" />
  </a>
</div>

<br />

## What is this

`@ipscope/sdk-node` is the zero-dependency, strictly typed Node.js and TypeScript server SDK for [ipscope](https://ipscope.io). Use it in your backend, API gateway, or edge worker to query the [ipscope REST API](https://ipscope.io/products/api) for physical and declared [IP geolocation](https://ipscope.io/products/geolocation), [BGP origin ASN and prefix routing](https://ipscope.io/products/network), and [VPN, residential proxy, Tor exit, and relay detection](https://ipscope.io/products/privacy).

Every `IpScopeClient` instance includes a bounded `O(1)` in-memory LRU + TTL cache (`maxEntries: 512` default, `< 400 KB` heap footprint), singleflight request coalescing for concurrent lookups of the same IP, a hard `2 MiB` streaming body guard, and an `AsyncGenerator` batch stream for enriching 10,000+ IP addresses in constant memory. Need offline, in-process lookups with zero network calls? See the [downloadable MMDB, CSV.gz, and Parquet databases](https://ipscope.io/products/databases).

---

## Getting started

### 1. Get an API key

Create a free account at [dashboard.ipscope.io](https://dashboard.ipscope.io/auth/login) and copy your server API key (`<public>:<private>`).

### 2. Install the package

```bash
npm install @ipscope/sdk-node
# or
pnpm add @ipscope/sdk-node
```

### 3. Look up an IP address

```ts
import { IpScopeClient } from '@ipscope/sdk-node';

const client = new IpScopeClient({
  apiKey: process.env.IPSCOPE_API_KEY!, // "<public>:<private>"
});

const info = await client.lookupIp('8.8.8.8');

console.log(info.ip, info.geo.country_code, info.network.asn, info.network.organization);
console.log('VPN:', info.security.is_vpn, 'Hosting:', info.security.is_hosting);
```

---

## Contents

- [Lookups](#lookups)
- [Streaming large IP lists](#streaming-large-ip-lists)
- [Network CIDR prefix lookups](#network-cidr-prefix-lookups)
- [Reading the response](#reading-the-response)
- [Rate-limit metadata](#rate-limit-metadata)
- [Submitting feedback](#submitting-feedback)
- [Configuration](#configuration)
- [Error handling](#error-handling)
- [Requirements](#requirements)
- [Documentation](#documentation)
- [Help](#help)
- [Licence](#licence)

---

## Lookups

Look up a single IPv4 or IPv6 address, the caller's own public IP, or a batch of up to 100 addresses in one round-trip. Duplicate addresses within a batch are deduplicated automatically and resolved from the local LRU cache when warm.

```ts
// 1. Single IPv4 or IPv6 lookup (cached in bounded LRU & singleflight-coalesced)
const ipInfo = await client.lookupIp('2606:4700:4700::1111');

// 2. Caller IP lookup (GET /v1/ip/me)
const caller = await client.lookupCallerIp();

// 3. Batch lookup (up to 100 IPs per request)
const batch = await client.lookupBatch([
  '8.8.8.8',
  '1.1.1.1',
  '2606:4700:4700::1111',
]);
for (const record of batch.results) {
  console.log(`${record.ip} -> AS${record.network.asn} (${record.network.organization})`);
}

// 4. Chunked batch lookup for >100 IPs with bounded concurrency (default: 4)
const largeBatch = await client.lookupBatchChunked(hundredsOfIps, { concurrency: 4 });
```

---

## Streaming large IP lists

When enriching log files or security events containing 10,000+ IP addresses, `lookupBatchStream` yields 100-IP chunks as an `AsyncGenerator` so heap usage stays flat regardless of input size:

```ts
for await (const chunk of client.lookupBatchStream(largeIpIterable)) {
  for (const record of chunk.results) {
    console.log(record.ip, record.geo.country_code, record.security.is_vpn);
  }
}
```

---

## Network CIDR prefix lookups

Inspect the longest-matching routed BGP prefix and its base address intelligence via `lookupNetwork`:

```ts
const prefix = await client.lookupNetwork('8.8.8.0/24');
console.log(
  `${prefix.queried_cidr} matched ${prefix.matched_network} (/${prefix.bgp_prefix_length}) in ${prefix.dataset_version}`,
);
if (prefix.record) {
  console.log('Prefix country:', prefix.record.country_code, 'Hosting:', prefix.record.is_hosting);
}
if (prefix.lookup) {
  console.log('Base address city:', prefix.lookup.geo.city);
}
```

---

## Reading the response

- **`geo`**: `country_code`, `country_name`, `region_code`, `region_name`, `city`, `postal_code`, `latitude`, `longitude`, `timezone`, `is_eu_member`, `accuracy_radius_km`, `location_basis` (`"physical"` or `"declared"`). Coordinates are representative city/area centres, never device GPS.
- **`network`**: `asn`, `organization`, `isp`, `domain`, `rir`, `bgp_prefix`, `bgp_prefix_length`, `is_anycast`, `is_ixp`.
- **`connection`** (`null` on Free): `connection_type` (`"residential"`, `"corporate"`, `"cellular"`, `"hosting"`, `"education"`, `"satellite"`, `"ixp"`), `routing_type`, `carrier_name`, `mcc`, `mnc`.
- **`security`**: `is_vpn`, `is_proxy`, `is_tor_exit`, `is_relay` (consumer privacy relays such as iCloud Private Relay), `is_hosting`, `anonymizer_type`, `vpn_provider`, `confidence`. Security flags are tri-state (`true | false | null`), where `null` indicates insufficient evidence rather than a guess.
- **`security_extensions`** (Business & Enterprise): `is_known_attacker`, `is_scanner`, `is_botnet`, `is_bogon`, `is_Residential_proxy`, `abuse_velocity_score` (`0`–`100`).

---

## Rate-limit metadata

Use `lookupIpWithMeta` (or any `*WithMeta` method) to read the parsed `X-RateLimit-*` headers alongside the response:

```ts
const { data, rateLimit } = await client.lookupIpWithMeta('1.1.1.1');
console.log(
  `${rateLimit.remaining}/${rateLimit.limitPerMinute} left, resets in ${rateLimit.resetAfterSeconds}s (scope: ${rateLimit.scope})`,
);
```

---

## Submitting feedback

Network operators and researchers can submit geolocation or anonymity corrections directly from the SDK:

```ts
const receipt = await client.submitFeedback({
  prefix_or_ip: '203.0.113.0/24',
  role: 'network_owner', // 'network_owner' | 'user' | 'researcher'
  issue_type: 'wrong_country',
  requested_correction: { country_code: 'DE', city: 'Frankfurt' },
  evidence_url: 'https://example.net/geofeed.csv',
  contact_consent: true,
  contact_email: 'noc@example.net',
});
console.log(receipt.id, receipt.status, receipt.created_at);
```

---

## Configuration

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `apiKey` | `string` | *(required)* | Server API key (`<public>:<private>`). |
| `baseUrl` | `string` | `'https://api.ipscope.io'` | Base URL of the ipscope API. |
| `timeoutMs` | `number` | `5000` | Per-request timeout in milliseconds. |
| `maxRetries` | `number` | `2` | Automatic retries on transient `429` / `5xx` responses with jittered backoff. |
| `cacheMaxEntries` | `number` | `512` | Maximum entries in the bounded `O(1)` LRU cache (`0` disables caching). |
| `cacheTtlMs` | `number` | `60000` | Cache TTL in milliseconds. |

---

## Error handling

All SDK errors extend `IpScopeError` and expose `code`, `statusCode`, and `retryAfterSeconds` (when rate-limited):

```ts
import { IpScopeError } from '@ipscope/sdk-node';

try {
  await client.lookupIp('8.8.8.8');
} catch (err) {
  if (err instanceof IpScopeError) {
    console.error(err.code, err.statusCode, err.message);
  }
}
```

---

## Requirements

- Node.js 18 or later (uses built-in `fetch`, `AbortSignal`, and Web Streams; zero external runtime dependencies).
- TypeScript 5.0 or later (optional; `.d.ts` declarations are bundled).

---

## Documentation

| Topic | Link |
| :--- | :--- |
| Node.js SDK guide | [ipscope.io/docs/sdks/node](https://ipscope.io/docs/sdks/node) |
| REST API overview | [ipscope.io/docs/api/overview](https://ipscope.io/docs/api/overview) |
| Single & batch IP lookups | [ipscope.io/docs/api/single-ip](https://ipscope.io/docs/api/single-ip) |
| Network CIDR prefix lookups | [ipscope.io/docs/api/network-prefix](https://ipscope.io/docs/api/network-prefix) |
| Errors & rate limits | [ipscope.io/docs/api/errors](https://ipscope.io/docs/api/errors) |
| Downloadable MMDB databases | [ipscope.io/docs/databases/mmdb](https://ipscope.io/docs/databases/mmdb) |

---

## Help

- Bugs and feature requests: [open an issue](https://github.com/ipscope-io/ipscope-node/issues)
- Account, billing and integration questions: [contact@ipscope.io](mailto:contact@ipscope.io)
- Security vulnerabilities: see the [security policy](https://github.com/ipscope-io/.github/blob/main/SECURITY.md)

---

## Licence

[MIT](LICENSE). Made by [ipscope](https://ipscope.io).
