import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

process.env.DATABASE_PATH = ':memory:';
const {
  closeDatabase,
  DATABASE_BACKUP_SLOT_COUNT,
  resolveDatabaseBackupDirectory,
  resolveDatabaseBackupSlotPath,
} = await import('../src/db.js');

test.after(() => closeDatabase());

test('backup destination resolver permits only the fixed local and persistent roots', () => {
  assert.equal(resolveDatabaseBackupDirectory('/tmp/questbot.db'), './data/backups');
  assert.equal(resolveDatabaseBackupDirectory('./data/questbot.db'), './data/backups');
  assert.equal(resolveDatabaseBackupDirectory('/var/data/questbot.db'), '/var/data/backups');
  assert.equal(resolveDatabaseBackupDirectory('/var/database/questbot.db'), './data/backups');

  for (let slot = 0; slot < DATABASE_BACKUP_SLOT_COUNT; slot++) {
    assert.equal(
      resolveDatabaseBackupSlotPath('/tmp/questbot.db', slot),
      `./data/backups/questbot-slot-${slot + 1}.db`,
    );
    assert.equal(
      resolveDatabaseBackupSlotPath('/var/data/questbot.db', slot),
      `/var/data/backups/questbot-slot-${slot + 1}.db`,
    );
  }
  for (const invalid of [-1, DATABASE_BACKUP_SLOT_COUNT, 1.5, '1']) {
    assert.throws(
      () => resolveDatabaseBackupSlotPath('/tmp/questbot.db', invalid),
      /slot is out of range/,
    );
  }
});

test('backupDatabaseSlot writes and clears a backup beneath the resolved local root', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'questbot-backup-path-'));
  const moduleUrl = pathToFileURL(path.resolve('src/db.js')).href;
  const databasePath = path.join(tempRoot, 'runtime.db');
  const script = `
    const db = await import(${JSON.stringify(moduleUrl)});
    const destination = await db.backupDatabaseSlot(0);
    const fs = await import('node:fs');
    const path = await import('node:path');
    const absolute = path.resolve(destination);
    const existed = fs.existsSync(absolute);
    await db.clearAllDatabaseBackupSlots();
    const removed = !fs.existsSync(absolute);
    db.closeDatabase();
    console.log(JSON.stringify({ destination, absolute, existed, removed }));
  `;

  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: tempRoot,
      env: { ...process.env, DATABASE_PATH: databasePath },
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const output = JSON.parse(child.stdout.trim().split('\n').at(-1));
    assert.equal(output.destination, './data/backups/questbot-slot-1.db');
    assert.equal(output.absolute.startsWith(tempRoot), true);
    assert.equal(output.existed, true);
    assert.equal(output.removed, true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
