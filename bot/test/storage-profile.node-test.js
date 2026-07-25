import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isPersistentDatabasePath,
  resolveStorageProfile,
} from '../src/storage-profile.js';

function fsMock({ persistent = false, writable = true } = {}) {
  return {
    statSync(target) {
      if (!persistent || target !== '/var/data') throw new Error('missing');
      return { isDirectory: () => true };
    },
    accessSync(target) {
      if (!persistent || !writable || target !== '/var/data') throw new Error('not writable');
    },
  };
}

test('local development defaults to a local file and local backups', () => {
  const env = {};
  const profile = resolveStorageProfile({ env, fsApi: fsMock() });

  assert.equal(profile.mode, 'local-development');
  assert.equal(profile.databasePath, './data/quests.db');
  assert.equal(profile.databasePathType, 'local');
  assert.equal(profile.backupDirectory, './data/backups');
  assert.equal(profile.backupEnabled, true);
  assert.equal(profile.durability, 'local');
  assert.equal(profile.durabilityVerified, false);
  assert.equal(env.DATABASE_PATH, undefined);
});

test('hosted services without a mount report ephemeral storage honestly', () => {
  const profile = resolveStorageProfile({
    env: { RENDER_SERVICE_ID: 'srv-test' },
    fsApi: fsMock(),
  });

  assert.equal(profile.mode, 'hosted-ephemeral');
  assert.equal(profile.databasePath, './data/quests.db');
  assert.equal(profile.durability, 'not-persistent');
  assert.match(profile.warning, /may disappear after redeploy/i);
});

test('a writable persistent root is a candidate until restart proof exists', () => {
  const profile = resolveStorageProfile({ env: {}, fsApi: fsMock({ persistent: true }) });

  assert.equal(profile.mode, 'persistent-candidate');
  assert.equal(profile.databasePath, '/var/data/quests.db');
  assert.equal(profile.databasePathType, 'persistent');
  assert.equal(profile.backupDirectory, '/var/data/backups');
  assert.equal(profile.backupEnabled, true);
  assert.equal(profile.durability, 'candidate');
  assert.equal(profile.durabilityVerified, false);
  assert.match(profile.warning, /controlled restart test/i);
});

test('memory mode disables backup regardless of hosting', () => {
  const profile = resolveStorageProfile({
    env: { RENDER: 'true', DATABASE_PATH: ':memory:' },
    fsApi: fsMock({ persistent: true }),
  });

  assert.equal(profile.mode, 'memory');
  assert.equal(profile.databasePathType, 'memory');
  assert.equal(profile.backupDirectory, null);
  assert.equal(profile.backupEnabled, false);
  assert.equal(profile.durability, 'none');
});

test('an explicit local path on hosting remains classified as ephemeral', () => {
  const profile = resolveStorageProfile({
    env: { RENDER: 'true', DATABASE_PATH: './custom/runtime.db' },
    fsApi: fsMock({ persistent: true }),
  });

  assert.equal(profile.mode, 'hosted-ephemeral');
  assert.equal(profile.databasePath, './custom/runtime.db');
  assert.equal(profile.backupDirectory, './data/backups');
});

test('persistent database path detection is path-aware', () => {
  assert.equal(isPersistentDatabasePath('/var/data/quests.db'), true);
  assert.equal(isPersistentDatabasePath('/var/data/nested/quests.db'), true);
  assert.equal(isPersistentDatabasePath('./var/data/quests.db'), false);
  assert.equal(isPersistentDatabasePath(':memory:'), false);
});
