import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizationFingerprint } from '../src/quest/rate-limit-coordinator.js';
import {
  clearScheduleHintsForTests,
  publishScheduleHint,
} from '../src/quest/schedule-hint-bus.js';
import {
  clearSmartWake,
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

const JOB_KEY = 'scheduled:smart-wake-test';
const TOKEN = 'smart-wake-test-token';

function cleanup() {
  clearSmartWake(JOB_KEY);
  clearScheduleHintsForTests();
  clearRunnerStatesForTests();
}

test.beforeEach(cleanup);
test.afterEach(cleanup);

test('enrollment hints persist an earlier durable wake-up state', () => {
  beginRunnerState({
    jobKey: JOB_KEY,
    ownerId: 'owner-1',
    accountId: 'account-1',
    username: 'runner',
    mode: 'scheduled',
    scheduleId: 1,
    state: RUNNER_STATE.RUNNING,
  });
  registerSmartWake({
    jobKey: JOB_KEY,
    ownerId: 'owner-1',
    userToken: TOKEN,
    channelId: 'channel-1',
    client: {},
    mode: 'scheduled',
    scheduleId: 1,
    accountId: 'account-1',
    username: 'runner',
  });

  const nextActionAt = new Date(Date.now() + 60_000).toISOString();
  publishScheduleHint(authorizationFingerprint(TOKEN), {
    nextActionAt,
    reason: 'enrollment:quest-1',
    priority: 70,
  });

  const state = getRunnerState(JOB_KEY);
  assert.equal(state.state, RUNNER_STATE.WAITING_ENROLLMENT);
  assert.equal(state.next_action_at, nextActionAt);
  assert.deepEqual(state.metadata, { reason: 'enrollment:quest-1', priority: 70 });
});

test('baseline hints do not replace the runner fixed schedule', () => {
  beginRunnerState({
    jobKey: JOB_KEY,
    ownerId: 'owner-1',
    mode: 'scheduled',
    scheduleId: 1,
    state: RUNNER_STATE.RUNNING,
  });
  registerSmartWake({
    jobKey: JOB_KEY,
    ownerId: 'owner-1',
    userToken: TOKEN,
    channelId: 'channel-1',
    client: {},
    mode: 'scheduled',
    scheduleId: 1,
  });

  publishScheduleHint(authorizationFingerprint(TOKEN), {
    nextActionAt: new Date(Date.now() + 60_000).toISOString(),
    reason: 'baseline',
    priority: 10,
  });

  assert.equal(getRunnerState(JOB_KEY).state, RUNNER_STATE.RUNNING);
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
