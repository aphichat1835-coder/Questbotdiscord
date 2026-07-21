import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { backupDatabase } from './db.js';
import { reportCriticalError } from './error-reporter.js';
import { nextDailyTime } from './runner-schedule.js';

let backupTimeout = null;
let workerStopping = false;
const activeTasks = new Set();

function trackTask(promise) {
  activeTasks.add(promise);
  void promise.finally(() => activeTasks.delete(promise));
  return promise;
}

export function startWorker() {
  workerStopping = false;
  if (!config.databaseBackupDir) {
    console.log('💾 Database backup scheduler disabled — DATABASE_BACKUP_DIR is empty');
    return;
  }
  scheduleDatabaseBackup();
}

export async function stopWorker(timeoutMs = 5000) {
  workerStopping = true;
  if (backupTimeout) {
    clearTimeout(backupTimeout);
    backupTimeout = null;
  }

  let timeout;
  await Promise.race([
    Promise.allSettled([...activeTasks]),
    new Promise((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timeout);
  console.log('💾 Database backup scheduler stopped');
}

function scheduleDatabaseBackup() {
  if (workerStopping || !config.databaseBackupDir) return;
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

export async function runDatabaseBackup(now = new Date()) {
  if (!config.databaseBackupDir) return null;
  await fs.mkdir(config.databaseBackupDir, { recursive: true });

  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const filename = `questbot-${timestamp}.db`;
  const destination = path.join(config.databaseBackupDir, filename);
  await backupDatabase(destination);

  const files = (await fs.readdir(config.databaseBackupDir))
    .filter((name) => /^questbot-.*\.db$/.test(name))
    .sort()
    .reverse();
  await Promise.all(
    files.slice(config.databaseBackupRetention)
      .map((name) => fs.unlink(path.join(config.databaseBackupDir, name))),
  );

  console.log(`💾 Database backup completed → ${destination}`);
  return destination;
}
