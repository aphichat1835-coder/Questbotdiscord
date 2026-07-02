import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DISCORD_BOT_TOKEN = 'test-bot-token';
process.env.DISCORD_CLIENT_ID = 'test-client';
process.env.DISCORD_GUILD_ID = 'test-guild';
process.env.OWNER_ID = 'test-owner';
process.env.DATABASE_PATH = `/tmp/questbot-runner-modes-${process.pid}.db`;
process.env.RUNNER_TOKEN_SECRET = 'runner-mode-test-secret-123456';

const {
  getUserJobs,
  restoreScheduledRunners,
  startRunner,
  stopScheduledJob,
} = await import('../src/discord-runner.js');
const {
  createScheduledRunner,
  getScheduledRunner,
  listScheduledRunners,
} = await import('../src/scheduled-runner-store.js');
const runCommand = await import('../src/commands/run.js');
const stopCommand = await import('../src/commands/stop.js');

function mockClient() {
  const message = {
    async edit() {
      return message;
    },
  };
  return {
    channels: {
      async fetch() {
        return {
          isTextBased: () => true,
          async send() {
            return message;
          },
        };
      },
    },
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for runner state');
}

test.beforeEach(() => {
  global.fetch = async (url) => {
    if (String(url).endsWith('/users/@me/quests')) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
});

test('one-shot runner exits after the first empty quest scan', async () => {
  await startRunner({
    jobKey: 'oneshot:test',
    ownerId: 'owner-one',
    userToken: 'token-one',
    channelId: 'channel-one',
    client: mockClient(),
    mode: 'oneshot',
    accountId: 'account-one',
    username: 'one-shot-user',
  });

  await waitFor(() => getUserJobs('owner-one').length === 0);
});

test('scheduled runner stays active after an empty scan until explicitly stopped', async () => {
  const row = createScheduledRunner({
    ownerId: 'owner-scheduled',
    guildId: 'guild',
    channelId: 'channel-scheduled',
    accountId: 'account-scheduled',
    username: 'scheduled-user',
    token: 'token-scheduled',
    secret: process.env.RUNNER_TOKEN_SECRET,
  });

  await startRunner({
    jobKey: `scheduled:${row.id}`,
    ownerId: row.owner_id,
    userToken: 'token-scheduled',
    channelId: row.channel_id,
    client: mockClient(),
    mode: 'scheduled',
    scheduleId: row.id,
    accountId: row.account_id,
    username: row.username,
  });

  await waitFor(() => Boolean(getUserJobs('owner-scheduled')[0]?.nextCheckAt));
  assert.equal(getUserJobs('owner-scheduled').length, 1);
  assert.ok(getScheduledRunner(row.id)?.next_check_at);

  assert.equal(stopScheduledJob('owner-scheduled', row.id), true);
  assert.equal(getUserJobs('owner-scheduled').length, 0);
  assert.equal(getScheduledRunner(row.id), null);
});

test('saved scheduled runners are restored with their persisted next check', async () => {
  const nextCheckAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const row = createScheduledRunner({
    ownerId: 'owner-restored',
    guildId: 'guild',
    channelId: 'channel-restored',
    accountId: 'account-restored',
    username: 'restored-user',
    token: 'token-restored',
    secret: process.env.RUNNER_TOKEN_SECRET,
    nextCheckAt,
  });

  const result = await restoreScheduledRunners(mockClient());
  assert.equal(result.failed, 0);
  assert.equal(result.restored, 1);
  assert.equal(getUserJobs('owner-restored')[0]?.nextCheckAt, nextCheckAt);

  stopScheduledJob('owner-restored', row.id);
});

test('/run replies publicly and starts a persisted scheduled runner', async () => {
  let deferOptions = null;
  let replyContent = null;
  global.fetch = async (url) => {
    if (String(url).endsWith('/users/@me')) {
      return new Response(JSON.stringify({ id: 'account-command', username: 'command-user' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (String(url).endsWith('/users/@me/quests')) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  await runCommand.handleModal({
    customId: 'run_modal:scheduled:channel-command',
    fields: { getTextInputValue: () => 'token-command' },
    user: { id: 'owner-command' },
    guildId: 'guild',
    client: mockClient(),
    async deferReply(options) {
      deferOptions = options;
    },
    async editReply(content) {
      replyContent = content;
    },
  });

  assert.deepEqual(deferOptions, {});
  assert.match(replyContent, /AUTO DAILY QUEST/);
  await waitFor(() => Boolean(getUserJobs('owner-command')[0]?.nextCheckAt));

  const [row] = listScheduledRunners('owner-command');
  assert.ok(row);
  stopScheduledJob('owner-command', row.id);
});

test('/stop is ephemeral and selected rows are removed', async () => {
  const row = createScheduledRunner({
    ownerId: 'owner-stop-command',
    guildId: 'guild',
    channelId: 'channel-stop',
    accountId: 'account-stop',
    username: 'stop-user',
    token: 'token-stop',
    secret: process.env.RUNNER_TOKEN_SECRET,
  });
  let replyPayload = null;
  await stopCommand.execute({
    user: { id: 'owner-stop-command' },
    async reply(payload) {
      replyPayload = payload;
    },
  });

  assert.equal(replyPayload.flags, 64);
  assert.equal(replyPayload.components[0].components[0].data.custom_id, 'runner-stop:select');

  await stopCommand.handleSelect({
    user: { id: 'owner-stop-command' },
    values: [String(row.id)],
    async update() {},
  });
  assert.equal(getScheduledRunner(row.id), null);
});
