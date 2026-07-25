import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createFakeDiscordWebhookUrl } from '../test-support/fake-webhook.js';

process.env.DISCORD_BOT_TOKEN ??= 'backup-test-bot-token';
process.env.DISCORD_CLIENT_ID ??= '12345678901234567';
process.env.DISCORD_GUILD_ID ??= '22345678901234567';
process.env.OWNER_ID ??= '32345678901234567';
process.env.RUNNER_TOKEN_SECRET ??= 'backup-test-runner-secret-32-characters';
process.env.LOG_WEBHOOK_URL ??= createFakeDiscordWebhookUrl('backup');
process.env.DATABASE_PATH = ':memory:';
process.env.QUESTBOT_TEST_MODE = 'true';

const {
  closeDatabase,
  DATABASE_BACKUP_SLOT_COUNT,
  resolveDatabaseBackupDirectory,
  resolveDatabaseBackupSlotPath,
} = await import('../src/db.js');

const EXPECTED_LOCAL_BACKUP_PATHS = Object.freeze([
  './data/backups/questbot-slot-1.db',
  './data/backups/questbot-slot-2.db',
  './data/backups/questbot-slot-3.db',
  './data/backups/questbot-slot-4.db',
  './data/backups/questbot-slot-5.db',
  './data/backups/questbot-slot-6.db',
  './data/backups/questbot-slot-7.db',
]);
const EXPECTED_PERSISTENT_BACKUP_PATHS = Object.freeze([
  '/var/data/backups/questbot-slot-1.db',
  '/var/data/backups/questbot-slot-2.db',
  '/var/data/backups/questbot-slot-3.db',
  '/var/data/backups/questbot-slot-4.db',
  '/var/data/backups/questbot-slot-5.db',
  '/var/data/backups/questbot-slot-6.db',
  '/var/data/backups/questbot-slot-7.db',
]);

test.before(async () => {
  await fs.rm('./test/.backup-path-workspace', { recursive: true, force: true });
  await fs.mkdir('./test/.backup-path-workspace', { recursive: true, mode: 0o700 });
  await fs.chmod('./test/.backup-path-workspace', 0o700);
  const workspace = await fs.stat('./test/.backup-path-workspace');
  assert.equal(workspace.mode & 0o777, 0o700);
});

test.after(async () => {
  closeDatabase();
  await fs.rm('./test/.backup-path-workspace', { recursive: true, force: true });
});

test('backup destination resolver permits only the fixed local and persistent roots', () => {
  assert.equal(resolveDatabaseBackupDirectory('./data/questbot.db'), './data/backups');
  assert.equal(resolveDatabaseBackupDirectory('/var/data/questbot.db'), '/var/data/backups');
  assert.equal(resolveDatabaseBackupDirectory('/var/database/questbot.db'), './data/backups');

  for (let slot = 0; slot < DATABASE_BACKUP_SLOT_COUNT; slot++) {
    assert.equal(
      resolveDatabaseBackupSlotPath('./data/questbot.db', slot),
      EXPECTED_LOCAL_BACKUP_PATHS[slot],
    );
    assert.equal(
      resolveDatabaseBackupSlotPath('/var/data/questbot.db', slot),
      EXPECTED_PERSISTENT_BACKUP_PATHS[slot],
    );
  }

  for (const invalid of [-1, DATABASE_BACKUP_SLOT_COUNT, 1.5, '1']) {
    assert.throws(
      () => resolveDatabaseBackupSlotPath('./data/questbot.db', invalid),
      /slot is out of range/,
    );
  }
});

test('backupDatabaseSlot writes and clears a backup beneath the resolved local root', async () => {
  const script = `
    const db = await import('../../src/db.js');
    const destination = await db.backupDatabaseSlot(0);
    const fs = await import('node:fs');
    const existed = fs.existsSync('./data/backups/questbot-slot-1.db');
    await db.clearAllDatabaseBackupSlots();
    const removed = !fs.existsSync('./data/backups/questbot-slot-1.db');
    db.closeDatabase();
    console.log(JSON.stringify({ destination, existed, removed }));
  `;

  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: './test/.backup-path-workspace',
      env: {
        ...process.env,
        DATABASE_PATH: './runtime.db',
        DATABASE_BACKUP_ENABLED: 'true',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(
      child.status,
      0,
      child.error?.message || child.stderr || child.stdout,
    );
    const output = JSON.parse(child.stdout.trim().split('\n').at(-1));
    assert.equal(output.destination, './data/backups/questbot-slot-1.db');
    assert.equal(output.existed, true);
    assert.equal(output.removed, true);
  } finally {
    await fs.rm('./test/.backup-path-workspace', { recursive: true, force: true });
  }
});
