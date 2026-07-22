import assert from 'node:assert/strict';
import test from 'node:test';
import { withOwnerAdmissionLock } from '../src/run-admission-lock.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('runner admission is serialized for the same owner', async () => {
  const firstRelease = deferred();
  const firstStarted = deferred();
  const order = [];

  const first = withOwnerAdmissionLock('owner-a', async () => {
    order.push('first-start');
    firstStarted.resolve();
    await firstRelease.promise;
    order.push('first-end');
  });

  await firstStarted.promise;
  const second = withOwnerAdmissionLock('owner-a', async () => {
    order.push('second-start');
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['first-start']);

  firstRelease.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start']);
});

test('different owners can perform admission concurrently', async () => {
  const release = deferred();
  const started = [];

  const first = withOwnerAdmissionLock('owner-a', async () => {
    started.push('owner-a');
    await release.promise;
  });
  const second = withOwnerAdmissionLock('owner-b', async () => {
    started.push('owner-b');
    await release.promise;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(new Set(started), new Set(['owner-a', 'owner-b']));

  release.resolve();
  await Promise.all([first, second]);
});
