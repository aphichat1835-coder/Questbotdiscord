import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

process.env.DATABASE_PATH = ':memory:';
const {
  closeDatabase,
  DATABASE_BACKUP_SLOT_COUNT,
  resolveDatabaseBackupDirectory,
  resolveDatabaseBackupSlotPath,
} = await import('../src/db.js');

const databaseModuleUrl = new URL('../src/db.js', import.meta.url).href;
const TEST_WORKSPACE_ROOT = new URL('./.backup-path-workspaces/', import.meta.url);
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
  await fs.mkdir(TEST_WORKSPACE_ROOT, { recursive: true, mode: 0o700 });
  await fs.chmod(TEST_WORKSPACE_ROOT, 0o700);
});

test.after(async () => {
  closeDatabase();
  await fs.rm(TEST_WORKSPACE_ROOT, { recursive: true, force: true });
});

test('backup destination resolver permits only the fixed local and persistent roots', async () => {
  assert.equal(resolveDatabaseBackupDirectory('/tmp/questbot.db'), './data/backups');
  assert.equal(resolveDatabaseBackupDirectory('./data/questbot.db'), './data/backups');
  assert.equal(resolveDatabaseBackupDirectory('/var/data/questbot.db'), '/var/data/backups');
  assert.equal(resolveDatabaseBackupDirectory('/var/database/questbot.db'), './data/backups');

  for (let slot = 0; slot < DATABASE_BACKUP_SLOT_COUNT; slot++) {
    assert.equal(
      resolveDatabaseBackupSlotPath('/tmp/questbot.db', slot),
      EXPECTED_LOCAL_BACKUP_PATHS[slot],
    );
    assert.equal(
      resolveDatabaseBackupSlotPath('/var/data/questbot.db', slot),
      EXPECTED_PERSISTENT_BACKUP_PATHS[slot],
    );
  }
  const databaseSource = await fs.readFile(new URL('../src/db.js', import.meta.url), 'utf8');
  assert.doesNotMatch(databaseSource, /questbot-slot-\$\{/);

  for (const invalid of [-1, DATABASE_BACKUP_SLOT_COUNT, 1.5, '1']) {
    assert.throws(
      () => resolveDatabaseBackupSlotPath('/tmp/questbot.db', invalid),
      /slot is out of range/,
    );
  }
});

test('backupDatabaseSlot writes and clears a backup beneath the resolved local root', async () => {
  const tempRoot = await fs.mkdtemp(new URL('case-', TEST_WORKSPACE_ROOT));
  await fs.chmod(tempRoot, 0o700);
  const databasePath = path.join(tempRoot, 'runtime.db');
  const script = `
    const db = await import(${JSON.stringify(databaseModuleUrl)});
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
      timeout: 10_000,
    });
    assert.equal(
      child.status,
      0,
      child.error?.message || child.stderr || child.stdout,
    );
    const output = JSON.parse(child.stdout.trim().split('\n').at(-1));
    assert.equal(output.destination, './data/backups/questbot-slot-1.db');
    assert.equal(output.absolute.startsWith(tempRoot), true);
    assert.equal(output.existed, true);
    assert.equal(output.removed, true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
