import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import Database from 'better-sqlite3';
import { resolveContainedPath } from '../src/path-safety.js';
import { fetchInputUrl } from './fetch-input.js';

process.env.DISCORD_BOT_TOKEN = 'test-bot-token';
process.env.DISCORD_CLIENT_ID = 'test-client';
process.env.DISCORD_GUILD_ID = 'test-guild';
process.env.OWNER_ID = 'test-owner';
process.env.DATABASE_PATH = `/tmp/questbot-final-hardening-${process.pid}.db`;
process.env.RUNNER_TOKEN_SECRET = 'final-hardening-test-secret-123456';

const runCommand = await import('../src/commands/run.js');
const stopCommand = await import('../src/commands/stop.js');
const {
  getUserJobs,
  shutdownRunners,
  startRunner,
} = await import('../src/discord-runner.js');
const {
  isAccountStopping,
  stopRunnerAndWaitDetailed,
} = await import('../src/runner-control.js');
const {
  createScheduledRunner,
  deleteAllScheduledRunners,
} = await import('../src/scheduled-runner-store.js');
const { closeDatabase } = await import('../src/db.js');

function mockClient() {
  const message = { async edit() { return message; } };
  return {
    channels: {
      async fetch() {
        return {
          isTextBased: () => true,
          async send() { return message; },
        };
      },
    },
  };
}

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

test.after(async () => {
  await shutdownRunners();
  deleteAllScheduledRunners('test-owner');
  closeDatabase();
  await Promise.all([
    fs.rm(process.env.DATABASE_PATH, { force: true }),
    fs.rm(`${process.env.DATABASE_PATH}-wal`, { force: true }),
    fs.rm(`${process.env.DATABASE_PATH}-shm`, { force: true }),
  ]);
});

test('run keeps inspecting tokens until a real slot is filled', async () => {
  deleteAllScheduledRunners('test-owner');
  for (let index = 0; index < 9; index++) {
    createScheduledRunner({
      ownerId: 'test-owner',
      guildId: 'test-guild',
      channelId: 'test-channel',
      accountId: `occupied-${index}`,
      username: `occupied-${index}`,
      token: `occupied-token-${index}`,
      secret: process.env.RUNNER_TOKEN_SECRET,
    });
  }

  const accountByToken = new Map([
    ['valid-token', { id: 'valid-account', username: 'valid-user' }],
  ]);
  globalThis.fetch = async (url, options = {}) => {
    const endpoint = fetchInputUrl(url);
    const account = accountByToken.get(options.headers?.Authorization);
    if (endpoint.endsWith('/users/@me')) {
      if (!account) {
        return new Response(JSON.stringify({ message: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(account), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (endpoint.endsWith('/quests/@me') || endpoint.endsWith('/users/@me/quests')) {
      return new Response(JSON.stringify({ quests: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${endpoint}`);
  };

  let reply = '';
  await runCommand.handleModal({
    customId: 'run_modal:oneshot:test-channel',
    channelId: 'test-channel',
    guildId: 'test-guild',
    user: { id: 'test-owner' },
    member: { permissions: { has: () => false }, roles: { cache: { has: () => false } } },
    client: mockClient(),
    fields: { getTextInputValue: () => 'invalid-token\nvalid-token' },
    async deferReply() {},
    async editReply(content) { reply = content; return content; },
  });

  assert.match(reply, /ไม่ถูกต้องหรือไม่มีสิทธิ์/);
  assert.match(reply, /เริ่ม Quest auto : \*\*valid-user\*\*/);
  assert.doesNotMatch(reply, /ข้าม .*ช่อง Runner เต็ม/);
  await waitFor(() => getUserJobs('test-owner', { mode: 'oneshot' }).length === 0);
  deleteAllScheduledRunners('test-owner');
});

test('stop timeout reports pending cleanup and keeps the account blocked', async () => {
  let heartbeatStarted = false;
  let releaseHeartbeat;
  globalThis.fetch = async (url) => {
    const endpoint = fetchInputUrl(url);
    if (endpoint.endsWith('/quests/@me') || endpoint.endsWith('/users/@me/quests')) {
      return new Response(JSON.stringify({ quests: [{
        id: 'slow-stop-quest',
        config: {
          application: { id: 'slow-stop-app' },
          messages: { quest_name: 'Slow Stop Quest' },
          task_config: { tasks: { PLAY_ON_DESKTOP: { target: 60 } } },
        },
        user_status: {
          enrolled_at: '2026-07-01T00:00:00Z',
          progress: { PLAY_ON_DESKTOP: { value: 0 } },
        },
      }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (endpoint.includes('/heartbeat')) {
      heartbeatStarted = true;
      return new Promise((resolve) => { releaseHeartbeat = resolve; });
    }
    throw new Error(`Unexpected fetch: ${endpoint}`);
  };

  await startRunner({
    jobKey: 'test-owner:oneshot:slow-stop',
    ownerId: 'test-owner',
    userToken: 'slow-stop-token',
    channelId: 'test-channel',
    client: mockClient(),
    mode: 'oneshot',
    accountId: 'slow-stop-account',
    username: 'slow-stop-user',
  });
  await waitFor(() => heartbeatStarted);

  const result = await stopRunnerAndWaitDetailed('test-owner', {
    mode: 'oneshot',
    timeoutMs: 20,
  });
  assert.deepEqual(result, { accepted: 1, completed: 0, pending: 1 });
  assert.equal(isAccountStopping('test-owner', 'slow-stop-account'), true);

  releaseHeartbeat(new Response(JSON.stringify({}), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  await waitFor(() => !isAccountStopping('test-owner', 'slow-stop-account'));
});

test('unknown stop controls receive a safe reply', async () => {
  let reply;
  await stopCommand.handleButton({
    customId: 'runner-stop:retired-control',
    user: { id: 'test-owner' },
    replied: false,
    deferred: false,
    async reply(payload) { reply = payload; return payload; },
  });
  assert.match(reply.content, /หมดอายุหรือไม่รองรับ/);
  assert.equal(reply.flags, 64);
});

test('legacy database migration preserves scheduled runners and creates a readable backup', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'questbot-migration-'));
  const databasePath = path.join(tempDir, 'legacy.db');
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE quests (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE guild_settings (guild_id TEXT PRIMARY KEY);
    CREATE TABLE quest_logs (id INTEGER PRIMARY KEY, action TEXT NOT NULL);
    CREATE TABLE scheduled_runners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id TEXT NOT NULL,
      guild_id TEXT,
      channel_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      username TEXT NOT NULL,
      token_ciphertext TEXT NOT NULL,
      token_iv TEXT NOT NULL,
      token_tag TEXT NOT NULL,
      token_salt TEXT NOT NULL,
      next_check_at TEXT,
      last_check_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(owner_id, account_id)
    );
    INSERT INTO quests (id, name) VALUES (1, 'legacy quest');
    INSERT INTO guild_settings (guild_id) VALUES ('legacy guild');
    INSERT INTO quest_logs (id, action) VALUES (1, 'legacy action');
    INSERT INTO scheduled_runners (
      owner_id, channel_id, account_id, username,
      token_ciphertext, token_iv, token_tag, token_salt
    ) VALUES ('owner', 'channel', 'account', 'user', 'cipher', 'iv', 'tag', 'salt');
  `);
  legacy.close();

  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', "const db = await import('./src/db.js'); db.closeDatabase();"],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_PATH: databasePath },
      encoding: 'utf8',
    },
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);

  const migrated = new Database(databasePath, { readonly: true });
  const tables = new Set(
    migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map((row) => row.name),
  );
  assert.equal(tables.has('quests'), false);
  assert.equal(tables.has('guild_settings'), false);
  assert.equal(tables.has('quest_logs'), false);
  assert.equal(tables.has('scheduled_runners'), true);
  assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM scheduled_runners').get().count, 1);
  migrated.close();

  const backups = (await fs.readdir(tempDir))
    .filter((name) => name.includes('.pre-tracker-removal-') && name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  const backupPath = resolveContainedPath(tempDir, backups[0]);
  const backup = new Database(backupPath, { readonly: true });
  assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM quests').get().count, 1);
  assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM scheduled_runners').get().count, 1);
  backup.close();
  await fs.rm(tempDir, { recursive: true, force: true });
});
