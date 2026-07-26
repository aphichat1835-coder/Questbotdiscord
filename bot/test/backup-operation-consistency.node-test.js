import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeDiscordWebhookUrl } from '../test-support/fake-webhook.js';

process.env.DISCORD_BOT_TOKEN ??= 'backup-operation-test-bot-token';
process.env.DISCORD_CLIENT_ID ??= '12345678901234567';
process.env.DISCORD_GUILD_ID ??= '22345678901234567';
process.env.OWNER_ID ??= '32345678901234567';
process.env.RUNNER_TOKEN_SECRET ??= 'backup-operation-test-secret-32-characters';
process.env.LOG_WEBHOOK_URL ??= createFakeDiscordWebhookUrl('backup-operation');
process.env.DATABASE_PATH = ':memory:';
process.env.QUESTBOT_TEST_MODE = 'true';

const {
  closeDatabase,
  createBackupOperations,
} = await import('../src/db.js');

const PROFILE_PATHS = Object.freeze([
  Object.freeze([
    './data/backups/questbot-slot-1.db',
    './data/backups/questbot-slot-2.db',
    './data/backups/questbot-slot-3.db',
    './data/backups/questbot-slot-4.db',
    './data/backups/questbot-slot-5.db',
    './data/backups/questbot-slot-6.db',
    './data/backups/questbot-slot-7.db',
  ]),
  Object.freeze([
    '/var/data/backups/questbot-slot-1.db',
    '/var/data/backups/questbot-slot-2.db',
    '/var/data/backups/questbot-slot-3.db',
    '/var/data/backups/questbot-slot-4.db',
    '/var/data/backups/questbot-slot-5.db',
    '/var/data/backups/questbot-slot-6.db',
    '/var/data/backups/questbot-slot-7.db',
  ]),
]);

test.after(() => closeDatabase());

test('every backup operation derives copy, cleanup and timestamp targets from one fixed slot path', async () => {
  for (const slotPaths of PROFILE_PATHS) {
    const calls = { backup: [], remove: [], modifiedAt: [] };
    const operations = createBackupOperations(slotPaths, {
      backup: async (target) => calls.backup.push(target),
      remove: async (target) => calls.remove.push(target),
      modifiedAt: (target) => {
        calls.modifiedAt.push(target);
        return slotPaths.indexOf(target) + 1;
      },
    });

    assert.equal(Object.isFrozen(operations), true);
    assert.equal(operations.length, slotPaths.length);

    for (const [index, operation] of operations.entries()) {
      assert.equal(Object.isFrozen(operation), true);
      assert.equal(operation.path, slotPaths[index]);
      await operation.backup();
      await operation.remove();
      assert.equal(operation.modifiedAt(), index + 1);
    }

    assert.deepEqual(calls.backup, slotPaths);
    assert.deepEqual(calls.remove, slotPaths);
    assert.deepEqual(calls.modifiedAt, slotPaths);
  }
});

test('backup operation factory rejects paths outside the fixed local and persistent allowlist', () => {
  assert.throws(
    () => createBackupOperations(['/tmp/questbot-slot-1.db']),
    /Unsupported database backup slot path/,
  );
});
