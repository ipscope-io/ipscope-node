# Changelog

## 1.1.0 — 2026-11-10

### Added
- `geo.latitude`, `geo.longitude` and `geo.postal_code` on `GeoResponseBlock`.
- `security.is_relay` on `SecurityResponseBlock` (consumer privacy relays such as
  iCloud Private Relay).
- `matched_network`, `bgp_prefix_length` and `lookup` (the full `IpLookupResponse`)
  on `NetworkPrefixLookupResponse`, plus the remaining camelCase fields of the
  snapshot record (`latitude`, `postalCode`, `geoConfidence`, `abuseVelocityScore`, …).
- `RateLimitMetadata.resetAfterSeconds`: seconds until the rate-limit window resets.
- `lookupBatchStream` accepts `AsyncIterable<string>` (async generators, `readline`)
  as well as `Iterable<string>`.
- Feedback: `evidence_url`, `contact_consent`, `contact_email`; response gets
  `created_at` alongside the API's `createdAt`.
- `SDK_VERSION` and `EMPTY_RATE_LIMIT` exports.

### Fixed
- Feedback `role` and `issue_type` now use the values the API accepts
  (`network_owner | user | researcher`; `wrong_country | wrong_city |
  false_positive_vpn | false_positive_hosting | false_positive_tor |
  virtual_location_mismatch | other`). In 1.0.0 most submissions failed with `400`.
- 429 retry fallback: without `Retry-After`, the client now waits
  `X-RateLimit-Reset` seconds. 1.0.0 treated the header as a UNIX epoch, so the
  fallback never fired.
- `abuse_velocity_score` is documented as a 0–100 score.
- JSDoc: cache `maxEntries` default is 512 (was documented as 5000); API key format
  is `<public>:<private>`.
- README: accurate module-format note (CommonJS, importable from ESM), runnable examples.

### Deprecated
- `RateLimitMetadata.resetEpochSeconds`: same value as `resetAfterSeconds` (seconds,
  not an epoch).
- `RateLimitMetadata.burstCapacity` and `rateLimitRps`: the API never sends these
  headers; always `null`.
- Feedback roles `network_operator`, `end_user` (sent as `network_owner`, `user`) and
  issue types `false_negative_vpn`, `wrong_asn` (sent as `other`, with the original in
  `requested_correction.reported_issue_type`).
- Feedback `evidence_urls`: the first URL is sent as `evidence_url`; if there are
  several, the full list is also sent as `requested_correction.evidence_urls`.

## 1.0.0

- Initial release.
