import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

process.env.DISCORD_BOT_TOKEN = 'test-bot-token';
process.env.DISCORD_CLIENT_ID = 'test-client';
process.env.DISCORD_GUILD_ID = 'test-guild';
process.env.OWNER_ID = 'test-owner';
process.env.DATABASE_PATH = `/tmp/questbot-runner-modes-${process.pid}.db`;
process.env.DATABASE_BACKUP_DIR = `/tmp/questbot-runner-backups-${process.pid}`;
process.env.DATABASE_BACKUP_RETENTION = '2';
process.env.RUNNER_TOKEN_SECRET = 'runner-mode-test-secret-123456';

const {
  DiscordApiError,
  getUserJobs,
  isFatalAuthError,
  restoreScheduledRunners,
  shutdownRunners,
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
const panelCommand = await import('../src/commands/panel.js');
const { backupDatabase } = await import('../src/db.js');
const { redactSensitive } = await import('../src/error-reporter.js');
const { runDatabaseBackup } = await import('../src/worker.js');

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
    member: { permissions: { has: () => true } },
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

test('401 disables a scheduled runner and removes its saved token', async () => {
  const row = createScheduledRunner({
    ownerId: 'owner-invalid-token',
    guildId: 'guild',
    channelId: 'channel-invalid',
    accountId: 'account-invalid',
    username: 'invalid-user',
    token: 'token-invalid',
    secret: process.env.RUNNER_TOKEN_SECRET,
  });
  global.fetch = async () => new Response(
    JSON.stringify({ message: '401: Unauthorized', code: 0 }),
    { status: 401, headers: { 'Content-Type': 'application/json' } },
  );

  await startRunner({
    jobKey: `scheduled:${row.id}`,
    ownerId: row.owner_id,
    userToken: 'token-invalid',
    channelId: row.channel_id,
    client: mockClient(),
    mode: 'scheduled',
    scheduleId: row.id,
    accountId: row.account_id,
    username: row.username,
  });

  await waitFor(() => getUserJobs(row.owner_id).length === 0);
  assert.equal(getScheduledRunner(row.id), null);
});

test('403 is fatal only for identity and quest-list endpoints', () => {
  assert.equal(
    isFatalAuthError(new DiscordApiError(403, '/users/@me/quests', {})),
    true,
  );
  assert.equal(
    isFatalAuthError(new DiscordApiError(403, '/quests/123/heartbeat', {})),
    false,
  );
});

test('a 401 from heartbeat is propagated and disables the scheduled runner', async () => {
  const row = createScheduledRunner({
    ownerId: 'owner-heartbeat-unauthorized',
    guildId: 'guild',
    channelId: 'channel-heartbeat-unauthorized',
    accountId: 'account-heartbeat-unauthorized',
    username: 'heartbeat-unauthorized-user',
    token: 'token-heartbeat-unauthorized',
    secret: process.env.RUNNER_TOKEN_SECRET,
  });
  global.fetch = async (url) => {
    if (String(url).endsWith('/users/@me/quests')) {
      return new Response(JSON.stringify([{
        id: 'quest-401',
        config: {
          messages: { quest_name: 'Unauthorized Quest' },
          task_config: { tasks: { PLAY_ON_DESKTOP: { target: 30 } } },
        },
        user_status: {
          enrolled_at: '2026-07-02T00:00:00Z',
          progress: { PLAY_ON_DESKTOP: { value: 0 } },
        },
      }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (String(url).includes('/heartbeat')) {
      return new Response(JSON.stringify({ message: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  await startRunner({
    jobKey: `scheduled:${row.id}`,
    ownerId: row.owner_id,
    userToken: 'token-heartbeat-unauthorized',
    channelId: row.channel_id,
    client: mockClient(),
    mode: 'scheduled',
    scheduleId: row.id,
    accountId: row.account_id,
    username: row.username,
  });

  await waitFor(() => getUserJobs(row.owner_id).length === 0);
  assert.equal(getScheduledRunner(row.id), null);
});

test('an action-specific 403 stops that attempt without deleting the scheduled runner', async () => {
  const row = createScheduledRunner({
    ownerId: 'owner-action-forbidden',
    guildId: 'guild',
    channelId: 'channel-action-forbidden',
    accountId: 'account-action-forbidden',
    username: 'action-forbidden-user',
    token: 'token-action-forbidden',
    secret: process.env.RUNNER_TOKEN_SECRET,
  });
  global.fetch = async (url) => {
    if (String(url).endsWith('/users/@me/quests')) {
      return new Response(JSON.stringify([{
        id: 'quest-403',
        config: {
          messages: { quest_name: 'Forbidden Quest' },
          task_config: { tasks: { PLAY_ON_DESKTOP: { target: 30 } } },
        },
        user_status: {
          enrolled_at: '2026-07-02T00:00:00Z',
          progress: { PLAY_ON_DESKTOP: { value: 0 } },
        },
      }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (String(url).includes('/heartbeat')) {
      return new Response(JSON.stringify({ message: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  await startRunner({
    jobKey: `scheduled:${row.id}`,
    ownerId: row.owner_id,
    userToken: 'token-action-forbidden',
    channelId: row.channel_id,
    client: mockClient(),
    mode: 'scheduled',
    scheduleId: row.id,
    accountId: row.account_id,
    username: row.username,
  });

  await waitFor(() => Boolean(getUserJobs(row.owner_id)[0]?.nextCheckAt));
  assert.ok(getScheduledRunner(row.id));
  stopScheduledJob(row.owner_id, row.id);
});

test('graceful runner shutdown preserves scheduled rows for restart recovery', async () => {
  const row = createScheduledRunner({
    ownerId: 'owner-shutdown',
    guildId: 'guild',
    channelId: 'channel-shutdown',
    accountId: 'account-shutdown',
    username: 'shutdown-user',
    token: 'token-shutdown',
    secret: process.env.RUNNER_TOKEN_SECRET,
    nextCheckAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });

  await startRunner({
    jobKey: `scheduled:${row.id}`,
    ownerId: row.owner_id,
    userToken: 'token-shutdown',
    channelId: row.channel_id,
    client: mockClient(),
    mode: 'scheduled',
    scheduleId: row.id,
    accountId: row.account_id,
    username: row.username,
    initialNextCheckAt: row.next_check_at,
  });

  await shutdownRunners();
  assert.equal(getUserJobs(row.owner_id).length, 0);
  assert.ok(getScheduledRunner(row.id));
  stopScheduledJob(row.owner_id, row.id);
});

test('critical error redaction removes token-like secrets', () => {
  const safe = redactSensitive('Authorization: abc.def.abcdefghijklmnopqrstuvwxyz token=plain-secret');
  assert.doesNotMatch(safe, /abcdefghijklmnopqrstuvwxyz|plain-secret/);
  assert.match(safe, /REDACTED/);
});

test('database backup creates a readable SQLite snapshot', async () => {
  const destination = `/tmp/questbot-backup-${process.pid}-${Date.now()}.db`;
  await backupDatabase(destination);
  const stat = await fs.stat(destination);
  assert.ok(stat.size > 0);
  await fs.unlink(destination);
});

test('scheduled database backups retain only the configured number of snapshots', async () => {
  await fs.rm(process.env.DATABASE_BACKUP_DIR, { recursive: true, force: true });
  await runDatabaseBackup(new Date('2026-07-01T03:00:00Z'));
  await runDatabaseBackup(new Date('2026-07-02T03:00:00Z'));
  await runDatabaseBackup(new Date('2026-07-03T03:00:00Z'));

  const backups = (await fs.readdir(process.env.DATABASE_BACKUP_DIR))
    .filter((name) => name.endsWith('.db'));
  assert.equal(backups.length, 2);
  await fs.rm(process.env.DATABASE_BACKUP_DIR, { recursive: true, force: true });
});

test('modal handlers recheck permissions when the modal is submitted', async () => {
  let runReply;
  await runCommand.handleModal({
    customId: 'run_modal:scheduled:channel',
    user: { id: 'owner-no-role' },
    member: { permissions: { has: () => false }, roles: { cache: { has: () => false } } },
    async reply(payload) {
      runReply = payload;
    },
  });
  assert.match(runReply.content, /สิทธิ์ของคุณเปลี่ยนไป/);

  let editReply;
  await panelCommand.handlePanelModal({
    customId: 'panel_edit_modal',
    user: { id: 'owner-no-role' },
    member: { permissions: { has: () => false }, roles: { cache: { has: () => false } } },
    async reply(payload) {
      editReply = payload;
    },
  });
  assert.match(editReply.content, /สิทธิ์ของคุณเปลี่ยนไป/);
});
