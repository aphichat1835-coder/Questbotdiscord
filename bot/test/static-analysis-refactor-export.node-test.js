import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function replaceExactlyOnce(source, before, after, label) {
  assert.equal(source.split(before).length - 1, 1, `${label} target count`);
  return source.replace(before, after);
}

function emitFile(path, content) {
  console.log(`STATIC_REFACTOR_BEGIN:${path}`);
  console.log(Buffer.from(content, 'utf8').toString('base64'));
  console.log(`STATIC_REFACTOR_END:${path}`);
}

test('export Sonar and CodeFactor refactor without changing behavior', async () => {
  const coordinatorUrl = new URL('../src/quest/rate-limit-coordinator.js', import.meta.url);
  const runnerUrl = new URL('../src/discord-runner.js', import.meta.url);
  const statusTestUrl = new URL('./quest-status-redesign.node-test.js', import.meta.url);

  const coordinatorBefore = await readFile(coordinatorUrl, 'utf8');
  const runnerBefore = await readFile(runnerUrl, 'utf8');
  const statusTestBefore = await readFile(statusTestUrl, 'utf8');

  const oldCoordinator = `  pruneExpiredState({ force = false } = {}) {
    const now = this.now();
    if (
      !force
      && this.lastStatePruneAt > 0
      && now - this.lastStatePruneAt < this.statePruneIntervalMs
    ) {
      return { skipped: true, pruned: 0 };
    }

    this.lastStatePruneAt = now;
    let pruned = 0;
    const pruneExpiredResetMap = (map) => {
      for (const [key, resetAt] of map) {
        if (resetAt > now) continue;
        map.delete(key);
        pruned++;
      }
    };

    pruneExpiredResetMap(this.bucketResetAt);
    pruneExpiredResetMap(this.accountBucketResetAt);
    if (this.globalResetAt > 0 && this.globalResetAt <= now) {
      this.globalResetAt = 0;
      pruned++;
    }

    if (this.activeCount === 0 && this.queue.length === 0) {
      const cutoff = now - this.stateRetentionMs;
      const knownRoutes = new Set([
        ...this.routeBuckets.keys(),
        ...this.routeScopes.keys(),
        ...this.routeLastSeenAt.keys(),
      ]);
      for (const route of knownRoutes) {
        const lastSeenAt = this.routeLastSeenAt.get(route) ?? 0;
        if (lastSeenAt > cutoff) continue;
        if (this.routeBuckets.delete(route)) pruned++;
        if (this.routeScopes.delete(route)) pruned++;
        if (this.routeLastSeenAt.delete(route)) pruned++;
      }

      for (const [key, circuit] of this.circuits) {
        if (circuit.probeActive) continue;
        const protectedUntil = Math.max(
          circuit.openUntil ?? 0,
          (circuit.lastTouchedAt ?? 0) + this.stateRetentionMs,
        );
        if (protectedUntil > now) continue;
        this.circuits.delete(key);
        pruned++;
      }
    }

    this.stats.statePrunes++;
    this.stats.prunedEntries += pruned;
    this.stats.lastStatePruneAt = new Date(now).toISOString();
    return { skipped: false, pruned };
  }
`;

  const newCoordinator = `  shouldSkipStatePrune(now, force) {
    return !force
      && this.lastStatePruneAt > 0
      && now - this.lastStatePruneAt < this.statePruneIntervalMs;
  }

  pruneExpiredResetEntries(map, now) {
    let pruned = 0;
    for (const [key, resetAt] of map) {
      if (resetAt > now) continue;
      if (map.delete(key)) pruned++;
    }
    return pruned;
  }

  pruneExpiredGlobalReset(now) {
    if (this.globalResetAt <= 0 || this.globalResetAt > now) return 0;
    this.globalResetAt = 0;
    return 1;
  }

  pruneStaleRouteMetadata(now) {
    const cutoff = now - this.stateRetentionMs;
    const knownRoutes = new Set([
      ...this.routeBuckets.keys(),
      ...this.routeScopes.keys(),
      ...this.routeLastSeenAt.keys(),
    ]);
    let pruned = 0;
    for (const route of knownRoutes) {
      const lastSeenAt = this.routeLastSeenAt.get(route) ?? 0;
      if (lastSeenAt > cutoff) continue;
      pruned += Number(this.routeBuckets.delete(route));
      pruned += Number(this.routeScopes.delete(route));
      pruned += Number(this.routeLastSeenAt.delete(route));
    }
    return pruned;
  }

  pruneIdleCircuits(now) {
    let pruned = 0;
    for (const [key, circuit] of this.circuits) {
      if (circuit.probeActive) continue;
      const protectedUntil = Math.max(
        circuit.openUntil ?? 0,
        (circuit.lastTouchedAt ?? 0) + this.stateRetentionMs,
      );
      if (protectedUntil > now) continue;
      if (this.circuits.delete(key)) pruned++;
    }
    return pruned;
  }

  pruneIdleMetadata(now) {
    if (this.activeCount !== 0 || this.queue.length !== 0) return 0;
    return this.pruneStaleRouteMetadata(now) + this.pruneIdleCircuits(now);
  }

  recordStatePrune(now, pruned) {
    this.stats.statePrunes++;
    this.stats.prunedEntries += pruned;
    this.stats.lastStatePruneAt = new Date(now).toISOString();
  }

  pruneExpiredState({ force = false } = {}) {
    const now = this.now();
    if (this.shouldSkipStatePrune(now, force)) {
      return { skipped: true, pruned: 0 };
    }

    this.lastStatePruneAt = now;
    const pruned = this.pruneExpiredResetEntries(this.bucketResetAt, now)
      + this.pruneExpiredResetEntries(this.accountBucketResetAt, now)
      + this.pruneExpiredGlobalReset(now)
      + this.pruneIdleMetadata(now);
    this.recordStatePrune(now, pruned);
    return { skipped: false, pruned };
  }
`;

  const coordinatorAfter = replaceExactlyOnce(
    coordinatorBefore,
    oldCoordinator,
    newCoordinator,
    'coordinator',
  );

  const oldHelpers = `  async function completeAndClaimOneShotQuest(quest) {
    const status = completeOneShotQuest(oneShotSession, quest.id);
    const claimed = await claimSilently(quest);
    recordOneShotRewardClaim(oneShotSession, quest.id, { claimed });
    return status;
  }

  async function reportOneShotExternalCompletion() {
    if (mode !== 'oneshot') return null;
    await reportOneShotTerminalState();
    return oneShotOutcome();
  }

  async function reportOneShotBotCompletion() {
    if (mode !== 'oneshot') return null;
    await reportOneShotTerminalState();
    return oneShotOutcome();
  }
`;
  const newHelpers = `  async function completeAndClaimOneShotQuest(quest) {
    completeOneShotQuest(oneShotSession, quest.id);
    const claimed = await claimSilently(quest);
    recordOneShotRewardClaim(oneShotSession, quest.id, { claimed });
  }

  async function reportOneShotCompletion() {
    if (mode !== 'oneshot') return null;
    await reportOneShotTerminalState();
    return oneShotOutcome();
  }
`;
  let runnerAfter = replaceExactlyOnce(runnerBefore, oldHelpers, newHelpers, 'runner helpers');

  const firstOldCall = `      if (mode === 'oneshot') {
        const status = await completeAndClaimOneShotQuest(quest);
        return status === ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT
          ? reportOneShotBotCompletion()
          : reportOneShotExternalCompletion();
      }
`;
  const firstNewCall = `      if (mode === 'oneshot') {
        await completeAndClaimOneShotQuest(quest);
        return reportOneShotCompletion();
      }
`;
  runnerAfter = replaceExactlyOnce(
    runnerAfter,
    firstOldCall,
    firstNewCall,
    'runner pending completion call',
  );

  const secondOldCall = `    if (mode === 'oneshot') {
      const status = await completeAndClaimOneShotQuest(fresh);
      return status === ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT
        ? reportOneShotBotCompletion()
        : reportOneShotExternalCompletion();
    }
`;
  const secondNewCall = `    if (mode === 'oneshot') {
      await completeAndClaimOneShotQuest(fresh);
      return reportOneShotCompletion();
    }
`;
  runnerAfter = replaceExactlyOnce(
    runnerAfter,
    secondOldCall,
    secondNewCall,
    'runner verified completion call',
  );

  const statusTestAfter = statusTestBefore.replace(
    "  assert.match(source, /reportOneShotBotCompletion\\(\\)/);\n  assert.match(source, /reportOneShotExternalCompletion\\(\\)/);",
    "  assert.match(source, /reportOneShotCompletion\\(\\)/);\n  assert.doesNotMatch(source, /reportOneShot(?:Bot|External)Completion/);",
  );
  assert.notEqual(statusTestAfter, statusTestBefore, 'status test target');

  assert.match(coordinatorAfter, /pruneExpiredResetEntries/);
  assert.doesNotMatch(runnerAfter, /reportOneShotExternalCompletion/);
  assert.doesNotMatch(runnerAfter, /reportOneShotBotCompletion/);
  assert.match(runnerAfter, /reportOneShotCompletion/);

  emitFile('bot/src/quest/rate-limit-coordinator.js', coordinatorAfter);
  emitFile('bot/src/discord-runner.js', runnerAfter);
  emitFile('bot/test/quest-status-redesign.node-test.js', statusTestAfter);
});
