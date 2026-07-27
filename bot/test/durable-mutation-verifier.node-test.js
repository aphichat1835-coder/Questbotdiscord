import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isRunnerMutationVerifiedByQuest,
  verifyRunnerMutationFromQuests,
} from '../src/quest/durable-mutation-verifier.js';
import {
  beginRunnerState,
  clearRunnerStatesForTests,
  getRunnerState,
  prepareRunnerMutation,
  RUNNER_MUTATION_KIND,
  RUNNER_MUTATION_STATUS,
  RUNNER_STATE,
} from '../src/quest/runner-state-store.js';

test.beforeEach(() => clearRunnerStatesForTests());

test('video recovery verifies normalized server progress at the persisted timestamp', () => {
  beginRunnerState({ jobKey: 'scheduled:video', ownerId: 'owner-1', mode: 'scheduled' });
  prepareRunnerMutation('scheduled:video', {
    kind: RUNNER_MUTATION_KIND.VIDEO_PROGRESS,
    questId: 'quest-video',
    payload: { timestamp: 30 },
  });
  const quest = {
    id: 'quest-video',
    progressSecs: 30,
    progress: 50,
    completed: false,
  };

  assert.equal(isRunnerMutationVerifiedByQuest(getRunnerState('scheduled:video'), quest), true);
  const result = verifyRunnerMutationFromQuests('scheduled:video', [quest]);
  assert.equal(result.verified, true);
  const state = getRunnerState('scheduled:video');
  assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.VERIFIED);
  assert.equal(state.server_progress_seconds, 30);
});

test('absent mutation evidence clears the uncertain checkpoint before execution resumes', () => {
  beginRunnerState({ jobKey: 'scheduled:claim', ownerId: 'owner-1', mode: 'scheduled' });
  prepareRunnerMutation('scheduled:claim', {
    kind: RUNNER_MUTATION_KIND.CLAIM,
    questId: 'quest-claim',
    payload: { platform: 4 },
  });
  const result = verifyRunnerMutationFromQuests('scheduled:claim', [{
    id: 'quest-claim',
    claimed: false,
    completed: true,
  }]);

  assert.equal(result.checked, true);
  assert.equal(result.verified, false);
  const state = getRunnerState('scheduled:claim');
  assert.equal(state.state, RUNNER_STATE.RUNNING);
  assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.NONE);
  assert.equal(state.mutation_kind, null);
});

test('raw Quest responses can verify enrollment and heartbeat checkpoints', () => {
  const enrollment = {
    mutation_kind: RUNNER_MUTATION_KIND.ENROLL,
  };
  assert.equal(isRunnerMutationVerifiedByQuest(enrollment, {
    user_status: { enrolled_at: '2030-01-01T00:00:00.000Z' },
  }), true);

  const heartbeat = {
    mutation_kind: RUNNER_MUTATION_KIND.HEARTBEAT,
    server_progress_seconds: 10,
  };
  assert.equal(isRunnerMutationVerifiedByQuest(heartbeat, {
    user_status: { progress: { PLAY_ON_DESKTOP: { value: 11 } } },
  }), true);
});
