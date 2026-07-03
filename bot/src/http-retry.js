const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 60_000;

export class RequestTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = 'RequestTimeoutError';
    this.code = 'ETIMEDOUT';
  }
}

function abortedError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

export function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError());
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForRetry(ms, signal, waitFn) {
  if (waitFn) return waitFn(ms, signal);
  return wait(ms, signal);
}

async function retryAfterMs(response) {
  const header = response.headers?.get?.('retry-after')
    ?? response.headers?.get?.('x-ratelimit-reset-after');
  const headerSeconds = Number.parseFloat(header);
  if (Number.isFinite(headerSeconds) && headerSeconds >= 0) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.ceil(headerSeconds * 1000));
  }

  try {
    const body = await response.clone().json();
    const seconds = Number(body?.retry_after);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_RETRY_DELAY_MS, Math.ceil(seconds * 1000));
    }
  } catch {}
  return null;
}

function shouldRetryResponse(response) {
  return response.status === 429 || response.status >= 500;
}

async function fetchAttempt(fetchFn, url, options, timeoutMs) {
  const externalSignal = options.signal;
  if (externalSignal?.aborted) throw abortedError();

  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(externalSignal.reason);
  externalSignal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetchFn(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (externalSignal?.aborted) throw abortedError();
    if (timedOut) throw new RequestTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', onAbort);
  }
}

export async function fetchWithRetry(url, options = {}, policy = {}) {
  const {
    fetchFn = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = 1000,
    random = Math.random,
    waitFn = null,
  } = policy;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchAttempt(fetchFn, url, options, timeoutMs);
      if (!shouldRetryResponse(response) || attempt === maxRetries) return response;

      const rateLimitDelay = response.status === 429 ? await retryAfterMs(response) : null;
      const backoff = Math.min(
        MAX_RETRY_DELAY_MS,
        baseDelayMs * (2 ** attempt) + Math.floor(random() * 250),
      );
      await response.arrayBuffer().catch(() => {});
      await waitForRetry(rateLimitDelay ?? backoff, options.signal, waitFn);
    } catch (error) {
      if (options.signal?.aborted || error?.message === 'aborted') throw error;
      lastError = error;
      if (attempt === maxRetries) throw error;

      const backoff = Math.min(
        MAX_RETRY_DELAY_MS,
        baseDelayMs * (2 ** attempt) + Math.floor(random() * 250),
      );
      await waitForRetry(backoff, options.signal, waitFn);
    }
  }

  throw lastError;
}
