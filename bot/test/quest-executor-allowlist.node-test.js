import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesDesktopQuest } from '../src/quest/executors/desktop-executor.js';
import { selectQuestExecutor } from '../src/quest/executors/registry.js';
import { matchesVideoQuest } from '../src/quest/executors/video-executor.js';

test('video executor accepts only verified event names', () => {
  assert.equal(matchesVideoQuest('WATCH_VIDEO'), true);
  assert.equal(matchesVideoQuest('WATCH_VIDEO_ON_MOBILE'), true);
  assert.equal(matchesVideoQuest('WATCH_VIDEO_NEW_PROTOCOL'), false);
  assert.equal(matchesVideoQuest('WATCH_VIDEO_V99'), false);
});

test('desktop executor accepts only verified event names', () => {
  assert.equal(matchesDesktopQuest('PLAY_ON_DESKTOP'), true);
  assert.equal(matchesDesktopQuest('PLAY_ON_DESKTOP_V2'), true);
  assert.equal(matchesDesktopQuest('PLAY_ON_DESKTOP_V3'), false);
  assert.equal(matchesDesktopQuest('PLAY_ON_DESKTOP_V99'), false);
});

test('unknown lookalike events are quarantined instead of executed automatically', () => {
  for (const eventName of ['WATCH_VIDEO_NEW_PROTOCOL', 'PLAY_ON_DESKTOP_V3']) {
    const executor = selectQuestExecutor({ eventName });
    assert.equal(executor.supportsAutomaticProgress, false);
    assert.equal(executor.id, 'unknown');
  }
});
