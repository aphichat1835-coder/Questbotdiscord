import { config } from '../config.js';
import { reportCriticalError } from '../error-reporter.js';
import { listScheduledRunners } from '../scheduled-runner-store.js';
import {
  listJobs,
  startLocalRunner,
  stopJob,
} from './runner-service.js';
import { restoreScheduledRunnerRows } from './scheduled-restore.js';
import {
  getRunnerState,
  listRunnerStates,
  RUNNER_STATE,
  transitionRunnerState,
} from './runner-state-store.js';

const FAILED_RETRY_DELAY_MS = 5 * 60 * 1000;
let supervisorTimer = null;
let reconcilePromise = null;
let lastResult = null;

function activeScheduledJobs(jobs) {
  return jobs.filter((job) => job.mode === 'scheduled' && job.scheduleId != null);
}

function existingOwnerCounts(jobs) {
  const counts = new Map();
  for (const job of jobs) {
    counts.set(job.ownerId, (counts.get(job.ownerId) ?? 0) + 1);
  }
  return counts;
}

function isRetryEligible(row, now) {
  const state = getRunnerState(`scheduled:${row.id}`);
  if (state?.state !== RUNNER_STATE.FAILED) return true;
  const updatedAt = Date.parse(state.updated_at);
  return !Number.isFinite(updatedAt) || updatedAt + FAILED_RETRY_DELAY_MS <= now;
}

function finalizeDetachedStoppingStates(rows, activeJobs) {
  const rowIds = new Set(rows.map((row) => Number(row.id)));
  const activeIds = new Set(activeJobs.map((job) => Number(job.scheduleId)));
  let finalized = 0;

  for (const state of listRunnerStates({ activeOnly: true, limit: 500 })) {
    if (state.mode !== 'scheduled' || state.state !== RUNNER_STATE.STOPPING) continue;
    const scheduleId = Number(state.schedule_id);
    if (rowIds.has(scheduleId) || activeIds.has(scheduleId)) continue;
    transitionRunnerState(state.job_key, RUNNER_STATE.STOPPED, {
      nextActionAt: null,
      lastError: null,
      metadata: {
        ...(state.metadata ?? {}),
        stopConfirmedBy: 'worker-supervisor',
      },
    });
    finalized++;
  }
  return finalized;
}

export async function reconcileScheduledWorker(client, {
  rows = listScheduledRunners(),
  jobs = listJobs(),
  startRunner = startLocalRunner,
  stop = stopJob,
  reportStopError = reportCriticalError,
  now = Date.now(),
} = {}) {
  const active = activeScheduledJobs(jobs);
  const rowIds = new Set(rows.map((row) => Number(row.id)));
  let stopRequested = 0;
  let stopFailures = 0;

  for (const job of active) {
    if (rowIds.has(Number(job.scheduleId))) continue;
    try {
      if (stop(job.ownerId, job.key, { removeSchedule: false })) stopRequested++;
    } catch (error) {
      stopFailures++;
      await Promise.resolve(reportStopError(`Scheduled worker stop ${job.key}`, error))
        .catch(() => undefined);
    }
  }

  const surviving = active.filter((job) => rowIds.has(Number(job.scheduleId)));
  const activeScheduleIds = new Set(surviving.map((job) => Number(job.scheduleId)));
  const missingRows = rows.filter((row) => (
    !activeScheduleIds.has(Number(row.id)) && isRetryEligible(row, now)
  ));
  const restore = await restoreScheduledRunnerRows(client, startRunner, {
    rows: missingRows,
    reconciliationRows: rows,
    existingAccountIds: surviving.map((job) => job.accountId),
    existingOwnerCounts: existingOwnerCounts(surviving),
  });
  const finalizedStops = finalizeDetachedStoppingStates(rows, active);

  return {
    scheduledRows: rows.length,
    activeBefore: active.length,
    stopRequested,
    stopFailures,
    finalizedStops,
    restore,
  };
}

async function runReconcile(client) {
  if (reconcilePromise) return reconcilePromise;
  reconcilePromise = reconcileScheduledWorker(client)
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

export async function startScheduledWorkerSupervisor(client) {
  if (supervisorTimer) return false;
  supervisorTimer = setInterval(() => {
    void runReconcile(client).catch(() => undefined);
  }, config.workerPollIntervalMs);
  supervisorTimer.unref?.();
  await runReconcile(client).catch(() => undefined);
  return true;
}

export async function stopScheduledWorkerSupervisor() {
  if (supervisorTimer) {
    clearInterval(supervisorTimer);
    supervisorTimer = null;
  }
  await reconcilePromise?.catch(() => undefined);
  return true;
}

export function getScheduledWorkerStatus() {
  return lastResult ? { ...lastResult } : null;
}
