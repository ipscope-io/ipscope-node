/**
 * @fileoverview Public TypeScript types for the `@ipscope/sdk-node` Server-Side SDK.
 *
 * Covers strictly IP-intelligence operations (single IP lookup, visitor IP lookup,
 * batch IP lookup, network CIDR prefix lookup, dataset metadata, feedback submission,
 * and service status) with zero account or billing surface area.
 */

/**
 * Supported Internet Protocol address families (`4` for IPv4, `6` for IPv6).
 */
export type IpFamily = 4 | 6;

/**
 * Classification of how a geographic location relates to network routing.
 */
export type LocationType =
  | 'physical'
  | 'declared'
  | 'virtual'
  | 'anycast'
  | 'unknown';

/**
 * Specific anonymizer classification subtype.
 */
export type AnonymizerType =
  | 'vpn'
  | 'proxy'
  | 'tor_exit'
  | 'tor_relay'
  | 'hosting_proxy'
  | 'apple_private_relay'
  | 'other_relay'
  | 'none'
  | 'unknown';

/**
 * Network connection context classification.
 */
export type ConnectionType =
  | 'residential'
  | 'mobile'
  | 'business'
  | 'hosting'
  | 'education'
  | 'government'
  | 'unknown';

/**
 * Geographic intelligence block returned in `IpLookupResponse.geo`.
 */
export interface GeoResponseBlock {
  readonly country_code: string | null;
  readonly subdivision?: string | null;
  readonly city: string | null;
  /** Postal / ZIP code when available in the city dataset, or null. */
  readonly postal_code?: string | null;
  /** Representative latitude of the network's location (never device GPS), or null. */
  readonly latitude?: number | null;
  /** Representative longitude of the network's location (never device GPS), or null. */
  readonly longitude?: number | null;
  readonly timezone?: string | null;
  readonly location_type: LocationType;
  readonly confidence: number;
  readonly accuracy_radius_km?: number | null;
  readonly declared_country_code?: string | null;
  readonly physical_country_code?: string | null;
  readonly is_virtual_location?: boolean | null;
}

/**
 * Autonomous System and network operator block returned in `IpLookupResponse.network`.
 */
export interface NetworkResponseBlock {
  readonly asn: number | null;
  readonly organization: string | null;
}

/**
 * Security, hosting, and anonymity intelligence block returned in `IpLookupResponse.security`.
 */
export interface SecurityResponseBlock {
  readonly is_vpn: boolean | null;
  readonly is_hosting: boolean | null;
  readonly is_tor_exit: boolean | null;
  readonly is_proxy: boolean | null;
  /**
   * True when the address is a published consumer privacy-relay egress (e.g. Apple
   * iCloud Private Relay). Relay users are not reported as VPN, proxy or hosting.
   * Absent or null when unknown.
   */
  readonly is_relay?: boolean | null;
  readonly anonymizer_type: AnonymizerType;
  readonly confidence: number;
  readonly reason_codes: readonly string[];
}

/**
 * Optional connection context block returned when licensed on the user's plan.
 */
export interface ConnectionResponseBlock {
  readonly connection_type: ConnectionType;
  readonly is_residential: boolean | null;
  readonly is_mobile: boolean | null;
  readonly is_business: boolean | null;
  readonly is_hosting: boolean | null;
}

/**
 * Optional security extensions block returned when licensed on the user's plan.
 */
export interface SecurityExtensionsResponseBlock {
  /**
   * Abuse velocity score on a 0–100 scale (integer), or null when unknown.
   * Typed as `number` so responses from older API builds that sent a 0.0–1.0
   * fraction still parse.
   */
  readonly abuse_velocity_score: number | null;
  readonly is_known_scanner: boolean | null;
  readonly observation_recency_hours: number | null;
}

/**
 * Canonical single IP lookup response (`GET /v1/ip/:ip` and `GET /v1/ip/me`).
 */
export interface IpLookupResponse {
  readonly ip: string;
  readonly ip_version: IpFamily;
  readonly matched_network: string | null;
  readonly geo: GeoResponseBlock;
  readonly network: NetworkResponseBlock;
  readonly security: SecurityResponseBlock;
  readonly connection?: ConnectionResponseBlock;
  readonly security_extensions?: SecurityExtensionsResponseBlock;
  readonly dataset_version: string;
  readonly updated_at: string | null;
}

/**
 * Batch IP lookup response (`POST /v1/ip/batch`).
 */
export interface BatchLookupResponse {
  readonly dataset_version: string;
  readonly count: number;
  readonly results: readonly IpLookupResponse[];
}

/**
 * Canonical network prefix record returned in `GET /v1/networks/:prefix/:length`.
 *
 * Unlike the lookup response, the snapshot record uses camelCase keys.
 */
export interface CanonicalNetworkPrefixRecord {
  readonly prefix: string;
  readonly family: IpFamily;
  readonly asn: number | null;
  readonly organization: string | null;
  readonly countryCode?: string | null;
  readonly subdivision?: string | null;
  readonly city?: string | null;
  readonly postalCode?: string | null;
  readonly latitude?: number | null;
  readonly longitude?: number | null;
  readonly timezone?: string | null;
  readonly locationType?: LocationType;
  readonly geoConfidence?: number;
  readonly accuracyRadiusKm?: number | null;
  readonly isVirtualLocation?: boolean | null;
  readonly connectionType?: ConnectionType;
  readonly isVpn?: boolean | null;
  readonly isHosting?: boolean | null;
  readonly isTorExit?: boolean | null;
  readonly isProxy?: boolean | null;
  readonly anonymizerType?: AnonymizerType;
  readonly securityConfidence?: number;
  /** Abuse velocity score (0–100), or null. */
  readonly abuseVelocityScore?: number | null;
  readonly isKnownScanner?: boolean | null;
  readonly reasonCodes?: readonly string[];
  readonly updatedAt?: string;
  readonly [key: string]: unknown;
}

/**
 * Network CIDR prefix lookup response (`GET /v1/networks/:prefix/:length`).
 */
export interface NetworkPrefixLookupResponse {
  readonly queried_cidr: string;
  /** Most-specific prefix in the active snapshot that covers `queried_cidr`. */
  readonly matched_network?: string;
  readonly family: IpFamily;
  /** Prefix length of `matched_network` (e.g. `24`). */
  readonly bgp_prefix_length?: number;
  readonly dataset_version: string;
  readonly record: CanonicalNetworkPrefixRecord | null;
  /** Full IP lookup response for the prefix's base address. */
  readonly lookup?: IpLookupResponse;
}

/**
 * Dataset snapshot summary entry returned in `GET /v1/metadata/datasets`.
 */
export interface DatasetSnapshotSummary {
  readonly snapshot_version: string;
  readonly digest: string;
  readonly ruleset_version: string;
  readonly published_at: string;
  readonly ipv4_prefix_count: number;
  readonly ipv6_prefix_count: number;
}

/**
 * Datasets metadata response (`GET /v1/metadata/datasets`).
 */
export interface DatasetsMetadataResponse {
  readonly active_version: string;
  readonly previous_version: string | null;
  readonly snapshots: readonly DatasetSnapshotSummary[];
}

/**
 * Submitter role for geolocation or anonymity correction feedback (`POST /v1/feedback`).
 */
export type FeedbackRole = 'network_owner' | 'user' | 'researcher';

/**
 * Role names shipped in 1.0.0 that the API never accepted.
 * The client maps `network_operator` to `network_owner` and `end_user` to `user`.
 *
 * @deprecated Use {@link FeedbackRole} values instead.
 */
export type LegacyFeedbackRole = 'network_operator' | 'end_user';

/**
 * Issue category for geolocation or anonymity correction feedback (`POST /v1/feedback`).
 */
export type FeedbackIssueType =
  | 'wrong_country'
  | 'wrong_city'
  | 'false_positive_vpn'
  | 'false_positive_hosting'
  | 'false_positive_tor'
  | 'virtual_location_mismatch'
  | 'other';

/**
 * Issue types shipped in 1.0.0 that the API never accepted. The client sends
 * them as `other` and records the original value in
 * `requested_correction.reported_issue_type`.
 *
 * @deprecated Use {@link FeedbackIssueType} values instead.
 */
export type LegacyFeedbackIssueType = 'false_negative_vpn' | 'wrong_asn';

/**
 * Input payload for submitting IP/prefix correction feedback (`POST /v1/feedback`).
 */
export interface FeedbackSubmissionInput {
  readonly prefix_or_ip: string;
  readonly role: FeedbackRole | LegacyFeedbackRole;
  readonly issue_type: FeedbackIssueType | LegacyFeedbackIssueType;
  readonly requested_correction: Record<string, unknown>;
  /** Public URL to geofeed / RDAP / traceroute evidence. */
  readonly evidence_url?: string;
  /** Whether you consent to follow-up contact (default: `false`). */
  readonly contact_consent?: boolean;
  /** Contact email for follow-up. */
  readonly contact_email?: string;
  /**
   * @deprecated The API accepts a single `evidence_url`. The first URL is sent as
   * `evidence_url`; when more than one is given, the full list is also sent as
   * `requested_correction.evidence_urls`.
   */
  readonly evidence_urls?: readonly string[];
}

/**
 * Response returned when submitting IP/prefix correction feedback (`POST /v1/feedback`).
 */
export interface FeedbackSubmissionResponse {
  readonly id: string;
  readonly prefix_or_ip: string;
  readonly role: FeedbackRole;
  readonly issue_type: FeedbackIssueType;
  readonly requested_correction: Record<string, unknown>;
  readonly evidence_url?: string;
  readonly contact_consent?: boolean;
  readonly contact_email?: string;
  /** ISO-8601 submission timestamp (the API sends camelCase `createdAt`). */
  readonly createdAt: string;
  /** Same value as `createdAt`; filled in by the SDK for snake_case consumers. */
  readonly created_at?: string;
  readonly status: string;
}

/**
 * Public service status and active snapshot health (`GET /v1/status`).
 */
export interface ServiceStatusResponse {
  readonly status: string;
  readonly snapshot?: {
    readonly currentVersion: string;
    readonly previousVersion: string | null;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

/**
 * Parsed user-scoped rate-limit headers returned by `@ipscope/api`.
 */
export interface RateLimitMetadata {
  /** Sustained rate limit per minute (`x-ratelimit-limit`). */
  readonly limitPerMinute: number | null;
  /** Remaining requests in the current window (`x-ratelimit-remaining`). */
  readonly remaining: number | null;
  /** Seconds until the rate-limit window resets (`x-ratelimit-reset`). */
  readonly resetAfterSeconds: number | null;
  /**
   * @deprecated Misnamed in 1.0.0: `x-ratelimit-reset` is a number of seconds
   * until reset, not a UNIX epoch. Holds the same value as `resetAfterSeconds`.
   */
  readonly resetEpochSeconds: number | null;
  /** Rate-limit enforcement scope (`x-ratelimit-scope`, e.g. `'user'`). */
  readonly scope: string | null;
  /** @deprecated The API does not send `x-ratelimit-burst`; always `null`. */
  readonly burstCapacity: number | null;
  /** @deprecated The API does not send `x-ratelimit-rps`; always `null`. */
  readonly rateLimitRps: number | null;
}

/**
 * Envelope containing both the typed API response data and HTTP/rate-limit metadata.
 */
export interface IpScopeResultWithMeta<T> {
  readonly data: T;
  readonly status: number;
  readonly rateLimit: RateLimitMetadata;
  readonly fromCache: boolean;
}

/**
 * Per-request options supported by all `IpScopeClient` methods.
 */
export interface RequestOptions {
  /** Optional `AbortSignal` to cancel an in-flight request. */
  readonly signal?: AbortSignal;
  /** Per-request timeout override in milliseconds. */
  readonly timeoutMs?: number;
  /** Bypass the in-memory LRU cache for this call (`true` forces a network fetch). */
  readonly bypassCache?: boolean;
  /** Optional additional HTTP headers to include on this request. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Options for `lookupBatchChunked` when looking up large IP arrays (>100 IPs).
 */
export interface BatchChunkedOptions extends RequestOptions {
  /** Maximum IPs per `/v1/ip/batch` request (1..100, default: `100`). */
  readonly chunkSize?: number;
  /** Maximum concurrent batch requests in flight (1..16, default: `4`). */
  readonly concurrency?: number;
}

/**
 * Retry policy configuration for transient network, 5xx, and 429 errors.
 */
export interface RetryOptions {
  /** Maximum retry attempts after the initial request (default: `2`). Set `0` to disable retries. */
  readonly maxRetries?: number;
  /** Base backoff delay in milliseconds (default: `150`). */
  readonly baseDelayMs?: number;
  /** Maximum backoff delay in milliseconds (default: `3000`). */
  readonly maxDelayMs?: number;
  /** Whether to automatically retry on `429 Too Many Requests` (default: `true`). */
  readonly retryOnRateLimit?: boolean;
}

/**
 * In-memory LRU + TTL cache configuration for `IpScopeClient`.
 */
export interface CacheOptions {
  /** Enable client-side in-memory LRU caching for IP & network lookups (default: `true`). */
  readonly enabled?: boolean;
  /** Maximum number of entries in the LRU cache (default: `512`). */
  readonly maxEntries?: number;
  /** Cache entry time-to-live in milliseconds (default: `60000` = 60s). */
  readonly ttlMs?: number;
}

/**
 * Configuration options for initializing `IpScopeClient`.
 */
export interface IpScopeClientOptions {
  /**
   * Your IPScope API key, in the form `<public>:<private>`.
   * Sent via `x-api-key` and `Authorization: Bearer <apiKey>`.
   */
  readonly apiKey: string;
  /**
   * Base URL of the IPScope API server (default: `'https://api.ipscope.io'`).
   */
  readonly baseUrl?: string;
  /**
   * Default request timeout in milliseconds (default: `5000`).
   */
  readonly timeoutMs?: number;
  /**
   * Automatic retry policy for `429` and transient `5xx` / network errors.
   */
  readonly retry?: RetryOptions;
  /**
   * Client-side O(1) LRU + TTL cache configuration.
   */
  readonly cache?: CacheOptions;
  /**
   * Custom `User-Agent` header prefix.
   */
  readonly userAgent?: string;
  /**
   * Optional custom `fetch` implementation (defaults to global `fetch`).
   * Useful for custom HTTP agents, proxies, or unit testing.
   */
  readonly fetch?: typeof globalThis.fetch;
}
