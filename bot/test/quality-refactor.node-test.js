import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { settleWithTimeout } from '../src/async-settle.js';

test('settleWithTimeout accepts a Set iterable and waits for every task', async () => {
  const tasks = new Set([
    Promise.resolve('first'),
    Promise.resolve('second'),
  ]);
  const results = await settleWithTimeout(tasks);
  assert.deepEqual(results.map((result) => result.value), ['first', 'second']);
});

test('settleWithTimeout reports the current number of pending tasks on timeout', async () => {
  const pending = new Set([new Promise(() => {})]);
  await assert.rejects(
    settleWithTimeout(pending, 5, {
      pendingCount: () => pending.size,
      timeoutMessage: (count) => `still waiting for ${count}`,
    }),
    /still waiting for 1/,
  );
});

test('settleWithTimeout does not report a timeout after tasks finish', async () => {
  const pending = new Set();
  const task = new Promise((resolve) => setTimeout(resolve, 5));
  pending.add(task);
  void task.finally(() => pending.delete(task));
  await settleWithTimeout(pending, 100, {
    pendingCount: () => pending.size,
    timeoutMessage: (count) => `unexpected ${count}`,
  });
  assert.equal(pending.size, 0);
});

test('runner quality refactor keeps static-analysis regressions out', async () => {
  const runner = await readFile(new URL('../src/discord-runner.js', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');

  assert.doesNotMatch(runner, /Promise\.allSettled\(\[\.\.\.activeRunPromises\]\)/);
  assert.doesNotMatch(worker, /Promise\.allSettled\(\[\.\.\.activeTasks\]\)/);
  assert.match(runner, /settleWithTimeout\(activeRunPromises,/);
  assert.match(worker, /settleWithTimeout\(activeTasks,/);

  const startRunnerIndex = runner.indexOf('export async function startRunner');
  assert.ok(startRunnerIndex > 0);
  assert.ok(runner.indexOf('function oneShotFreshQuestFailureReason', 0) < startRunnerIndex);
  assert.ok(runner.indexOf('function oneShotUnavailableReason', 0) < startRunnerIndex);

  assert.match(runner, /function prepareQuestRound\(/);
  assert.match(runner, /async function refreshRoundQuest\(/);
  assert.match(runner, /async function ensureQuestEnrollment\(/);
  assert.match(runner, /async function verifyQuestCompletion\(/);
  assert.match(runner, /function nextVideoTimestamp\(/);
  assert.match(runner, /async function submitVideoProgressStep\(/);
  const executeProgressIndex = runner.indexOf('async function executeQuestProgress');
  const abortAfterRunnerIndex = runner.indexOf(
    "if (signal.aborted) throw new Error('aborted');",
    executeProgressIndex,
  );
  const executeProgressEnd = runner.indexOf(
    'async function verificationFailureOutcome',
    executeProgressIndex,
  );
  assert.ok(abortAfterRunnerIndex > executeProgressIndex);
  assert.ok(abortAfterRunnerIndex < executeProgressEnd);
});
