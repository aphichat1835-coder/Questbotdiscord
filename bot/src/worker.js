import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { backupDatabase } from './db.js';
import { reportCriticalError } from './error-reporter.js';
import { resolveContainedPath } from './path-safety.js';
import { nextDailyTime } from './runner-schedule.js';

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
      timeout.unref?.();
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

function isBackupFile(name) {
  return name.startsWith('questbot-') && name.endsWith('.db');
}

export async function runDatabaseBackup(now = new Date()) {
  if (!config.databaseBackupDir) return null;
  const backupDir = path.resolve(config.databaseBackupDir);
  await fs.mkdir(backupDir, { recursive: true });

  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const filename = `questbot-${timestamp}.db`;
  const destination = resolveContainedPath(backupDir, filename);
  await backupDatabase(destination);

  const files = (await fs.readdir(backupDir))
    .filter(isBackupFile)
    .sort()
    .reverse();
  const expiredFiles = files.slice(config.databaseBackupRetention);
  await Promise.all(
    expiredFiles.map((name) => fs.unlink(resolveContainedPath(backupDir, name))),
  );

  console.log(`💾 Database backup completed → ${destination}`);
  return destination;
}
