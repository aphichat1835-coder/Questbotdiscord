import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizationFingerprint } from '../src/quest/authorization-fingerprint.js';
import {
  clearScheduleHint,
  clearScheduleHintsForTests,
  publishScheduleHint,
  subscribeScheduleHints,
} from '../src/quest/schedule-hint-bus.js';
import {
  clearAllSmartWakes,
  configureSmartWakeController,
  registerSmartWake,
} from '../src/quest/smart-wake-controller.js';
import {
  beginRunnerState,
  clearRunnerStatesForTests,
  getRunnerState,
  RUNNER_STATE,
} from '../src/quest/runner-state-store.js';

function smartWakeArgs(jobKey, token, scheduleId) {
  return {
    jobKey,
    ownerId: 'hint-owner',
    userToken: token,
    channelId: 'hint-channel',
    client: {},
    mode: 'scheduled',
    scheduleId,
    accountId: 'hint-account',
    username: 'hint-user',
  };
}

test.beforeEach(() => {
  clearAllSmartWakes();
  clearScheduleHintsForTests();
  clearRunnerStatesForTests();
  configureSmartWakeController(null);
});

test.after(() => {
  clearAllSmartWakes();
  clearScheduleHintsForTests();
  clearRunnerStatesForTests();
  configureSmartWakeController(null);
});

test('clearing the final effective hint notifies subscribers with null', () => {
  const account = authorizationFingerprint('hint-clear-token');
  const observed = [];
  const unsubscribe = subscribeScheduleHints(account, (hint) => observed.push(hint));
  const nextActionAt = new Date(Date.now() + 60_000).toISOString();

  assert.equal(publishScheduleHint(account, {
    nextActionAt,
    reason: 'verification',
    source: 'verification',
  }), true);
  assert.equal(clearScheduleHint(account, 'verification'), true);
  assert.equal(observed[0].nextActionAt, nextActionAt);
  assert.equal(observed[1], null);
  unsubscribe();
});

test('queued initial delivery re-reads the newest effective hint', async () => {
  const account = authorizationFingerprint('hint-latest-token');
  const oldAt = new Date(Date.now() + 120_000).toISOString();
  const newAt = new Date(Date.now() + 60_000).toISOString();
  publishScheduleHint(account, {
    nextActionAt: oldAt,
    reason: 'baseline',
    source: 'baseline',
    priority: 10,
  });

  const observed = [];
  const unsubscribe = subscribeScheduleHints(account, (hint) => observed.push(hint));
  publishScheduleHint(account, {
    nextActionAt: newAt,
    reason: 'verification',
    source: 'verification',
    priority: 90,
  });
  await Promise.resolve();

  assert.ok(observed.length >= 1);
  assert.equal(observed.every((hint) => hint?.nextActionAt === newAt), true);
  assert.equal(observed.some((hint) => hint?.nextActionAt === oldAt), false);
  unsubscribe();
});

test('unsubscribed listeners receive no queued initial hint', async () => {
  const account = authorizationFingerprint('hint-unsubscribe-token');
  publishScheduleHint(account, {
    nextActionAt: new Date(Date.now() + 60_000).toISOString(),
    reason: 'verification',
    source: 'verification',
  });
  const observed = [];
  const unsubscribe = subscribeScheduleHints(account, (hint) => observed.push(hint));
  unsubscribe();
  await Promise.resolve();
  assert.deepEqual(observed, []);
});

test('clearing a due hint cancels its stale smart wake timer', async () => {
  const jobKey = 'scheduled:hint-clear-timer';
  const token = 'hint-clear-timer-token';
  const account = authorizationFingerprint(token);
  beginRunnerState({
    jobKey,
    ownerId: 'hint-owner',
    accountId: 'hint-account',
    mode: 'scheduled',
    scheduleId: 9901,
    state: RUNNER_STATE.RUNNING,
  });

  let restarts = 0;
  configureSmartWakeController(async () => { restarts++; }, {
    getJob: () => ({
      done: Promise.resolve(),
      summary: () => ({ status: 'AUTO DAILY ACTIVE', nextCheckAt: null }),
    }),
    stopJob: () => true,
    getScheduled: () => ({ id: 9901 }),
  });
  assert.equal(registerSmartWake(smartWakeArgs(jobKey, token, 9901)), true);

  assert.equal(publishScheduleHint(account, {
    nextActionAt: new Date(Date.now() - 1).toISOString(),
    reason: 'recovery',
    source: 'recovery',
    priority: 99,
  }), true);
  assert.equal(clearScheduleHint(account, 'recovery'), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(restarts, 0);
});

test('falling back from an urgent hint to baseline cancels the urgent wake timer', async () => {
  const jobKey = 'scheduled:hint-baseline-fallback';
  const token = 'hint-baseline-fallback-token';
  const account = authorizationFingerprint(token);
  const scheduleId = 9903;
  beginRunnerState({
    jobKey,
    ownerId: 'hint-owner',
    accountId: 'hint-account',
    mode: 'scheduled',
    scheduleId,
    state: RUNNER_STATE.RUNNING,
  });

  let restarts = 0;
  configureSmartWakeController(async () => { restarts++; }, {
    getJob: () => ({
      done: Promise.resolve(),
      summary: () => ({ status: 'AUTO DAILY ACTIVE', nextCheckAt: null }),
    }),
    stopJob: () => true,
    getScheduled: () => ({ id: scheduleId }),
  });
  assert.equal(registerSmartWake(smartWakeArgs(jobKey, token, scheduleId)), true);

  assert.equal(publishScheduleHint(account, {
    nextActionAt: new Date(Date.now() + 60_000).toISOString(),
    reason: 'baseline',
    source: 'baseline',
    priority: 10,
  }), true);
  assert.equal(publishScheduleHint(account, {
    nextActionAt: new Date(Date.now() - 1).toISOString(),
    reason: 'recovery',
    source: 'recovery',
    priority: 99,
  }), true);
  assert.equal(clearScheduleHint(account, 'recovery'), true);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(restarts, 0);
  assert.equal(getRunnerState(jobKey).state, RUNNER_STATE.RECOVERING);
});

test('a schedule hint without reason safely uses the waiting-schedule state', () => {
  const jobKey = 'scheduled:hint-without-reason';
  const token = 'hint-without-reason-token';
  const nextActionAt = new Date(Date.now() + 60_000).toISOString();
  beginRunnerState({
    jobKey,
    ownerId: 'hint-owner',
    accountId: 'hint-account',
    mode: 'scheduled',
    scheduleId: 9902,
    state: RUNNER_STATE.RUNNING,
  });
  assert.equal(registerSmartWake(smartWakeArgs(jobKey, token, 9902)), true);

  assert.equal(publishScheduleHint(authorizationFingerprint(token), {
    nextActionAt,
    source: 'reasonless-test',
  }), true);
  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.WAITING_SCHEDULE);
  assert.equal(state.next_action_at, nextActionAt);
  assert.equal(state.state_source, 'schedule-hint:reasonless-test');
});
