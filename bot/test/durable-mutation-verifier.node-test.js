import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isRunnerMutationVerifiedByQuest,
  verifyRunnerMutationFromQuests,
} from '../src/quest/durable-mutation-verifier.js';
import {
  beginRunnerState,
  getRunnerState,
  prepareRunnerMutation,
  RUNNER_MUTATION_KIND,
  RUNNER_MUTATION_STATUS,
  RUNNER_STATE,
} from '../src/quest/runner-state-store.js';

test('video recovery verifies normalized server progress at the persisted timestamp', () => {
  const jobKey = 'scheduled:verifier-video';
  beginRunnerState({ jobKey, ownerId: 'owner-verifier', mode: 'scheduled' });
  prepareRunnerMutation(jobKey, {
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

  assert.equal(isRunnerMutationVerifiedByQuest(getRunnerState(jobKey), quest), true);
  const result = verifyRunnerMutationFromQuests(jobKey, [quest]);
  assert.equal(result.verified, true);
  const state = getRunnerState(jobKey);
  assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.VERIFIED);
  assert.equal(state.server_progress_seconds, 30);
});

test('absent mutation evidence clears the uncertain checkpoint before execution resumes', () => {
  const jobKey = 'scheduled:verifier-claim';
  beginRunnerState({ jobKey, ownerId: 'owner-verifier', mode: 'scheduled' });
  prepareRunnerMutation(jobKey, {
    kind: RUNNER_MUTATION_KIND.CLAIM,
    questId: 'quest-claim',
    payload: { platform: 4 },
  });
  const result = verifyRunnerMutationFromQuests(jobKey, [{
    id: 'quest-claim',
    claimed: false,
    completed: true,
  }]);

  assert.equal(result.checked, true);
  assert.equal(result.verified, false);
  const state = getRunnerState(jobKey);
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
