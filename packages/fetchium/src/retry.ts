import type { ResolvedRetryConfig } from './query.js';

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
): Promise<T> {
  if (IS_DEV && config.retries < 0) {
    throw new Error('retries must be non-negative');
  }
  const retries = Math.max(0, config.retries);
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
      await sleep(config.retryDelay(attempt), signal);
    }
  }
  throw lastError;
}
