import { config } from '../config.js';
import { reportCriticalError } from '../error-reporter.js';
import { listScheduledRunners } from '../scheduled-runner-store.js';
import { listJobs, startLocalRunner, stopJob } from './runner-service.js';
import { restoreScheduledRunnerRows } from './scheduled-restore.js';
import {
  acquireScheduledRunnerClaim,
  DEFAULT_SCHEDULED_CLAIM_TTL_MS,
  releaseScheduledRunnerClaim,
  renewScheduledRunnerClaim,
} from './scheduled-worker-claims.js';
import {
  getRunnerState,
  listRunnerStates,
  RUNNER_STATE,
  transitionRunnerState,
} from './runner-state-store.js';

const FAILED_RETRY_DELAY_MS = 5 * 60 * 1000;

export function scheduledClaimTtlMs(pollIntervalMs = config.workerPollIntervalMs) {
  const poll = Number(pollIntervalMs);
  return Math.max(
    DEFAULT_SCHEDULED_CLAIM_TTL_MS,
    Number.isFinite(poll) && poll > 0 ? poll * 3 : 0,
  );
}

function activeScheduledJobs(jobs) {
  return jobs.filter((job) => job.mode === 'scheduled' && job.scheduleId != null);
}

function ownerCounts(jobs) {
  const counts = new Map();
  for (const job of jobs) counts.set(job.ownerId, (counts.get(job.ownerId) ?? 0) + 1);
  return counts;
}

function retryEligible(row, now) {
  const state = getRunnerState(`scheduled:${row.id}`);
  if (state?.state !== RUNNER_STATE.FAILED) return true;
  const updatedAt = Date.parse(state.updated_at);
  return !Number.isFinite(updatedAt) || updatedAt + FAILED_RETRY_DELAY_MS <= now;
}

async function stopSafely(job, options) {
  try {
    const requested = options.stop(job.ownerId, job.key, { removeSchedule: false }) ? 1 : 0;
    if (options.holder) options.releaseClaim(Number(job.scheduleId), options.holder);
    return { requested, failed: 0 };
  } catch (error) {
    await Promise.resolve(options.reportStopError(`Scheduled worker stop ${job.key}`, error))
      .catch(() => undefined);
    return { requested: 0, failed: 1 };
  }
}

function ownsActiveClaim(job, options) {
  if (!options.holder) return true;
  const id = Number(job.scheduleId);
  return options.renewClaim(id, options.holder, options.claimTtlMs, options.now)
    || options.acquireClaim(id, options.holder, options.claimTtlMs, options.now);
}

async function reconcileActive(rows, jobs, options) {
  const rowIds = new Set(rows.map((row) => Number(row.id)));
  const surviving = [];
  const result = { stopRequested: 0, stopFailures: 0, claimLost: 0, claimsRenewed: 0 };
  for (const job of jobs) {
    const rowExists = rowIds.has(Number(job.scheduleId));
    const ownsClaim = rowExists && ownsActiveClaim(job, options);
    if (rowExists && ownsClaim) {
      surviving.push(job);
      if (options.holder) result.claimsRenewed++;
      continue;
    }
    if (rowExists && !ownsClaim) result.claimLost++;
    const stopped = await stopSafely(job, options);
    result.stopRequested += stopped.requested;
    result.stopFailures += stopped.failed;
  }
  return { ...result, surviving };
}

async function restoreMissing(client, rows, surviving, options) {
  const activeIds = new Set(surviving.map((job) => Number(job.scheduleId)));
  const accounts = surviving.map((job) => job.accountId).filter(Boolean);
  const counts = ownerCounts(surviving);
  const result = { restore: { restored: 0, failed: 0 }, claimsAcquired: 0, claimConflicts: 0 };

  for (const row of rows) {
    const id = Number(row.id);
    if (activeIds.has(id) || !retryEligible(row, options.now)) continue;
    if (options.holder && !options.acquireClaim(id, options.holder, options.claimTtlMs, options.now)) {
      result.claimConflicts++;
      continue;
    }
    if (options.holder) result.claimsAcquired++;
    const restored = await restoreScheduledRunnerRows(client, options.startRunner, {
      rows: [row],
      reconciliationRows: rows,
      existingAccountIds: accounts,
      existingOwnerCounts: counts,
      now: new Date(options.now),
    });
    result.restore.restored += restored.restored;
    result.restore.failed += restored.failed;
    if (restored.restored > 0) {
      activeIds.add(id);
      if (row.account_id) accounts.push(row.account_id);
      counts.set(row.owner_id, (counts.get(row.owner_id) ?? 0) + 1);
    } else if (options.holder) {
      options.releaseClaim(id, options.holder);
    }
  }
  return result;
}

function finalizeStops(rows, active, options) {
  const rowIds = new Set(rows.map((row) => Number(row.id)));
  const activeIds = new Set(active.map((job) => Number(job.scheduleId)));
  let finalized = 0;
  for (const state of listRunnerStates({ activeOnly: true, limit: 500 })) {
    if (state.mode !== 'scheduled' || state.state !== RUNNER_STATE.STOPPING) continue;
    const id = Number(state.schedule_id);
    if (rowIds.has(id) || activeIds.has(id)) continue;
    if (options.holder) options.releaseClaim(id, options.holder);
    transitionRunnerState(state.job_key, RUNNER_STATE.STOPPED, {
      nextActionAt: null,
      lastError: null,
      metadata: { ...(state.metadata ?? {}), stopConfirmedBy: 'worker-supervisor' },
      stateSource: 'worker-supervisor',
    });
    finalized++;
  }
  return finalized;
}

export async function reconcileScheduledWorker(client, supplied = {}) {
  const options = {
    rows: listScheduledRunners(),
    jobs: listJobs(),
    startRunner: startLocalRunner,
    stop: stopJob,
    reportStopError: reportCriticalError,
    now: Date.now(),
    holder: null,
    claimTtlMs: scheduledClaimTtlMs(),
    acquireClaim: acquireScheduledRunnerClaim,
    renewClaim: renewScheduledRunnerClaim,
    releaseClaim: releaseScheduledRunnerClaim,
    ...supplied,
  };
  const active = activeScheduledJobs(options.jobs);
  const activeResult = await reconcileActive(options.rows, active, options);
  const restored = await restoreMissing(client, options.rows, activeResult.surviving, options);
  return {
    scheduledRows: options.rows.length,
    activeBefore: active.length,
    stopRequested: activeResult.stopRequested,
    stopFailures: activeResult.stopFailures,
    claimLost: activeResult.claimLost,
    claimsRenewed: activeResult.claimsRenewed,
    claimsAcquired: restored.claimsAcquired,
    claimConflicts: restored.claimConflicts,
    finalizedStops: finalizeStops(options.rows, active, options),
    restore: restored.restore,
  };
}
