import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import { encryptRunnerToken } from '../src/runner-token-crypto.js';
import { reconcileScheduledWorker } from '../src/quest/scheduled-worker-supervisor.js';
import {
  beginRunnerState,
  clearRunnerStatesForTests,
  RUNNER_STATE,
} from '../src/quest/runner-state-store.js';

const OWNER_ID = 'scheduled-supervisor-owner';

function scheduledRow(id, accountId = `account-${id}`) {
  const encrypted = encryptRunnerToken(
    `token-${id}`,
    config.runnerTokenSecret,
    OWNER_ID,
    accountId,
  );
  return {
    id,
    owner_id: OWNER_ID,
    guild_id: 'guild-1',
    channel_id: 'channel-1',
    account_id: accountId,
    username: `runner-${id}`,
    token_ciphertext: encrypted.ciphertext,
    token_iv: encrypted.iv,
    token_tag: encrypted.tag,
    token_salt: encrypted.salt,
    next_check_at: null,
  };
}

test.beforeEach(clearRunnerStatesForTests);
test.afterEach(clearRunnerStatesForTests);

test('supervisor stops deleted rows and starts newly persisted rows', async () => {
  const rows = [scheduledRow(1)];
  const jobs = [{
    key: 'scheduled:2',
    ownerId: OWNER_ID,
    accountId: 'account-2',
    mode: 'scheduled',
    scheduleId: 2,
  }];
  const stops = [];
  const starts = [];

  const result = await reconcileScheduledWorker({}, {
    rows,
    jobs,
    stop: (ownerId, jobKey, options) => {
      stops.push({ ownerId, jobKey, options });
      return true;
    },
    startRunner: async (args) => starts.push(args),
  });

  assert.equal(result.stopRequested, 1);
  assert.deepEqual(stops, [{
    ownerId: OWNER_ID,
    jobKey: 'scheduled:2',
    options: { removeSchedule: false },
  }]);
  assert.equal(result.restore.restored, 1);
  assert.equal(starts[0].jobKey, 'scheduled:1');
  assert.equal(starts[0].userToken, 'token-1');
});

test('failed rows use a bounded retry delay before the supervisor restarts them', async () => {
  const row = scheduledRow(3);
  beginRunnerState({
    jobKey: 'scheduled:3',
    ownerId: OWNER_ID,
    accountId: row.account_id,
    mode: 'scheduled',
    scheduleId: 3,
    state: RUNNER_STATE.FAILED,
  });
  const starts = [];

  const first = await reconcileScheduledWorker({}, {
    rows: [row],
    jobs: [],
    startRunner: async (args) => starts.push(args),
    now: Date.now(),
  });
  assert.equal(first.restore.restored, 0);
  assert.equal(starts.length, 0);

  const second = await reconcileScheduledWorker({}, {
    rows: [row],
    jobs: [],
    startRunner: async (args) => starts.push(args),
    now: Date.now() + 5 * 60 * 1000 + 1000,
  });
  assert.equal(second.restore.restored, 1);
  assert.equal(starts.length, 1);
});
