import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completeOneShotQuest,
  createOneShotQuestSession,
  EXTERNAL_COMPLETION_REASON,
  failOneShotQuest,
  getNextPendingOneShotQuest,
  getOneShotQuest,
  getOneShotSessionSummary,
  hasOneShotQuest,
  isOneShotSessionComplete,
  markOneShotProgressMutationSent,
  markOneShotQuestRunning,
  ONE_SHOT_QUEST_STATUS,
  recordOneShotVerifiedProgress,
} from '../src/one-shot-quest-session.js';

function quest(id, progressSecs = 0) {
  return {
    id,
    name: `Quest ${id.toUpperCase()}`,
    eventName: 'WATCH_VIDEO',
    progressSecs,
  };
}

test('session locks the initial quest ids and preserves their order', () => {
  const session = createOneShotQuestSession([quest('a'), quest('b'), quest('a')]);

  assert.deepEqual(session.questOrder, ['a', 'b']);
  assert.equal(session.totalSupportedQuests, 2);
  assert.equal(hasOneShotQuest(session, 'a'), true);
  assert.equal(hasOneShotQuest(session, 'c'), false);
  assert.equal(getNextPendingOneShotQuest(session).id, 'a');
});

test('bot completion requires a started attempt, an accepted mutation and verified progress', () => {
  const session = createOneShotQuestSession([quest('a', 4)]);

  assert.equal(markOneShotQuestRunning(session, 'a', 5), true);
  assert.equal(markOneShotProgressMutationSent(session, 'a'), true);
  assert.equal(recordOneShotVerifiedProgress(session, 'a', 6), true);
  assert.equal(completeOneShotQuest(session, 'a'), ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT);

  const summary = getOneShotSessionSummary(session);
  assert.equal(summary.completedByBotCount, 1);
  assert.equal(summary.completedExternalCount, 0);
  assert.equal(summary.issues.length, 0);
  assert.equal(isOneShotSessionComplete(session), true);
});

test('a completion without verified bot progress is classified as external', () => {
  const session = createOneShotQuestSession([quest('a')]);

  assert.equal(completeOneShotQuest(session, 'a'), ONE_SHOT_QUEST_STATUS.COMPLETED_EXTERNAL);
  assert.equal(getOneShotQuest(session, 'a').reason, EXTERNAL_COMPLETION_REASON);

  const summary = getOneShotSessionSummary(session);
  assert.equal(summary.completedByBotCount, 0);
  assert.equal(summary.completedExternalCount, 1);
  assert.deepEqual(summary.issues, [{
    id: 'a',
    name: 'Quest A',
    reason: EXTERNAL_COMPLETION_REASON,
  }]);
});

test('pre-existing progress is moved into the baseline before bot attribution', () => {
  const session = createOneShotQuestSession([quest('a', 1)]);

  markOneShotQuestRunning(session, 'a', 7);
  markOneShotProgressMutationSent(session, 'a');
  assert.equal(recordOneShotVerifiedProgress(session, 'a', 7), false);
  assert.equal(recordOneShotVerifiedProgress(session, 'a', 8), true);
  assert.equal(completeOneShotQuest(session, 'a'), ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT);
});

test('accepted mutation may prove an immediate completion', () => {
  const session = createOneShotQuestSession([quest('a')]);

  markOneShotQuestRunning(session, 'a', 0);
  markOneShotProgressMutationSent(session, 'a');
  assert.equal(recordOneShotVerifiedProgress(session, 'a', 0, { completed: true }), true);
  assert.equal(completeOneShotQuest(session, 'a'), ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT);
});

test('failure is terminal, ordered and cannot be overwritten by a later completion', () => {
  const session = createOneShotQuestSession([quest('a'), quest('b')]);

  assert.equal(failOneShotQuest(session, 'a', 'Discord ยังไม่ยืนยันสถานะเสร็จ'), true);
  assert.equal(failOneShotQuest(session, 'a', 'duplicate'), false);
  assert.equal(completeOneShotQuest(session, 'a'), ONE_SHOT_QUEST_STATUS.FAILED);
  assert.equal(getNextPendingOneShotQuest(session).id, 'b');

  const summary = getOneShotSessionSummary(session);
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.pendingCount, 1);
  assert.deepEqual(summary.issues, [{
    id: 'a',
    name: 'Quest A',
    reason: 'Discord ยังไม่ยืนยันสถานะเสร็จ',
  }]);
});
