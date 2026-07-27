import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getScheduledWorkerStatus,
  releaseScheduledWorkerSupervisorClaims,
  startScheduledWorkerSupervisor,
  stopScheduledWorkerSupervisor,
} from '../src/quest/scheduled-worker-supervisor.js';
import { clearRunnerStatesForTests } from '../src/quest/runner-state-store.js';

test.beforeEach(async () => {
  await stopScheduledWorkerSupervisor();
  clearRunnerStatesForTests();
});

test.afterEach(async () => {
  await stopScheduledWorkerSupervisor();
  clearRunnerStatesForTests();
});

test('default initial reconcile records a defensive status snapshot', async () => {
  assert.equal(releaseScheduledWorkerSupervisorClaims(), 0);

  const started = await startScheduledWorkerSupervisor({}, {
    holder: 'worker:supervisor-status-test',
  });
  assert.equal(started, true);

  const first = getScheduledWorkerStatus();
  assert.equal(first.error, null);
  assert.match(first.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof first.stopRequested, 'number');
  assert.equal(typeof first.finalizedStops, 'number');
  assert.equal(typeof first.restore, 'object');

  first.error = 'caller mutation must not leak';
  assert.equal(getScheduledWorkerStatus().error, null);
});

test('stopping without automatic release preserves the holder for explicit cleanup', async () => {
  const started = await startScheduledWorkerSupervisor({}, {
    holder: 'worker:supervisor-explicit-release',
    initialReconcile: async () => ({ skipped: true }),
  });
  assert.equal(started, true);

  assert.equal(await stopScheduledWorkerSupervisor({ releaseClaims: false }), true);
  assert.equal(releaseScheduledWorkerSupervisorClaims(), 0);
  assert.equal(releaseScheduledWorkerSupervisorClaims(), 0);
});
