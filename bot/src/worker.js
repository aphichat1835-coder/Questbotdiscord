import { config } from './config.js';
import {
  backupDatabaseSlot,
  clearInactiveDatabaseBackupSlots,
  DATABASE_BACKUP_SLOT_COUNT,
} from './db.js';
import { reportCriticalError } from './error-reporter.js';
import { nextDailyTime } from './runner-schedule.js';
import { settleWithTimeout } from './async-settle.js';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
let backupTimeout = null;
let workerStopping = false;
const activeTasks = new Set();

function trackTask(promise) {
  activeTasks.add(promise);
  void promise.then(
    () => activeTasks.delete(promise),
    () => activeTasks.delete(promise),
  );
  return promise;
}

export function startWorker() {
  workerStopping = false;
  if (!config.databaseBackupEnabled) {
    console.log('💾 Database backup scheduler disabled — DATABASE_BACKUP_ENABLED is false');
    return;
  }
  scheduleDatabaseBackup();
}

export async function stopWorker(timeoutMs = null) {
  workerStopping = true;
  if (backupTimeout) {
    clearTimeout(backupTimeout);
    backupTimeout = null;
  }

  await settleWithTimeout(activeTasks, timeoutMs, {
    pendingCount: () => activeTasks.size,
    timeoutMessage: (count) => (
      `Database backup shutdown timed out with ${count} task(s) pending`
    ),
  });
  console.log('💾 Database backup scheduler stopped');
}

function scheduleDatabaseBackup() {
  if (workerStopping || !config.databaseBackupEnabled) return;
  const next = nextDailyTime(3, new Date(), config.timezone);
  const delay = Math.max(0, next.getTime() - Date.now());
  console.log(`💾 Database backup scheduled in ${Math.floor(delay / 3600000)}h ${Math.floor((delay % 3600000) / 60000)}m`);

  backupTimeout = setTimeout(() => {
    trackTask((async () => {
      try {
        await runDatabaseBackup();
      } catch (error) {
        await reportCriticalError('Database backup', error);
      } finally {
        scheduleDatabaseBackup();
      }
    })());
  }, delay);
  backupTimeout.unref?.();
}

function normalizedRetention() {
  return Math.min(DATABASE_BACKUP_SLOT_COUNT, config.databaseBackupRetention);
}

function backupSlotForDate(now, retention) {
  const dayNumber = Math.floor(now.getTime() / MILLISECONDS_PER_DAY);
  return ((dayNumber % retention) + retention) % retention;
}

export async function runDatabaseBackup(now = new Date()) {
  if (!config.databaseBackupEnabled) return null;
  const retention = normalizedRetention();
  const slotIndex = backupSlotForDate(now, retention);
  const destination = await backupDatabaseSlot(slotIndex);
  await clearInactiveDatabaseBackupSlots(retention);

  console.log(`💾 Database backup completed → slot ${slotIndex + 1}/${retention}`);
  return destination;
}
