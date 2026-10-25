/**
 * @fileoverview Resilient HTTP Transport (`IpScopeHttpClient`) for `@ipscope/sdk-node`.
 *
 * Features:
 * - Zero external dependencies (uses Node.js native `fetch` and `AbortController`)
 * - Automatic `x-api-key` and `Authorization: Bearer <apiKey>` authentication headers
 * - Parses user-scoped rate-limit headers (`x-ratelimit-*`) on every response
 * - Exponential backoff with jitter on `429` and transient `502`/`503`/`504` errors
 * - Per-request timeout enforcement + external `AbortSignal` composition with
 *   strict `finally` cleanup (zero dangling timers or leaked `AbortSignal` listeners)
 */

import {
  IpScopeApiError,
  IpScopeAuthenticationError,
  IpScopeRateLimitError,
  IpScopeTimeoutError,
} from './errors';
import {
  IpScopeClientOptions,
  RateLimitMetadata,
  RequestOptions,
} from './types';
import { validateApiKey } from './validation';

const DEFAULT_BASE_URL = 'https://api.ipscope.io';
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 150;
const DEFAULT_MAX_DELAY_MS = 3000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MiB hard ceiling to protect Node.js heap
const SDK_USER_AGENT = '@ipscope/sdk-node/1.0.0';

/**
 * Extracts user-scoped rate-limit headers returned by `@ipscope/api`.
 */
export function parseRateLimitHeaders(headers: Headers): RateLimitMetadata {
  const parseHeaderInt = (name: string): number | null => {
    const raw = headers.get(name);
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  };

  return {
    limitPerMinute: parseHeaderInt('x-ratelimit-limit'),
    remaining: parseHeaderInt('x-ratelimit-remaining'),
    resetEpochSeconds: parseHeaderInt('x-ratelimit-reset'),
    scope: headers.get('x-ratelimit-scope'),
    burstCapacity: parseHeaderInt('x-ratelimit-burst'),
    rateLimitRps: parseHeaderInt('x-ratelimit-rps'),
  };
}

/**
 * Low-level HTTP transport for `IpScopeClient`.
 */
export class IpScopeHttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly retryOnRateLimit: boolean;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private lastRateLimit: RateLimitMetadata | null = null;

  constructor(options: IpScopeClientOptions) {
    this.apiKey = validateApiKey(options.apiKey);
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL)
      .trim()
      .replace(/\/+$/, '');
    this.timeoutMs = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.maxRetries = Math.max(
      0,
      options.retry?.maxRetries ?? DEFAULT_MAX_RETRIES,
    );
    this.baseDelayMs = Math.max(
      10,
      options.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    );
    this.maxDelayMs = Math.max(
      this.baseDelayMs,
      options.retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    );
    this.retryOnRateLimit = options.retry?.retryOnRateLimit ?? true;
    this.userAgent = options.userAgent
      ? `${options.userAgent} ${SDK_USER_AGENT}`
      : SDK_USER_AGENT;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Returns the most recently observed user-scoped rate-limit metadata, or `null`
   * if no HTTP response has been received yet.
   */
  getLastRateLimit(): RateLimitMetadata | null {
    return this.lastRateLimit;
  }

  /**
   * Executes a typed JSON HTTP request with timeout, header parsing, and retries.
   */
  async request<T>(params: {
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    options?: RequestOptions;
    requiresAuth?: boolean;
  }): Promise<{
    data: T;
    status: number;
    rateLimit: RateLimitMetadata;
  }> {
    const url = `${this.baseUrl}${params.path}`;
    const timeoutMs = params.options?.timeoutMs ?? this.timeoutMs;
    const requiresAuth = params.requiresAuth ?? true;
    const externalSignal = params.options?.signal;

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': this.userAgent,
      ...(requiresAuth
        ? {
            'x-api-key': this.apiKey,
            Authorization: `Bearer ${this.apiKey}`,
          }
        : {}),
      ...(params.body !== undefined
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...(params.options?.headers ?? {}),
    };

    const serializedBody =
      params.body !== undefined ? JSON.stringify(params.body) : undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (externalSignal?.aborted) {
        throw new IpScopeTimeoutError(params.path, timeoutMs);
      }

      const controller = new AbortController();
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      timer.unref?.();

      const onExternalAbort = () => controller.abort();
      externalSignal?.addEventListener('abort', onExternalAbort, {
        once: true,
      });

      let response: Response;
      let rawText: string;

      try {
        try {
          response = await this.fetchImpl(url, {
            method: params.method,
            headers,
            body: serializedBody,
            signal: controller.signal,
          });
          const contentLengthHeader = response.headers.get('content-length');
          if (contentLengthHeader) {
            const declaredLength = Number.parseInt(contentLengthHeader, 10);
            if (
              Number.isFinite(declaredLength) &&
              declaredLength > MAX_RESPONSE_BYTES
            ) {
              await response.body?.cancel().catch(() => undefined);
              throw new IpScopeApiError({
                message: `IPScope response payload (${declaredLength} bytes) exceeds 2 MiB safety limit`,
                status: response.status,
                path: params.path,
                code: 'IPSCOPE_RESPONSE_TOO_LARGE',
              });
            }
          }
          rawText = await response.text();
          if (Buffer.byteLength(rawText, 'utf8') > MAX_RESPONSE_BYTES) {
            throw new IpScopeApiError({
              message:
                'IPScope response payload exceeds 2 MiB safety limit',
              status: response.status,
              path: params.path,
              code: 'IPSCOPE_RESPONSE_TOO_LARGE',
            });
          }
        } finally {
          clearTimeout(timer);
          externalSignal?.removeEventListener('abort', onExternalAbort);
        }

        const rateLimit = parseRateLimitHeaders(response.headers);
        this.lastRateLimit = rateLimit;

        let parsedBody: unknown = null;
        if (rawText.length > 0) {
          try {
            parsedBody = JSON.parse(rawText);
          } catch {
            parsedBody = rawText;
          }
        }

        if (response.ok) {
          return {
            data: parsedBody as T,
            status: response.status,
            rateLimit,
          };
        }

        const errorMessage = extractErrorMessage(
          parsedBody,
          response.status,
          params.path,
        );

        if (response.status === 401 || response.status === 403) {
          throw new IpScopeAuthenticationError({
            message: errorMessage,
            status: response.status,
            path: params.path,
            responseBody: parsedBody,
            rateLimit,
          });
        }

        if (response.status === 429) {
          const retryAfterMs = computeRetryAfterMs(response.headers, rateLimit);
          if (this.retryOnRateLimit && attempt < this.maxRetries) {
            const delay = Math.min(
              this.maxDelayMs,
              retryAfterMs ?? this.computeBackoffMs(attempt),
            );
            await abortableSleep(delay, externalSignal, params.path, timeoutMs);
            continue;
          }
          throw new IpScopeRateLimitError({
            message: errorMessage,
            path: params.path,
            retryAfterMs,
            responseBody: parsedBody,
            rateLimit,
          });
        }

        const isTransientServerError =
          response.status === 502 ||
          response.status === 503 ||
          response.status === 504;
        if (isTransientServerError && attempt < this.maxRetries) {
          await abortableSleep(
            this.computeBackoffMs(attempt),
            externalSignal,
            params.path,
            timeoutMs,
          );
          continue;
        }

        throw new IpScopeApiError({
          message: errorMessage,
          status: response.status,
          path: params.path,
          responseBody: parsedBody,
          rateLimit,
        });
      } catch (err: unknown) {
        if (
          err instanceof IpScopeApiError ||
          err instanceof IpScopeTimeoutError
        ) {
          throw err;
        }

        if (
          timedOut ||
          externalSignal?.aborted ||
          (err instanceof Error && err.name === 'AbortError')
        ) {
          throw new IpScopeTimeoutError(params.path, timeoutMs, { cause: err });
        }

        if (attempt < this.maxRetries) {
          await abortableSleep(
            this.computeBackoffMs(attempt),
            externalSignal,
            params.path,
            timeoutMs,
          );
          continue;
        }

        throw new IpScopeApiError({
          message:
            err instanceof Error
              ? `Network request to "${params.path}" failed: ${err.message}`
              : `Network request to "${params.path}" failed`,
          status: 0,
          path: params.path,
          code: 'IPSCOPE_NETWORK_ERROR',
        });
      }
    }

    throw new IpScopeApiError({
      message: `Exhausted ${this.maxRetries} retries for "${params.path}"`,
      status: 0,
      path: params.path,
      code: 'IPSCOPE_RETRY_EXHAUSTED',
    });
  }

  private computeBackoffMs(attempt: number): number {
    const exp = Math.min(
      this.maxDelayMs,
      this.baseDelayMs * Math.pow(2, attempt),
    );
    const jitter = Math.floor(Math.random() * Math.max(10, exp * 0.25));
    return Math.min(this.maxDelayMs, exp + jitter);
  }
}

function extractErrorMessage(
  body: unknown,
  status: number,
  path: string,
): string {
  if (body && typeof body === 'object') {
    const msg = (body as Record<string, unknown>).message;
    if (typeof msg === 'string' && msg.trim().length > 0) {
      return msg;
    }
    if (Array.isArray(msg) && msg.length > 0) {
      return msg.join('; ');
    }
  }
  return `IPScope API error (${status}) on ${path}`;
}

function computeRetryAfterMs(
  headers: Headers,
  rateLimit: RateLimitMetadata,
): number | null {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds * 1000);
    }
  }
  if (rateLimit.resetEpochSeconds !== null) {
    const deltaMs = rateLimit.resetEpochSeconds * 1000 - Date.now();
    if (deltaMs > 0) {
      return deltaMs;
    }
  }
  return null;
}

function abortableSleep(
  ms: number,
  signal: AbortSignal | undefined,
  path: string,
  timeoutMs: number,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new IpScopeTimeoutError(path, timeoutMs));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new IpScopeTimeoutError(path, timeoutMs));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
