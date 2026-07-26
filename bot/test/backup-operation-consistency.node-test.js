import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_PATH = ':memory:';
process.env.QUESTBOT_TEST_MODE = 'true';

const {
  closeDatabase,
  createBackupOperations,
} = await import('../src/db.js');

const PROFILE_PATHS = Object.freeze(
  ['./data/backups', '/var/data/backups'].map((root) => Object.freeze(
    Array.from({ length: 7 }, (_, index) => `${root}/questbot-slot-${index + 1}.db`),
  )),
);

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
