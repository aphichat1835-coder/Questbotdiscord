import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

process.env.DATABASE_PATH = './test/.tmp/backup-health.db';
process.env.DATABASE_BACKUP_ENABLED = 'true';

const {
  BACKUP_FAILURE_THRESHOLD,
  BACKUP_FAST_RETRY_LIMIT,
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

function reportingSpies({
  incidentResults = [{ state: 'delivered', incidentId: 'NQB-TEST' }],
  recoveryResults = [{ state: 'delivered', incidentId: 'NQB-TEST' }],
} = {}) {
  const errors = [];
  const incidents = [];
  const recoveries = [];
  let incidentIndex = 0;
  let recoveryIndex = 0;
  return {
    errors,
    incidents,
    recoveries,
    reportErrorFn: (...args) => errors.push(args),
    reportIncidentFn: async (incident) => {
      incidents.push(incident);
      const result = incidentResults[Math.min(incidentIndex, incidentResults.length - 1)];
      incidentIndex++;
      return result;
    },
    reportRecoveryFn: async (recovery) => {
      recoveries.push(recovery);
      const result = recoveryResults[Math.min(recoveryIndex, recoveryResults.length - 1)];
      recoveryIndex++;
      return result;
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
  assert.equal(status.incidentOpen, false);
});

test('the third consecutive failure opens one backup protection incident', async () => {
  const spies = reportingSpies();
  const backupFn = async () => { throw new Error('persistent backup failure'); };

  for (let attempt = 0; attempt < BACKUP_FAILURE_THRESHOLD + 4; attempt++) {
    await runBackupAttempt({ backupFn, ...spies });
  }

  assert.equal(spies.incidents.length, 1);
  assert.equal(spies.incidents[0].code, 'BACKUP_PROTECTION_LOST');
  assert.equal(spies.incidents[0].context.consecutiveFailures, BACKUP_FAILURE_THRESHOLD);
  const status = getBackupHealthStatus();
  assert.equal(status.consecutiveFailures, BACKUP_FAILURE_THRESHOLD + 4);
  assert.equal(status.incidentOpen, true);
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
  assert.equal(getBackupHealthStatus(now).incidentOpen, true);
});

test('ordinary pre-threshold failures recover silently after a successful backup', async () => {
  resetBackupHealthForTests({
    state: 'degraded',
    consecutiveFailures: 2,
    lastError: 'temporary failure',
  });
  const spies = reportingSpies();
  const now = new Date('2026-07-25T12:00:00.000Z');

  const result = await runBackupAttempt({
    now,
    backupFn: async () => './data/backups/questbot-slot-1.db',
    ...spies,
  });

  assert.equal(result.ok, true);
  assert.equal(spies.recoveries.length, 0);
  assert.equal(getBackupHealthStatus(now).state, 'healthy');
});

test('a successful attempt after an opened incident clears health and sends recovery', async () => {
  resetBackupHealthForTests({
    state: 'degraded',
    consecutiveFailures: 3,
    incidentOpen: true,
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
  assert.equal(status.incidentOpen, false);
  assert.equal(status.recoveryPending, false);
  assert.equal(status.lastError, null);
  assert.equal(status.lastSuccessAt, now.toISOString());
});

test('a failed recovery is retried on the next successful backup', async () => {
  resetBackupHealthForTests({
    state: 'degraded',
    consecutiveFailures: 3,
    incidentOpen: true,
  });
  const spies = reportingSpies({
    recoveryResults: [
      { state: 'delivery_unknown', incidentId: 'NQB-TEST' },
      { state: 'delivered', incidentId: 'NQB-TEST' },
    ],
  });

  const first = await runBackupAttempt({
    now: new Date('2026-07-25T12:00:00.000Z'),
    backupFn: async () => './data/backups/questbot-slot-1.db',
    ...spies,
  });
  const pending = getBackupHealthStatus();
  const second = await runBackupAttempt({
    now: new Date('2026-07-25T12:15:00.000Z'),
    backupFn: async () => './data/backups/questbot-slot-2.db',
    ...spies,
  });

  assert.equal(first.recovery.state, 'delivery_unknown');
  assert.equal(pending.recoveryPending, true);
  assert.equal(second.recovery.state, 'delivered');
  assert.equal(spies.recoveries.length, 2);
  assert.equal(getBackupHealthStatus().recoveryPending, false);
  assert.equal(getBackupHealthStatus().incidentOpen, false);
});

test('a new failure after pending recovery starts a fresh incident lifecycle', async () => {
  resetBackupHealthForTests({
    state: 'healthy',
    consecutiveFailures: 0,
    incidentOpen: true,
    recoveryPending: true,
  });
  const spies = reportingSpies();

  await runBackupAttempt({
    now: new Date('2026-07-25T13:00:00.000Z'),
    backupFn: async () => { throw new Error('backup failed again'); },
    ...spies,
  });

  const status = getBackupHealthStatus();
  assert.equal(status.recoveryPending, false);
  assert.equal(status.incidentOpen, false);
  assert.equal(spies.incidents.length, 0);
});

test('backup status exposes bounded retry evidence without a database path', () => {
  const status = getBackupHealthStatus(new Date());
  assert.equal(status.enabled, true);
  assert.equal(status.threshold, 3);
  assert.equal(status.maxAgeHours, 26);
  assert.equal(status.fastRetryLimit, BACKUP_FAST_RETRY_LIMIT);
  assert.equal(status.fastRetryLimit, 3);
  assert.equal(Object.hasOwn(status, 'databasePath'), false);
  assert.equal(Object.hasOwn(status, 'backupDirectory'), false);
});
