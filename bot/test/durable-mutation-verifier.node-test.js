import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateRunnerMutationEvidence,
  isRunnerMutationVerifiedByQuest,
  RUNNER_MUTATION_EVIDENCE,
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

function checkpoint(jobKey, kind, questId, payload = null) {
  beginRunnerState({ jobKey, ownerId: `owner-${jobKey}`, mode: 'scheduled' });
  prepareRunnerMutation(jobKey, { kind, questId, payload });
  return getRunnerState(jobKey);
}

test('video recovery verifies normalized server progress at the persisted timestamp', () => {
  const jobKey = 'scheduled:verifier-video';
  checkpoint(jobKey, RUNNER_MUTATION_KIND.VIDEO_PROGRESS, 'quest-video', { timestamp: 30 });
  const quest = {
    id: 'quest-video',
    progressSecs: 30,
    progress: 50,
    completed: false,
  };

  assert.equal(isRunnerMutationVerifiedByQuest(getRunnerState(jobKey), quest), true);
  const result = verifyRunnerMutationFromQuests(jobKey, [quest]);
  assert.equal(result.verified, true);
  assert.equal(result.outcome, RUNNER_MUTATION_EVIDENCE.VERIFIED);
  const state = getRunnerState(jobKey);
  assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.VERIFIED);
  assert.equal(state.server_progress_seconds, 30);
});

test('passive Quest-list observation preserves an absent checkpoint', () => {
  const jobKey = 'scheduled:verifier-passive-claim';
  checkpoint(jobKey, RUNNER_MUTATION_KIND.CLAIM, 'quest-passive-claim', { platform: 4 });
  const result = verifyRunnerMutationFromQuests(jobKey, [{
    id: 'quest-passive-claim',
    claimed: false,
    completed: true,
  }]);

  assert.equal(result.checked, true);
  assert.equal(result.verified, false);
  assert.equal(result.preserved, true);
  assert.equal(result.outcome, RUNNER_MUTATION_EVIDENCE.NOT_APPLIED);
  const state = getRunnerState(jobKey);
  assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.PREPARED);
  assert.equal(state.mutation_kind, RUNNER_MUTATION_KIND.CLAIM);
});

test('recovery finalization clears a confirmed not-applied checkpoint', () => {
  const jobKey = 'scheduled:verifier-final-claim';
  checkpoint(jobKey, RUNNER_MUTATION_KIND.CLAIM, 'quest-final-claim', { platform: 4 });
  const result = verifyRunnerMutationFromQuests(jobKey, [{
    id: 'quest-final-claim',
    claimed: false,
    completed: true,
  }], { finalizeAbsent: true });

  assert.equal(result.checked, true);
  assert.equal(result.verified, false);
  assert.equal(result.retryAllowed, true);
  assert.equal(result.outcome, RUNNER_MUTATION_EVIDENCE.NOT_APPLIED);
  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.RUNNING);
  assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.NONE);
  assert.equal(state.mutation_kind, null);
});

test('missing Quest evidence is terminal for the mutation and cannot be retried blindly', () => {
  const jobKey = 'scheduled:verifier-missing';
  const state = checkpoint(
    jobKey,
    RUNNER_MUTATION_KIND.HEARTBEAT,
    'quest-missing',
    { terminal: false },
  );
  const evidence = evaluateRunnerMutationEvidence(state, []);
  assert.equal(evidence.outcome, RUNNER_MUTATION_EVIDENCE.QUEST_MISSING);

  const result = verifyRunnerMutationFromQuests(jobKey, [], { finalizeAbsent: true });
  assert.equal(result.retryAllowed, false);
  assert.equal(result.outcome, RUNNER_MUTATION_EVIDENCE.QUEST_MISSING);
  assert.equal(getRunnerState(jobKey).mutation_status, RUNNER_MUTATION_STATUS.FAILED);
});

test('expired Quest evidence is not treated as a missing progress mutation', () => {
  const jobKey = 'scheduled:verifier-expired';
  checkpoint(jobKey, RUNNER_MUTATION_KIND.VIDEO_PROGRESS, 'quest-expired', { timestamp: 30 });
  const result = verifyRunnerMutationFromQuests(jobKey, [{
    id: 'quest-expired',
    progressSecs: 0,
    completed: false,
    expiresAt: '2029-01-01T00:00:00.000Z',
  }], {
    finalizeAbsent: true,
    now: new Date('2030-01-01T00:00:00.000Z'),
  });

  assert.equal(result.outcome, RUNNER_MUTATION_EVIDENCE.QUEST_EXPIRED);
  assert.equal(result.retryAllowed, false);
  assert.equal(getRunnerState(jobKey).mutation_status, RUNNER_MUTATION_STATUS.FAILED);
});

test('incompatible Quest evidence blocks mutation retry', () => {
  const jobKey = 'scheduled:verifier-incompatible';
  checkpoint(jobKey, RUNNER_MUTATION_KIND.HEARTBEAT, 'quest-incompatible', { terminal: false });
  const result = verifyRunnerMutationFromQuests(jobKey, [{
    id: 'quest-incompatible',
    progressSecs: 0,
    completed: false,
    autoSupported: false,
    schemaIssues: ['multi-task AND'],
  }], { finalizeAbsent: true });

  assert.equal(result.outcome, RUNNER_MUTATION_EVIDENCE.QUEST_INCOMPATIBLE);
  assert.equal(result.retryAllowed, false);
  assert.equal(getRunnerState(jobKey).mutation_status, RUNNER_MUTATION_STATUS.FAILED);
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
