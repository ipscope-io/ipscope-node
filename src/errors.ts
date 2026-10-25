/**
 * @fileoverview Typed error hierarchy for `@ipscope/sdk-node`.
 */

import { RateLimitMetadata } from './types';

/**
 * Base error class for all errors thrown by `@ipscope/sdk-node`.
 */
export class IpScopeError extends Error {
  readonly code: string;

  constructor(message: string, code = 'IPSCOPE_ERROR', options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when client-side input validation fails before making an HTTP request
 * (e.g., invalid IPv4/IPv6 address, invalid CIDR prefix, empty API key, or empty batch).
 */
export class IpScopeValidationError extends IpScopeError {
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message, 'IPSCOPE_VALIDATION_ERROR');
    this.field = field;
  }
}

/**
 * Thrown when a request exceeds the configured `timeoutMs` or is aborted via `AbortSignal`.
 */
export class IpScopeTimeoutError extends IpScopeError {
  readonly timeoutMs: number;
  readonly path: string;

  constructor(path: string, timeoutMs: number, options?: ErrorOptions) {
    super(
      `IPScope request to "${path}" timed out after ${timeoutMs}ms`,
      'IPSCOPE_TIMEOUT_ERROR',
      options,
    );
    this.timeoutMs = timeoutMs;
    this.path = path;
  }
}

/**
 * Thrown when the IPScope API returns a non-2xx HTTP status code.
 */
export class IpScopeApiError extends IpScopeError {
  readonly status: number;
  readonly path: string;
  readonly responseBody: unknown;
  readonly rateLimit: RateLimitMetadata | null;

  constructor(params: {
    message: string;
    status: number;
    path: string;
    code?: string;
    responseBody?: unknown;
    rateLimit?: RateLimitMetadata | null;
  }) {
    super(params.message, params.code ?? `IPSCOPE_HTTP_${params.status}`);
    this.status = params.status;
    this.path = params.path;
    this.responseBody = params.responseBody ?? null;
    this.rateLimit = params.rateLimit ?? null;
  }
}

/**
 * Thrown on HTTP `401 Unauthorized` or `403 Forbidden` (invalid, expired, or
 * revoked API key, or missing required scope such as `lookup` or `batch`).
 */
export class IpScopeAuthenticationError extends IpScopeApiError {
  constructor(params: {
    message: string;
    status: 401 | 403;
    path: string;
    responseBody?: unknown;
    rateLimit?: RateLimitMetadata | null;
  }) {
    super({
      ...params,
      code:
        params.status === 401
          ? 'IPSCOPE_UNAUTHORIZED'
          : 'IPSCOPE_FORBIDDEN_SCOPE',
    });
  }
}

/**
 * Thrown on HTTP `429 Too Many Requests` when the user-scoped rate limit bucket
 * is exhausted and retries are exhausted or disabled.
 */
export class IpScopeRateLimitError extends IpScopeApiError {
  readonly retryAfterMs: number | null;

  constructor(params: {
    message: string;
    path: string;
    retryAfterMs: number | null;
    responseBody?: unknown;
    rateLimit?: RateLimitMetadata | null;
  }) {
    super({
      message: params.message,
      status: 429,
      path: params.path,
      code: 'IPSCOPE_RATE_LIMITED',
      responseBody: params.responseBody,
      rateLimit: params.rateLimit,
    });
    this.retryAfterMs = params.retryAfterMs;
  }
}
