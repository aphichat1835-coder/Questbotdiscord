import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquireProcessRoleLease,
  clearProcessRoleLeasesForTests,
  isProcessRoleActive,
  listActiveProcessRoles,
  releaseProcessRoleLease,
} from '../src/process-topology.js';

test.beforeEach(clearProcessRoleLeasesForTests);
test.afterEach(clearProcessRoleLeasesForTests);

test('control and worker leases can coexist', () => {
  assert.equal(acquireProcessRoleLease('control', 'control-holder'), true);
  assert.equal(acquireProcessRoleLease('worker', 'worker-holder'), true);
  assert.equal(isProcessRoleActive('control'), true);
  assert.equal(isProcessRoleActive('worker'), true);
  assert.deepEqual(listActiveProcessRoles(), ['control', 'worker']);
  assert.equal(releaseProcessRoleLease('worker', 'worker-holder'), true);
  assert.equal(releaseProcessRoleLease('control', 'control-holder'), true);
});

test('all-in-one lease conflicts with split topology', () => {
  assert.equal(acquireProcessRoleLease('control', 'control-holder'), true);
  assert.equal(acquireProcessRoleLease('all', 'all-holder'), false);
  assert.equal(releaseProcessRoleLease('control', 'control-holder'), true);

  assert.equal(acquireProcessRoleLease('all', 'all-holder'), true);
  assert.equal(acquireProcessRoleLease('control', 'control-holder'), false);
  assert.equal(acquireProcessRoleLease('worker', 'worker-holder'), false);
  assert.deepEqual(listActiveProcessRoles(), ['all']);
});

test('duplicate process role is rejected for a different holder', () => {
  assert.equal(acquireProcessRoleLease('worker', 'worker-a'), true);
  assert.equal(acquireProcessRoleLease('worker', 'worker-b'), false);
  assert.equal(acquireProcessRoleLease('worker', 'worker-a'), true);
});

test('expired leases are excluded from active role discovery', () => {
  const now = Date.now();
  assert.equal(acquireProcessRoleLease('worker', 'worker-a', 1000), true);
  assert.equal(isProcessRoleActive('worker', now + 2000), false);
  assert.deepEqual(listActiveProcessRoles(now + 2000), []);
});
