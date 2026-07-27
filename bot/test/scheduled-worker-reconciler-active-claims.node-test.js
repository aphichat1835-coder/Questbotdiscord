import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileScheduledWorker } from '../src/quest/scheduled-worker-reconciler.js';

function row(id) {
  return {
    id,
    owner_id: `active-owner-${id}`,
    account_id: `active-account-${id}`,
  };
}

function job(id) {
  return {
    key: `scheduled:${id}`,
    ownerId: `active-owner-${id}`,
    accountId: `active-account-${id}`,
    mode: 'scheduled',
    scheduleId: id,
  };
}

test('worker stops its local job immediately after losing the ownership claim', async () => {
  const stops = [];
  const result = await reconcileScheduledWorker({}, {
    rows: [row(9501)],
    jobs: [job(9501)],
    holder: 'active-worker-lost',
    now: Date.parse('2030-01-01T00:00:00.000Z'),
    renewClaim: () => false,
    acquireClaim: () => false,
    releaseClaim: () => false,
    stop: (ownerId, jobKey, options) => {
      stops.push({ ownerId, jobKey, options });
      return true;
    },
    startRunner: async () => assert.fail('claim-lost job must not restart locally'),
  });

  assert.equal(result.claimLost, 1);
  assert.equal(result.stopRequested, 1);
  assert.equal(result.claimsRenewed, 0);
  assert.deepEqual(stops, [{
    ownerId: 'active-owner-9501',
    jobKey: 'scheduled:9501',
    options: { removeSchedule: false },
  }]);
});

test('worker renews the claim for its active job without restarting it', async () => {
  let renewals = 0;
  const result = await reconcileScheduledWorker({}, {
    rows: [row(9502)],
    jobs: [job(9502)],
    holder: 'active-worker-owner',
    now: Date.parse('2030-01-01T00:00:00.000Z'),
    renewClaim: () => {
      renewals++;
      return true;
    },
    acquireClaim: () => assert.fail('owned claim should renew before acquire'),
    releaseClaim: () => false,
    stop: () => assert.fail('owned job must not stop'),
    startRunner: async () => assert.fail('owned active job must not restart'),
  });

  assert.equal(renewals, 1);
  assert.equal(result.claimsRenewed, 1);
  assert.equal(result.claimLost, 0);
  assert.equal(result.stopRequested, 0);
  assert.equal(result.restore.restored, 0);
});
