import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginRunnerState,
  clearRunnerStatesForTests,
  getRunnerState,
  listRunnerStates,
  markInterruptedRunnerStates,
  RUNNER_STATE,
  transitionRunnerState,
} from '../src/quest/runner-state-store.js';

test.beforeEach(() => clearRunnerStatesForTests());

test('runner state persists lifecycle, quest and next action data', () => {
  beginRunnerState({
    jobKey: 'scheduled:1',
    ownerId: 'owner-1',
    accountId: 'account-1',
    username: 'runner',
    mode: 'scheduled',
    scheduleId: 1,
  });
  transitionRunnerState('scheduled:1', RUNNER_STATE.RUNNING_PROGRESS, {
    questId: 'quest-1',
    questName: 'Quest One',
    progress: 50,
    nextActionAt: '2030-01-01T00:00:00.000Z',
    metadata: { source: 'test' },
  });

  const state = getRunnerState('scheduled:1');
  assert.equal(state.state, RUNNER_STATE.RUNNING_PROGRESS);
  assert.equal(state.quest_id, 'quest-1');
  assert.equal(state.quest_name, 'Quest One');
  assert.equal(state.progress, 50);
  assert.deepEqual(state.metadata, { source: 'test' });
});

test('process restart marks non-terminal work as recovering without touching terminal rows', () => {
  beginRunnerState({
    jobKey: 'scheduled:1',
    ownerId: 'owner-1',
    mode: 'scheduled',
    state: RUNNER_STATE.RUNNING_PROGRESS,
  });
  beginRunnerState({
    jobKey: 'oneshot:1',
    ownerId: 'owner-1',
    mode: 'oneshot',
    state: RUNNER_STATE.COMPLETED,
  });

  const changed = markInterruptedRunnerStates(new Date('2030-01-01T00:00:00.000Z'));
  assert.equal(changed, 1);
  assert.equal(getRunnerState('scheduled:1').state, RUNNER_STATE.RECOVERING);
  assert.equal(getRunnerState('oneshot:1').state, RUNNER_STATE.COMPLETED);
});

test('activeOnly excludes completed, stopped and failed rows', () => {
  for (const [jobKey, state] of [
    ['active', RUNNER_STATE.WAITING_SCHEDULE],
    ['completed', RUNNER_STATE.COMPLETED],
    ['stopped', RUNNER_STATE.STOPPED],
    ['failed', RUNNER_STATE.FAILED],
  ]) {
    beginRunnerState({ jobKey, ownerId: 'owner-1', mode: 'scheduled', state });
  }

  assert.deepEqual(
    listRunnerStates({ ownerId: 'owner-1', activeOnly: true }).map((row) => row.job_key),
    ['active'],
  );
});
