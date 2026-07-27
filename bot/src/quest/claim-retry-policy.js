import {
  getRunnerState,
  RUNNER_ERROR_CATEGORY,
  RUNNER_MUTATION_KIND,
  RUNNER_MUTATION_STATUS,
  RUNNER_STATE,
  transitionRunnerState,
} from './runner-state-store.js';

export const CLAIM_RETRY_DELAY_MS = 15 * 60 * 1000;
export const CLAIM_LONG_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

export const CLAIM_RETRY_REASON = Object.freeze({
  CAPTCHA: 'CAPTCHA',
  PLATFORM_AMBIGUOUS: 'PLATFORM_AMBIGUOUS',
  VERIFICATION_ABSENT: 'VERIFICATION_ABSENT',
  TEMPORARY_API_ERROR: 'TEMPORARY_API_ERROR',
});

function retryError(reason, message, status = null) {
  const error = new Error(message);
  error.name = 'ClaimRetryError';
  error.code = reason;
  if (Number.isInteger(status)) error.status = status;
  return error;
}

export function isCaptchaChallengeData(data) {
  return Boolean(
    data?.captcha_sitekey
    || data?.captcha_service
    || data?.captcha_rqtoken
    || data?.captcha_rqdata
    || data?.captcha_key,
  );
}

export function classifyClaimRetry(error, { platformAmbiguous = false } = {}) {
  if (platformAmbiguous) {
    return {
      reason: CLAIM_RETRY_REASON.PLATFORM_AMBIGUOUS,
      delayMs: CLAIM_LONG_RETRY_DELAY_MS,
      error: retryError(
        CLAIM_RETRY_REASON.PLATFORM_AMBIGUOUS,
        'Discord Quest reward platform is ambiguous',
      ),
    };
  }
  if (isCaptchaChallengeData(error?.data) || error?.status === 400) {
    return {
      reason: CLAIM_RETRY_REASON.CAPTCHA,
      delayMs: CLAIM_LONG_RETRY_DELAY_MS,
      error: retryError(
        CLAIM_RETRY_REASON.CAPTCHA,
        error?.message ?? 'Discord claim requires a long retry cooldown',
        error?.status,
      ),
    };
  }
  return {
    reason: CLAIM_RETRY_REASON.TEMPORARY_API_ERROR,
    delayMs: CLAIM_RETRY_DELAY_MS,
    error: retryError(
      CLAIM_RETRY_REASON.TEMPORARY_API_ERROR,
      error?.message ?? 'Discord claim verification is temporarily unavailable',
      error?.status,
    ),
  };
}

export function persistClaimRetry(jobKey, quest, {
  reason,
  delayMs,
  error = null,
  now = new Date(),
} = {}) {
  const current = getRunnerState(jobKey);
  if (!current) return null;
  const nextActionAt = new Date(now.getTime() + Math.max(1000, Number(delayMs) || 0)).toISOString();
  return transitionRunnerState(jobKey, RUNNER_STATE.WAITING_RETRY, {
    questId: quest?.id ?? current.quest_id,
    questName: quest?.name ?? current.quest_name,
    questEvent: quest?.eventName ?? current.quest_event,
    progress: Number.isFinite(Number(quest?.progress)) ? Number(quest.progress) : current.progress,
    serverProgressSeconds: Number.isFinite(Number(quest?.progressSecs))
      ? Number(quest.progressSecs)
      : current.server_progress_seconds,
    nextActionAt,
    mutationKind: RUNNER_MUTATION_KIND.CLAIM,
    mutationStatus: RUNNER_MUTATION_STATUS.FAILED,
    lastError: error?.message ?? `Claim retry scheduled: ${reason}`,
    errorCategory: Number(error?.status) === 429
      ? RUNNER_ERROR_CATEGORY.RATE_LIMIT
      : Number(error?.status) >= 500
        ? RUNNER_ERROR_CATEGORY.API_5XX
        : RUNNER_ERROR_CATEGORY.VERIFICATION,
    metadata: {
      ...(current.metadata ?? {}),
      claimRetryReason: reason,
      claimRetryAt: nextActionAt,
    },
    stateSource: 'claim-retry-policy',
  });
}

export function claimRetryAt(jobKey) {
  const state = getRunnerState(jobKey);
  if (
    state?.state !== RUNNER_STATE.WAITING_RETRY
    || state?.mutation_kind !== RUNNER_MUTATION_KIND.CLAIM
  ) {
    return null;
  }
  const value = Date.parse(state.next_action_at);
  return Number.isFinite(value) ? value : null;
}
