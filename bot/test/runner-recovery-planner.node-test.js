import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyRunnerRecoveryPlan,
  planRunnerRecovery,
  RUNNER_RECOVERY_ACTION,
} from '../src/quest/recovery-planner.js';
import { buildScheduledRestorePlan } from '../src/quest/scheduled-restore.js';
import {
  beginRunnerState,
  clearRunnerStatesForTests,
  getRunnerState,
  prepareRunnerMutation,
  RUNNER_MUTATION_KIND,
  RUNNER_MUTATION_STATUS,
  RUNNER_STATE,
  transitionRunnerState,
} from '../src/quest/runner-state-store.js';

test.beforeEach(() => clearRunnerStatesForTests());

test('future waiting checkpoint resumes at its persisted next action time', () => {
  beginRunnerState({
    jobKey: 'scheduled:1',
    ownerId: 'owner-1',
    mode: 'scheduled',
    scheduleId: 1,
  });
  transitionRunnerState('scheduled:1', RUNNER_STATE.WAITING_RATE_LIMIT, {
    nextActionAt: '2030-01-01T01:00:00.000Z',
  });

  const recovery = buildScheduledRestorePlan(
    { id: 1, next_check_at: '2030-01-01T08:00:00.000Z' },
    new Date('2030-01-01T00:00:00.000Z'),
  );
  assert.equal(recovery.recoveryPlan.action, RUNNER_RECOVERY_ACTION.WAIT);
  assert.equal(recovery.initialNextCheckAt, '2030-01-01T01:00:00.000Z');
  assert.equal(getRunnerState('scheduled:1').state, RUNNER_STATE.WAITING_RATE_LIMIT);
});

test('uncertain mutation restarts in verification state before any resend', () => {
  beginRunnerState({
    jobKey: 'scheduled:2',
    ownerId: 'owner-1',
    mode: 'scheduled',
    scheduleId: 2,
  });
  prepareRunnerMutation('scheduled:2', {
    kind: RUNNER_MUTATION_KIND.CLAIM,
    questId: 'quest-claim',
    payload: { platform: 4 },
  });
  transitionRunnerState('scheduled:2', RUNNER_STATE.VERIFYING_CLAIM, {
    mutationStatus: RUNNER_MUTATION_STATUS.UNCERTAIN,
  });

  const plan = planRunnerRecovery(
    getRunnerState('scheduled:2'),
    new Date('2030-01-01T00:00:00.000Z'),
  );
  assert.equal(plan.action, RUNNER_RECOVERY_ACTION.VERIFY_MUTATION);
  assert.equal(plan.targetState, RUNNER_STATE.VERIFYING_CLAIM);
  assert.equal(plan.initialNextCheckAt, null);

  applyRunnerRecoveryPlan('scheduled:2', plan);
  const state = getRunnerState('scheduled:2');
  assert.equal(state.state, RUNNER_STATE.VERIFYING_CLAIM);
  assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.UNCERTAIN);
  assert.equal(state.metadata.recoveryAction, RUNNER_RECOVERY_ACTION.VERIFY_MUTATION);
});

test('one-shot recovery is rejected because its token is intentionally not durable', () => {
  beginRunnerState({ jobKey: 'oneshot:1', ownerId: 'owner-1', mode: 'oneshot' });
  const plan = planRunnerRecovery(getRunnerState('oneshot:1'));
  assert.equal(plan.action, RUNNER_RECOVERY_ACTION.FAIL);
  assert.equal(plan.targetState, RUNNER_STATE.FAILED);
});

test('active scheduled row with a terminal checkpoint starts from fresh server state', () => {
  beginRunnerState({
    jobKey: 'scheduled:3',
    ownerId: 'owner-1',
    mode: 'scheduled',
    scheduleId: 3,
    state: RUNNER_STATE.FAILED,
  });
  const plan = planRunnerRecovery(getRunnerState('scheduled:3'));
  assert.equal(plan.action, RUNNER_RECOVERY_ACTION.START_FRESH);
  assert.equal(plan.targetState, RUNNER_STATE.RECOVERING);
});
