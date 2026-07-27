import { config } from '../config.js';
import { reportCriticalError } from '../error-reporter.js';
import { releaseScheduledRunnerClaimsByHolder } from './scheduled-worker-claims.js';
import {
  reconcileScheduledWorker,
  scheduledClaimTtlMs,
} from './scheduled-worker-reconciler.js';

export { reconcileScheduledWorker, scheduledClaimTtlMs } from './scheduled-worker-reconciler.js';

let supervisorTimer = null;
let supervisorHolder = null;
let reconcilePromise = null;
let lastResult = null;

async function runReconcile(client) {
  if (reconcilePromise) return reconcilePromise;
  reconcilePromise = reconcileScheduledWorker(client, {
    holder: supervisorHolder,
    claimTtlMs: scheduledClaimTtlMs(config.workerPollIntervalMs),
  })
    .then((result) => {
      lastResult = { ...result, checkedAt: new Date().toISOString(), error: null };
      return result;
    })
    .catch(async (error) => {
      lastResult = {
        checkedAt: new Date().toISOString(),
        error: error?.message ?? String(error),
      };
      await reportCriticalError('Scheduled worker reconciliation', error);
      throw error;
    })
    .finally(() => {
      reconcilePromise = null;
    });
  return reconcilePromise;
}

export async function startScheduledWorkerSupervisor(client, {
  holder = `worker:${process.pid}`,
  initialReconcile = runReconcile,
} = {}) {
  if (supervisorTimer) return false;
  supervisorHolder = holder;
  supervisorTimer = setInterval(() => {
    void runReconcile(client).catch(() => undefined);
  }, config.workerPollIntervalMs);
  supervisorTimer.unref?.();
  await initialReconcile(client, { holder }).catch(() => undefined);
  return true;
}

export async function stopScheduledWorkerSupervisor() {
  if (supervisorTimer) {
    clearInterval(supervisorTimer);
    supervisorTimer = null;
  }
  await reconcilePromise?.catch(() => undefined);
  if (supervisorHolder) releaseScheduledRunnerClaimsByHolder(supervisorHolder);
  supervisorHolder = null;
  return true;
}

export function getScheduledWorkerStatus() {
  return lastResult ? { ...lastResult } : null;
}
