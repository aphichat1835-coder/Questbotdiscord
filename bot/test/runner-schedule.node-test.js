import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nextRecheckState,
  nextScheduledCheck,
  RECHECK_INTERVAL_MS,
} from '../src/runner-schedule.js';

test('nextScheduledCheck uses 00:00, 08:00 and 16:00 in Asia/Bangkok', () => {
  assert.equal(
    nextScheduledCheck(new Date('2026-07-01T16:59:00Z'), 'Asia/Bangkok').toISOString(),
    '2026-07-01T17:00:00.000Z',
  );
  assert.equal(
    nextScheduledCheck(new Date('2026-07-01T17:01:00Z'), 'Asia/Bangkok').toISOString(),
    '2026-07-02T01:00:00.000Z',
  );
  assert.equal(
    nextScheduledCheck(new Date('2026-07-02T01:01:00Z'), 'Asia/Bangkok').toISOString(),
    '2026-07-02T09:00:00.000Z',
  );
});

test('successful or attempted work starts three five-minute rechecks', () => {
  const state = nextRecheckState({ attempted: true });
  assert.deepEqual(state, {
    rechecksRemaining: 3,
    shouldRecheck: true,
    delayMs: RECHECK_INTERVAL_MS,
  });
});

test('three empty verification checks exhaust the burst', () => {
  let state = { rechecksRemaining: 3 };
  for (let i = 0; i < 3; i++) {
    state = nextRecheckState({
      isRecheck: true,
      rechecksRemaining: state.rechecksRemaining,
    });
  }
  assert.deepEqual(state, {
    rechecksRemaining: 0,
    shouldRecheck: false,
    delayMs: 0,
  });
});

test('new successful work resets the verification count', () => {
  const state = nextRecheckState({
    isRecheck: true,
    rechecksRemaining: 1,
    progressed: true,
  });
  assert.equal(state.rechecksRemaining, 3);
  assert.equal(state.shouldRecheck, true);
});

test('an empty regular scheduled check does not start a verification burst', () => {
  assert.deepEqual(nextRecheckState(), {
    rechecksRemaining: 0,
    shouldRecheck: false,
    delayMs: 0,
  });
});
