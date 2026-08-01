import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const runnerUrl = new URL('../src/discord-runner.js', import.meta.url);
const coordinatorUrl = new URL('../src/quest/rate-limit-coordinator.js', import.meta.url);

test('one-shot completion uses one shared reporter at both completion call sites', async () => {
  const source = await readFile(runnerUrl, 'utf8');

  assert.doesNotMatch(source, /reportOneShotExternalCompletion/);
  assert.doesNotMatch(source, /reportOneShotBotCompletion/);
  assert.equal(
    [...source.matchAll(/return reportOneShotCompletion\(\);/g)].length,
    2,
  );
  assert.match(
    source,
    /await completeAndClaimOneShotQuest\(quest\);\s*return reportOneShotCompletion\(\);/,
  );
  assert.match(
    source,
    /await completeAndClaimOneShotQuest\(fresh\);\s*return reportOneShotCompletion\(\);/,
  );
});

test('coordinator state pruning delegates independent responsibilities to helpers', async () => {
  const source = await readFile(coordinatorUrl, 'utf8');

  for (const helper of [
    'shouldSkipStatePrune',
    'pruneExpiredResetEntries',
    'pruneExpiredGlobalReset',
    'pruneStaleRouteMetadata',
    'pruneIdleCircuits',
    'pruneIdleMetadata',
    'recordStatePrune',
  ]) {
    assert.match(source, new RegExp(`\\n  ${helper}\\(`));
  }

  const method = /\n  pruneExpiredState\(\{ force = false \} = \{\}\) \{([\s\S]*?)\n  \}\n\n  releaseJob/.exec(source);
  assert.ok(method, 'pruneExpiredState source contract must remain discoverable');
  assert.match(method[1], /this\.shouldSkipStatePrune\(now, force\)/);
  assert.match(method[1], /this\.pruneExpiredResetEntries\(this\.bucketResetAt, now\)/);
  assert.match(method[1], /this\.pruneIdleMetadata\(now\)/);
  assert.match(method[1], /this\.recordStatePrune\(now, pruned\)/);
  assert.doesNotMatch(method[1], /for\s*\(/);
});
