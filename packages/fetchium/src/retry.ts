import type { ResolvedRetryConfig } from './query.js';

/**
 * Decides whether a failed attempt is retried. Consulted only while retries
 * remain.
 *
 * @param error  What the attempt threw.
 * @param attempt  Index of the failed attempt, starting at 0 (the first request).
 * @param status  HTTP status of the failed attempt, when known: the status the
 *   adapter received (`ctx.response.status` for a REST query whose response
 *   body failed to parse or validate), or else `status`, `statusCode` or
 *   `response.status` on the error. Undefined for network errors.
 */
export type ShouldRetry = (error: unknown, attempt: number, status: number | undefined) => boolean;

function asHttpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && value >= 100 && value <= 599 ? value : undefined;
}

/**
 * The HTTP status an error carries, read from `status`, `statusCode`, or
 * `response.status`. Undefined when none holds an HTTP status code.
 */
export function getErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } | null };
  return asHttpStatus(e.status) ?? asHttpStatus(e.statusCode) ?? asHttpStatus(e.response?.status);
}

/** The status of an error response (4xx/5xx), or undefined. */
export function getFailedResponseStatus(response: unknown): number | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  const status = asHttpStatus((response as { status?: unknown }).status);
  return status !== undefined && status >= 400 ? status : undefined;
}

/**
 * Retries network errors, unknown errors and server errors (5xx). Does not
 * retry client errors (4xx), which a repeat of the same request would hit
 * again, except 408 Request Timeout and 429 Too Many Requests.
 */
export const defaultShouldRetry: ShouldRetry = (_error, _attempt, status) =>
  status === undefined || status < 400 || status >= 500 || status === 408 || status === 429;

export interface WithRetryOptions {
  /** Used when the retry config has no `shouldRetry`. Default: `defaultShouldRetry`. */
  shouldRetry?: ShouldRetry;
  /**
   * Called after an attempt fails. Returns the HTTP status the attempt
   * received, for errors that don't carry one themselves.
   */
  getAttemptStatus?: () => number | undefined;
}

/**
 * Safely retrieve the abort reason from a signal. Falls back to an AbortError
 * for engines (like Hermes) where `signal.reason` is not implemented.
 */
function getAbortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  if (typeof DOMException !== 'undefined') {
    return new DOMException('The operation was aborted', 'AbortError');
  }
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(getAbortReason(signal));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(getAbortReason(signal));
      },
      { once: true },
    );
  });
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: ResolvedRetryConfig,
  signal?: AbortSignal,
  options?: WithRetryOptions,
): Promise<T> {
  if (IS_DEV && config.retries < 0) {
    throw new Error('retries must be non-negative');
  }
  const retries = Math.max(0, config.retries);
  const shouldRetry = config.shouldRetry ?? options?.shouldRetry ?? defaultShouldRetry;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) {
      throw getAbortReason(signal);
    }
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= retries) throw error;
      const status = getErrorStatus(error) ?? options?.getAttemptStatus?.();
      if (!shouldRetry(error, attempt, status)) throw error;
      await sleep(config.retryDelay(attempt), signal);
    }
  }
  throw lastError;
}
