import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

process.env.DATABASE_PATH = './test/.tmp/backup-health.db';
process.env.DATABASE_BACKUP_ENABLED = 'true';

const {
  BACKUP_FAILURE_THRESHOLD,
  BACKUP_MAX_AGE_MS,
  getBackupHealthStatus,
  resetBackupHealthForTests,
  runBackupAttempt,
} = await import('../src/worker.js');
const { closeDatabase } = await import('../src/db.js');

const databaseFiles = [
  './test/.tmp/backup-health.db',
  './test/.tmp/backup-health.db-wal',
  './test/.tmp/backup-health.db-shm',
];

test.after(async () => {
  closeDatabase();
  await Promise.all(databaseFiles.map((file) => fs.rm(file, { force: true })));
});

test.afterEach(() => resetBackupHealthForTests());

function reportingSpies() {
  const errors = [];
  const incidents = [];
  const recoveries = [];
  return {
    errors,
    incidents,
    recoveries,
    reportErrorFn: (...args) => errors.push(args),
    reportIncidentFn: async (incident) => {
      incidents.push(incident);
      return { state: 'delivered', incidentId: 'NQB-TEST' };
    },
    reportRecoveryFn: async (recovery) => {
      recoveries.push(recovery);
      return { state: 'delivered', incidentId: 'NQB-TEST' };
    },
  };
}

test('one or two backup failures stay in Render logs without an emergency', async () => {
  const spies = reportingSpies();
  const backupFn = async () => { throw new Error('disk temporarily busy'); };

  const first = await runBackupAttempt({ backupFn, ...spies });
  const second = await runBackupAttempt({ backupFn, ...spies });

  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.equal(spies.errors.length, 2);
  assert.equal(spies.incidents.length, 0);
  const status = getBackupHealthStatus();
  assert.equal(status.state, 'degraded');
  assert.equal(status.consecutiveFailures, 2);
});

test('the third consecutive failure escalates backup protection loss', async () => {
  const spies = reportingSpies();
  const backupFn = async () => { throw new Error('persistent backup failure'); };

  for (let attempt = 0; attempt < BACKUP_FAILURE_THRESHOLD; attempt++) {
    await runBackupAttempt({ backupFn, ...spies });
  }

  assert.equal(spies.incidents.length, 1);
  assert.equal(spies.incidents[0].code, 'BACKUP_PROTECTION_LOST');
  assert.equal(spies.incidents[0].context.consecutiveFailures, BACKUP_FAILURE_THRESHOLD);
  assert.equal(getBackupHealthStatus().consecutiveFailures, BACKUP_FAILURE_THRESHOLD);
});

test('an overdue backup escalates even on the first new failure', async () => {
  const now = new Date('2026-07-25T12:00:00.000Z');
  resetBackupHealthForTests({
    state: 'healthy',
    lastSuccessAt: new Date(now.getTime() - BACKUP_MAX_AGE_MS - 60_000).toISOString(),
  });
  const spies = reportingSpies();

  await runBackupAttempt({
    now,
    backupFn: async () => { throw new Error('backup overdue and failed'); },
    ...spies,
  });

  assert.equal(spies.incidents.length, 1);
  assert.ok(spies.incidents[0].context.backupAgeHours >= 26);
});

test('a successful attempt after failures clears health and sends recovery', async () => {
  resetBackupHealthForTests({
    state: 'degraded',
    consecutiveFailures: 3,
    lastError: 'previous failure',
  });
  const spies = reportingSpies();
  const now = new Date('2026-07-25T12:00:00.000Z');

  const result = await runBackupAttempt({
    now,
    backupFn: async () => './data/backups/questbot-slot-1.db',
    ...spies,
  });

  assert.equal(result.ok, true);
  assert.equal(spies.recoveries.length, 1);
  const status = getBackupHealthStatus(now);
  assert.equal(status.state, 'healthy');
  assert.equal(status.consecutiveFailures, 0);
  assert.equal(status.lastError, null);
  assert.equal(status.lastSuccessAt, now.toISOString());
});

test('backup status exposes operational evidence without a database path', () => {
  const status = getBackupHealthStatus(new Date());
  assert.equal(status.enabled, true);
  assert.equal(status.threshold, 3);
  assert.equal(status.maxAgeHours, 26);
  assert.equal(Object.hasOwn(status, 'databasePath'), false);
  assert.equal(Object.hasOwn(status, 'backupDirectory'), false);
});
