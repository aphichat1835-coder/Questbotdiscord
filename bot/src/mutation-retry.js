import { abortableDelay } from './abortable-delay.js';
import { currentRunnerExecutionContext } from './quest/runner-execution-context.js';
import {
  incrementRunnerRetry,
  markRunnerMutationFailed,
  markRunnerMutationUncertain,
  markRunnerMutationVerified,
  RUNNER_STATE,
} from './quest/runner-state-store.js';

const MAX_RETRY_DELAY_MS = 60_000;

function currentJobKey() {
  return currentRunnerExecutionContext()?.jobKey ?? null;
}

function checkpoint(callback) {
  const jobKey = currentJobKey();
  if (!jobKey) return null;
  try {
    return callback(jobKey);
  } catch (error) {
    console.warn(`[MutationCheckpoint:${jobKey}] ${error?.message ?? 'checkpoint failed'}`);
    return null;
  }
}

function markUncertain(error) {
  return checkpoint((jobKey) => markRunnerMutationUncertain(jobKey, error));
}

function markVerified() {
  return checkpoint((jobKey) => markRunnerMutationVerified(jobKey));
}

function markFailed(error) {
  return checkpoint((jobKey) => markRunnerMutationFailed(jobKey, error, {
    state: RUNNER_STATE.RUNNING,
  }));
}

function markControlledRetry() {
  return checkpoint((jobKey) => incrementRunnerRetry(jobKey));
}

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

async function verifyAfterUncertainFailure(verify) {
  const verified = await verify();
  if (verified) markVerified();
  return verified;
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

  if (!isUncertainMutationFailure(firstError)) {
    markFailed(firstError);
    throw firstError;
  }

  markUncertain(firstError);
  try {
    if (await verifyAfterUncertainFailure(verify)) return { verifiedAfterFailure: true };
  } catch (verificationError) {
    markFailed(verificationError);
    throw verificationError;
  }

  await wait(mutationRetryDelayMs(firstError), signal);
  markControlledRetry();

  try {
    return await perform();
  } catch (retryError) {
    if (isUncertainMutationFailure(retryError)) {
      markUncertain(retryError);
      try {
        if (await verifyAfterUncertainFailure(verify)) return { verifiedAfterFailure: true };
      } catch (verificationError) {
        markFailed(verificationError);
        throw verificationError;
      }
    }
    markFailed(retryError);
    throw retryError;
  }
}
