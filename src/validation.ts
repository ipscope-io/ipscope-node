/**
 * @fileoverview Client-side IPv4/IPv6, CIDR prefix, and API key validation utilities
 * using Node.js native `node:net`.
 *
 * Validates inputs locally before network round-trips and prevents URL path
 * traversal or header injection.
 */

import net from 'node:net';
import { IpScopeValidationError } from './errors';
import { IpFamily } from './types';

/**
 * Validates and normalizes an IPScope API key.
 * Rejects empty strings or keys containing control/newline characters that
 * could cause HTTP header injection.
 */
export function validateApiKey(rawApiKey: unknown): string {
  if (typeof rawApiKey !== 'string') {
    throw new IpScopeValidationError(
      'API key must be a non-empty string',
      'apiKey',
    );
  }
  const trimmed = rawApiKey.trim();
  if (trimmed.length === 0) {
    throw new IpScopeValidationError('API key cannot be empty', 'apiKey');
  }
  if (/[\r\n\0]/.test(trimmed)) {
    throw new IpScopeValidationError(
      'API key contains invalid control characters',
      'apiKey',
    );
  }
  return trimmed;
}

/**
 * Validates an IPv4 or IPv6 address string using Node's native `net.isIP`.
 * Returns the trimmed IP string and its family (`4` or `6`).
 */
export function validateIpAddress(rawIp: unknown): {
  readonly ip: string;
  readonly family: IpFamily;
} {
  if (typeof rawIp !== 'string') {
    throw new IpScopeValidationError(
      'IP address must be a string',
      'ip',
    );
  }
  const trimmed = rawIp.trim();
  const version = net.isIP(trimmed);
  if (version !== 4 && version !== 6) {
    throw new IpScopeValidationError(
      `Invalid IPv4 or IPv6 address: "${trimmed}"`,
      'ip',
    );
  }
  return {
    ip: trimmed.toLowerCase(),
    family: version,
  };
}

/**
 * Validates a CIDR network prefix (`<ip>/<prefixLength>`) and splits it into
 * safe `{ address, prefixLength, family }` components.
 */
export function validateCidrPrefix(rawCidr: unknown): {
  readonly address: string;
  readonly prefixLength: number;
  readonly family: IpFamily;
  readonly normalizedCidr: string;
} {
  if (typeof rawCidr !== 'string') {
    throw new IpScopeValidationError('CIDR prefix must be a string', 'cidr');
  }
  const trimmed = rawCidr.trim();
  const slashIdx = trimmed.indexOf('/');
  if (slashIdx <= 0 || slashIdx !== trimmed.lastIndexOf('/')) {
    throw new IpScopeValidationError(
      `Invalid CIDR notation "${trimmed}". Expected "<ip>/<prefixLength>" (e.g. "1.1.1.0/24")`,
      'cidr',
    );
  }

  const rawAddress = trimmed.slice(0, slashIdx).trim();
  const rawLength = trimmed.slice(slashIdx + 1).trim();
  const version = net.isIP(rawAddress);
  if (version !== 4 && version !== 6) {
    throw new IpScopeValidationError(
      `Invalid IP address "${rawAddress}" in CIDR "${trimmed}"`,
      'cidr',
    );
  }

  if (!/^\d+$/.test(rawLength)) {
    throw new IpScopeValidationError(
      `Invalid prefix length "${rawLength}" in CIDR "${trimmed}"`,
      'cidr',
    );
  }

  const prefixLength = Number.parseInt(rawLength, 10);
  const maxBits = version === 4 ? 32 : 128;
  if (prefixLength < 0 || prefixLength > maxBits) {
    throw new IpScopeValidationError(
      `Prefix length ${prefixLength} out of range [0..${maxBits}] for IPv${version} CIDR "${trimmed}"`,
      'cidr',
    );
  }

  const address = rawAddress.toLowerCase();
  return {
    address,
    prefixLength,
    family: version,
    normalizedCidr: `${address}/${prefixLength}`,
  };
}

/**
 * Validates a batch array of IP addresses (`1..maxSize`), returning both the
 * normalized list in caller order and the deduplicated list of unique IPs so
 * duplicate IPs in a single batch only consume 1 network lookup item.
 */
export function validateAndDeduplicateBatchIps(
  rawIps: unknown,
  maxBatchSize = 100,
): {
  readonly orderedNormalizedIps: readonly string[];
  readonly uniqueIps: readonly string[];
} {
  if (!Array.isArray(rawIps)) {
    throw new IpScopeValidationError(
      'Batch IPs must be an array of IPv4/IPv6 strings',
      'ips',
    );
  }
  if (rawIps.length === 0) {
    throw new IpScopeValidationError(
      'Batch IPs array must contain at least 1 IP address',
      'ips',
    );
  }
  if (rawIps.length > maxBatchSize) {
    throw new IpScopeValidationError(
      `Batch IPs array length (${rawIps.length}) exceeds maximum single-request batch size (${maxBatchSize}). Use lookupBatchChunked() for larger lists.`,
      'ips',
    );
  }

  const orderedNormalizedIps: string[] = new Array(rawIps.length);
  const uniqueSet = new Set<string>();

  for (let i = 0; i < rawIps.length; i++) {
    const { ip } = validateIpAddress(rawIps[i]);
    orderedNormalizedIps[i] = ip;
    uniqueSet.add(ip);
  }

  return {
    orderedNormalizedIps,
    uniqueIps: Array.from(uniqueSet),
  };
}
