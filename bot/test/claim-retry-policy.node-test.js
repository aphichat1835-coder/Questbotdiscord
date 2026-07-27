import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimRetryAt,
  CLAIM_LONG_RETRY_DELAY_MS,
  CLAIM_RETRY_DELAY_MS,
  CLAIM_RETRY_REASON,
  classifyClaimRetry,
  persistClaimRetry,
} from '../src/quest/claim-retry-policy.js';
import {
  beginRunnerState,
  getRunnerState,
  RUNNER_MUTATION_KIND,
  RUNNER_MUTATION_STATUS,
  RUNNER_STATE,
} from '../src/quest/runner-state-store.js';

test('captcha and ambiguous platforms use durable long claim cooldowns', () => {
  const captcha = classifyClaimRetry({
    status: 400,
    data: { captcha_sitekey: 'fixture-site-key' },
  });
  assert.equal(captcha.reason, CLAIM_RETRY_REASON.CAPTCHA);
  assert.equal(captcha.delayMs, CLAIM_LONG_RETRY_DELAY_MS);

  const ambiguous = classifyClaimRetry(null, { platformAmbiguous: true });
  assert.equal(ambiguous.reason, CLAIM_RETRY_REASON.PLATFORM_AMBIGUOUS);
  assert.equal(ambiguous.delayMs, CLAIM_LONG_RETRY_DELAY_MS);
});

test('temporary claim failures use the standard cooldown', () => {
  const retry = classifyClaimRetry({ status: 503, message: 'temporarily unavailable' });
  assert.equal(retry.reason, CLAIM_RETRY_REASON.TEMPORARY_API_ERROR);
  assert.equal(retry.delayMs, CLAIM_RETRY_DELAY_MS);
});

test('claim retry survives restart through durable next_action_at', () => {
  const jobKey = 'scheduled:claim-retry-policy';
  const now = new Date('2030-01-01T00:00:00.000Z');
  beginRunnerState({
    jobKey,
    ownerId: 'claim-retry-owner',
    mode: 'scheduled',
    scheduleId: 920001,
  });

  const retry = classifyClaimRetry({ status: 503, message: 'temporary' });
  persistClaimRetry(jobKey, {
    id: 'claim-retry-quest',
    name: 'Claim Retry Quest',
    eventName: 'WATCH_VIDEO',
    progress: 100,
    progressSecs: 60,
  }, { ...retry, now });

  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.WAITING_RETRY);
  assert.equal(state.mutation_kind, RUNNER_MUTATION_KIND.CLAIM);
  assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.FAILED);
  assert.equal(state.metadata.claimRetryReason, CLAIM_RETRY_REASON.TEMPORARY_API_ERROR);
  assert.equal(claimRetryAt(jobKey), now.getTime() + CLAIM_RETRY_DELAY_MS);
});
