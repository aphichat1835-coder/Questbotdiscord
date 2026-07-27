import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizationFingerprint } from '../src/quest/authorization-fingerprint.js';
import {
  clearRunnerExecutionContextsForTests,
  currentRunnerExecutionContext,
  registerRunnerExecution,
  resolveRunnerJobKey,
  runWithRunnerExecutionContext,
} from '../src/quest/runner-execution-context.js';

test.beforeEach(() => clearRunnerExecutionContextsForTests());

test('runner execution registry stores only authorization fingerprint mapping', async () => {
  const token = 'secret-user-token';
  const registration = registerRunnerExecution({
    jobKey: 'scheduled:1',
    ownerId: 'owner-1',
    userToken: token,
    mode: 'scheduled',
  });

  assert.equal(resolveRunnerJobKey(authorizationFingerprint(token)), 'scheduled:1');
  assert.equal(JSON.stringify(registration.context).includes(token), false);

  const observed = await runWithRunnerExecutionContext(registration.context, async () => {
    await Promise.resolve();
    return currentRunnerExecutionContext();
  });
  assert.equal(observed.jobKey, 'scheduled:1');
  assert.equal(observed.accountKey, authorizationFingerprint(token));

  assert.equal(registration.release(), true);
  assert.equal(resolveRunnerJobKey(authorizationFingerprint(token)), null);
  assert.equal(registration.release(), false);
});

test('tokenless test contexts do not collide through the anonymous fingerprint', () => {
  const first = registerRunnerExecution({ jobKey: 'test:1', ownerId: 'owner-1' });
  const second = registerRunnerExecution({ jobKey: 'test:2', ownerId: 'owner-1' });
  assert.equal(first.context.accountKey, null);
  assert.equal(second.context.accountKey, null);
  first.release();
  second.release();
});
