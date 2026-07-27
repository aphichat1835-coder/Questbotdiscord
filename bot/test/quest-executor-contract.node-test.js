import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertQuestExecutorContract,
  describeUnsupportedQuest,
  executeQuestExecutor,
  QUEST_EXECUTORS,
  selectQuestExecutor,
} from '../src/quest/executors.js';

const REQUIRED_METHODS = [
  'matches',
  'validate',
  'estimateDuration',
  'execute',
  'verify',
  'describeUnsupportedReason',
];

test('every registered executor implements the complete plugin contract', () => {
  for (const executor of QUEST_EXECUTORS) {
    assert.equal(assertQuestExecutorContract(executor), executor);
    for (const method of REQUIRED_METHODS) assert.equal(typeof executor[method], 'function');
  }
});

test('video executor delegates execution and verification through injected context', async () => {
  const calls = [];
  const quest = {
    id: 'video-1',
    eventName: 'WATCH_VIDEO_V2',
    secondsNeeded: 60,
    progressSecs: 10,
  };
  const executor = selectQuestExecutor(quest);
  const result = await executeQuestExecutor(executor, {
    quest,
    executeVideo: async (value) => {
      calls.push(['execute', value.id]);
      return { completed: true };
    },
    verifyCompletion: async (value, executionResult) => {
      calls.push(['verify', value.id, executionResult.completed]);
      return true;
    },
  });

  assert.equal(executor.id, 'video');
  assert.equal(result.verified, true);
  assert.deepEqual(calls, [
    ['execute', 'video-1'],
    ['verify', 'video-1', true],
  ]);
});

test('unsupported and unknown Quests expose structured reasons and cannot execute', () => {
  assert.equal(describeUnsupportedQuest({ eventName: 'PLAY_ON_XBOX' }), 'UNSUPPORTED_EVENT');
  assert.equal(describeUnsupportedQuest({ eventName: 'NEW_EVENT' }), 'UNKNOWN_EVENT');
  assert.equal(describeUnsupportedQuest({ eventName: 'WATCH_VIDEO', autoSupported: false }), 'MULTI_TASK_AND');
});
