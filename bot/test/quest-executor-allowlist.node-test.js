import assert from 'node:assert/strict';
import test from 'node:test';
import { executeQuestExecutor, selectQuestExecutor } from '../src/quest/executors.js';
import { matchesDesktopQuest } from '../src/quest/executors/desktop-executor.js';
import { matchesVideoQuest } from '../src/quest/executors/video-executor.js';

test('video executor accepts compatible WATCH_VIDEO protocol variants', () => {
  assert.equal(matchesVideoQuest('WATCH_VIDEO'), true);
  assert.equal(matchesVideoQuest('WATCH_VIDEO_ON_MOBILE'), true);
  assert.equal(matchesVideoQuest('WATCH_VIDEO_V2'), true);
  assert.equal(matchesVideoQuest('WATCH_VIDEO_NEW_PROTOCOL'), true);
  assert.equal(matchesVideoQuest('STREAM_ON_DESKTOP'), false);
});

test('desktop executor accepts versioned PLAY_ON_DESKTOP protocol variants only', () => {
  assert.equal(matchesDesktopQuest('PLAY_ON_DESKTOP'), true);
  assert.equal(matchesDesktopQuest('PLAY_ON_DESKTOP_V2'), true);
  assert.equal(matchesDesktopQuest('PLAY_ON_DESKTOP_V3'), true);
  assert.equal(matchesDesktopQuest('PLAY_ON_DESKTOP_V99'), true);
  assert.equal(matchesDesktopQuest('PLAY_ON_DESKTOP_NEW_PROTOCOL'), false);
});

test('lookalike variants still fail closed when required Quest schema is invalid', async () => {
  const quest = {
    id: 'invalid-video-variant',
    eventName: 'WATCH_VIDEO_NEW_PROTOCOL',
    secondsNeeded: 0,
    progressSecs: 0,
    completed: false,
  };
  const executor = selectQuestExecutor(quest);

  assert.equal(executor.id, 'video');
  await assert.rejects(
    () => executeQuestExecutor(executor, { quest }),
    (error) => (
      error?.name === 'QuestExecutorValidationError'
      && error.executorId === 'video'
      && error.issues.includes('video Quest has an invalid target')
    ),
  );
});

test('events outside verified protocol families remain quarantined', () => {
  for (const eventName of ['BRAND_NEW_EVENT', 'PLAY_ON_DESKTOP_NEW_PROTOCOL']) {
    const executor = selectQuestExecutor({ eventName });
    assert.equal(executor.supportsAutomaticProgress, false);
    assert.equal(executor.id, 'unknown');
    assert.equal(executor.mutation, null);
    assert.equal(executor.describeUnsupportedReason({ eventName }), 'UNKNOWN_EVENT');
  }
});
