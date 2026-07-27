import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizationFingerprint } from '../src/quest/rate-limit-coordinator.js';
import {
  clearScheduleHintsForTests,
  publishScheduleHint,
} from '../src/quest/schedule-hint-bus.js';
import {
  clearAllSmartWakes,
  clearSmartWake,
  isSmartWakeRestarting,
  MAX_SMART_WAKE_TIMER_MS,
  registerSmartWake,
  smartWakeTimerDelay,
} from '../src/quest/smart-wake-controller.js';
import {
  beginRunnerState,
  clearRunnerStatesForTests,
  getRunnerState,
  RUNNER_STATE,
} from '../src/quest/runner-state-store.js';

const ENROLLMENT_JOB_KEY = 'scheduled:smart-wake-enrollment';
const ENROLLMENT_TOKEN = 'smart-wake-enrollment-token';
const BASELINE_JOB_KEY = 'scheduled:smart-wake-baseline';
const BASELINE_TOKEN = 'smart-wake-baseline-token';

function scheduledArgs(jobKey, token, scheduleId) {
  return {
    jobKey,
    ownerId: 'owner-1',
    userToken: token,
    channelId: 'channel-1',
    client: {},
    mode: 'scheduled',
    scheduleId,
    accountId: `account-${scheduleId}`,
    username: 'runner',
  };
}

function beginScheduled(jobKey, scheduleId) {
  beginRunnerState({
    jobKey,
    ownerId: 'owner-1',
    accountId: `account-${scheduleId}`,
    username: 'runner',
    mode: 'scheduled',
    scheduleId,
    state: RUNNER_STATE.RUNNING,
  });
}

test.beforeEach(() => {
  clearAllSmartWakes();
  clearScheduleHintsForTests();
  clearRunnerStatesForTests();
});

test.after(() => {
  clearAllSmartWakes();
  clearScheduleHintsForTests();
  clearRunnerStatesForTests();
});

test('enrollment hints persist an earlier durable wake-up state', () => {
  beginScheduled(ENROLLMENT_JOB_KEY, 1);
  assert.equal(registerSmartWake(scheduledArgs(ENROLLMENT_JOB_KEY, ENROLLMENT_TOKEN, 1)), true);

  const nextActionAt = new Date(Date.now() + 60_000).toISOString();
  publishScheduleHint(authorizationFingerprint(ENROLLMENT_TOKEN), {
    nextActionAt,
    reason: 'enrollment:quest-1',
    priority: 70,
  });

  const state = getRunnerState(ENROLLMENT_JOB_KEY);
  assert.equal(state.state, RUNNER_STATE.WAITING_ENROLLMENT);
  assert.equal(state.next_action_at, nextActionAt);
  assert.deepEqual(state.metadata, { reason: 'enrollment:quest-1', priority: 70 });
});

test('smart wake maps every non-baseline hint to its durable lifecycle state', () => {
  const cases = [
    ['claim:quest-1', RUNNER_STATE.CLAIMING],
    ['claim-retry', RUNNER_STATE.WAITING_RETRY],
    ['rate-limit', RUNNER_STATE.WAITING_RATE_LIMIT],
    ['retry', RUNNER_STATE.WAITING_RETRY],
    ['circuit-breaker', RUNNER_STATE.WAITING_RETRY],
    ['progress-stall', RUNNER_STATE.VERIFYING_PROGRESS],
    ['verification', RUNNER_STATE.VERIFYING_COMPLETION],
    ['recovery', RUNNER_STATE.RECOVERING],
    ['scheduled-check', RUNNER_STATE.WAITING_SCHEDULE],
  ];

  cases.forEach(([reason, expectedState], index) => {
    const scheduleId = 100 + index;
    const jobKey = `scheduled:smart-wake-reason-${index}`;
    const token = `smart-wake-reason-token-${index}`;
    beginScheduled(jobKey, scheduleId);
    assert.equal(registerSmartWake(scheduledArgs(jobKey, token, scheduleId)), true);

    const nextActionAt = new Date(Date.now() + 120_000 + index).toISOString();
    publishScheduleHint(authorizationFingerprint(token), {
      nextActionAt,
      reason,
      priority: 80 - index,
      source: 'test-source',
    });

    const state = getRunnerState(jobKey);
    assert.equal(state.state, expectedState, reason);
    assert.equal(state.next_action_at, nextActionAt, reason);
    assert.equal(state.state_source, 'schedule-hint:test-source', reason);
    assert.deepEqual(state.metadata, { reason, priority: 80 - index }, reason);
  });
});

test('baseline and invalid hints do not replace the runner state', () => {
  beginScheduled(BASELINE_JOB_KEY, 2);
  assert.equal(registerSmartWake(scheduledArgs(BASELINE_JOB_KEY, BASELINE_TOKEN, 2)), true);

  publishScheduleHint(authorizationFingerprint(BASELINE_TOKEN), {
    nextActionAt: new Date(Date.now() + 60_000).toISOString(),
    reason: 'baseline',
    priority: 10,
  });
  assert.equal(getRunnerState(BASELINE_JOB_KEY).state, RUNNER_STATE.RUNNING);

  publishScheduleHint(authorizationFingerprint(BASELINE_TOKEN), {
    nextActionAt: 'not-a-date',
    reason: 'verification',
    priority: 90,
  });
  assert.equal(getRunnerState(BASELINE_JOB_KEY).state, RUNNER_STATE.RUNNING);
});

test('one-shot jobs are rejected and clearing a wake unsubscribes its hints', () => {
  assert.equal(registerSmartWake({
    ...scheduledArgs('oneshot:smart-wake', 'oneshot-smart-wake-token', 3),
    mode: 'oneshot',
  }), false);
  assert.equal(clearSmartWake('missing-smart-wake'), false);

  const jobKey = 'scheduled:smart-wake-clear';
  const token = 'smart-wake-clear-token';
  beginScheduled(jobKey, 4);
  assert.equal(registerSmartWake(scheduledArgs(jobKey, token, 4)), true);
  assert.equal(clearSmartWake(jobKey), true);
  assert.equal(clearSmartWake(jobKey), false);

  publishScheduleHint(authorizationFingerprint(token), {
    nextActionAt: new Date(Date.now() + 60_000).toISOString(),
    reason: 'verification',
    priority: 90,
  });
  assert.equal(getRunnerState(jobKey).state, RUNNER_STATE.RUNNING);
  assert.equal(isSmartWakeRestarting(jobKey), false);
});

test('registering the same job again replaces the previous subscription', () => {
  const jobKey = 'scheduled:smart-wake-reregister';
  const oldToken = 'smart-wake-old-token';
  const newToken = 'smart-wake-new-token';
  beginScheduled(jobKey, 5);

  assert.equal(registerSmartWake(scheduledArgs(jobKey, oldToken, 5)), true);
  assert.equal(registerSmartWake(scheduledArgs(jobKey, newToken, 5)), true);

  publishScheduleHint(authorizationFingerprint(oldToken), {
    nextActionAt: new Date(Date.now() + 60_000).toISOString(),
    reason: 'rate-limit',
    priority: 98,
  });
  assert.equal(getRunnerState(jobKey).state, RUNNER_STATE.RUNNING);

  publishScheduleHint(authorizationFingerprint(newToken), {
    nextActionAt: new Date(Date.now() + 60_000).toISOString(),
    reason: 'rate-limit',
    priority: 98,
  });
  assert.equal(getRunnerState(jobKey).state, RUNNER_STATE.WAITING_RATE_LIMIT);
});

test('far-future smart wake uses bounded timer chunks instead of overflowing setTimeout', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const farFuture = '2030-03-01T00:00:00.000Z';

  assert.equal(smartWakeTimerDelay(farFuture, now), MAX_SMART_WAKE_TIMER_MS);
  assert.equal(MAX_SMART_WAKE_TIMER_MS, 24 * 60 * 60 * 1000);
});

test('due and invalid smart wake timestamps are normalized safely', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  assert.equal(smartWakeTimerDelay('2029-12-31T23:59:59.000Z', now), 0);
  assert.equal(smartWakeTimerDelay('not-a-date', now), null);
});
