import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function occurrenceCount(source, value) {
  return source.split(value).length - 1;
}

test('every fixed backup slot literal is shared by path, backup, remove and stat operations', async () => {
  const source = await readFile(new URL('../src/db.js', import.meta.url), 'utf8');

  for (const root of ['./data/backups', '/var/data/backups']) {
    for (let slot = 1; slot <= 7; slot++) {
      const target = `${root}/questbot-slot-${slot}.db`;
      assert.equal(
        occurrenceCount(source, target),
        4,
        `${target} must appear once in the fixed slot list and once in each file operation`,
      );
    }

    const migrationTarget = `${root}/pre-tracker-removal.db`;
    assert.equal(
      occurrenceCount(source, migrationTarget),
      3,
      `${migrationTarget} must stay aligned across its constant, remove and backup operations`,
    );
  }

  assert.match(source, /validateBackupProfile\(LOCAL_BACKUP_PROFILE\)/);
  assert.match(source, /validateBackupProfile\(PERSISTENT_BACKUP_PROFILE\)/);
});
