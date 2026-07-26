import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquireProcessRoleLease,
  clearProcessRoleLeasesForTests,
  releaseProcessRoleLease,
} from '../src/process-topology.js';

test.beforeEach(clearProcessRoleLeasesForTests);
test.afterEach(clearProcessRoleLeasesForTests);

test('control and worker leases can coexist', () => {
  assert.equal(acquireProcessRoleLease('control', 'control-holder'), true);
  assert.equal(acquireProcessRoleLease('worker', 'worker-holder'), true);
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
});

test('duplicate process role is rejected for a different holder', () => {
  assert.equal(acquireProcessRoleLease('worker', 'worker-a'), true);
  assert.equal(acquireProcessRoleLease('worker', 'worker-b'), false);
  assert.equal(acquireProcessRoleLease('worker', 'worker-a'), true);
});
