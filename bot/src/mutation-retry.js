import { abortableDelay } from './abortable-delay.js';

const MAX_RETRY_DELAY_MS = 60_000;

export function isUncertainMutationFailure(error) {
  if (!error) return false;
  if (error.name === 'AbortError' || error.message === 'aborted') return false;
  if (!Number.isInteger(error.status)) return true;
  return error.status === 429 || error.status >= 500;
}

export function mutationRetryDelayMs(error) {
  const seconds = Number(
    error?.data?.retry_after
      ?? error?.data?.retryAfter
      ?? error?.retryAfter,
  );
  if (!Number.isFinite(seconds) || seconds < 0) return 1000;
  return Math.min(MAX_RETRY_DELAY_MS, Math.ceil(seconds * 1000));
}

export function waitForMutationRetry(ms, signal) {
  return abortableDelay(ms, signal, { unref: true });
}

/**
 * A mutating request is never retried blindly. After an uncertain failure
 * (network, timeout, 429 or 5xx), fresh server state is checked first. Only
 * when the desired state is still absent can one controlled retry occur.
 */
export async function executeVerifiedMutation({
  perform,
  verify,
  signal,
  wait = waitForMutationRetry,
}) {
  let firstError;
  try {
    return await perform();
  } catch (error) {
    firstError = error;
  }

  if (!isUncertainMutationFailure(firstError)) throw firstError;
  if (await verify()) return { verifiedAfterFailure: true };

  await wait(mutationRetryDelayMs(firstError), signal);

  try {
    return await perform();
  } catch (retryError) {
    if (isUncertainMutationFailure(retryError) && await verify()) {
      return { verifiedAfterFailure: true };
    }
    throw retryError;
  }
}
