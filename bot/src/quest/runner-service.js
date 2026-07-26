import * as legacyRunner from '../discord-runner.js';
import { config } from '../config.js';
import { reportCriticalError } from '../error-reporter.js';
import {
  decryptRunnerToken,
  getScheduledRunner,
  listScheduledRunners,
  updateScheduledRunner,
} from '../scheduled-runner-store.js';
import { authorizationFingerprint } from './rate-limit-coordinator.js';
import { subscribeScheduleHints } from './schedule-hint-bus.js';
import {
  beginRunnerState,
  getRunnerState,
  markInterruptedRunnerStates,
  pruneRunnerStates,
  RUNNER_STATE,
  transitionRunnerState,
} from './runner-state-store.js';
import {
  startRunnerStateObserver,
  stopRunnerStateObserver,
  syncAllRunnerStates,
} from './runner-state-observer.js';

const observedCompletions = new Set();
const smartWakeups = new Map();
const smartRestarting = new Set();

function clearSmartWake(jobKey) {
  const entry = smartWakeups.get(jobKey);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.unsubscribe?.();
  smartWakeups.delete(jobKey);
}

function hintState(reason) {
  if (reason.startsWith('claim:')) return RUNNER_STATE.CLAIMING;
  if (reason.startsWith('enrollment:')) return RUNNER_STATE.WAITING_ENROLLMENT;
  if (reason === 'retry') return RUNNER_STATE.WAITING_RETRY;
  if (reason === 'verification') return RUNNER_STATE.VERIFYING_COMPLETION;
  return RUNNER_STATE.WAITING_SCHEDULE;
}

function runnerIsSleeping(job) {
  const status = String(job?.summary?.().status ?? '');
  return /NEXT CHECK|AUTO DAILY ACTIVE/.test(status);
}

async function wakeScheduledRunner(args) {
  const active = legacyRunner.getJob(args.jobKey);
  if (!active || !runnerIsSleeping(active)) return false;
  if (!getScheduledRunner(args.scheduleId)) {
    clearSmartWake(args.jobKey);
    return false;
  }

  smartRestarting.add(args.jobKey);
  transitionRunnerState(args.jobKey, RUNNER_STATE.RECOVERING, {
    nextActionAt: new Date().toISOString(),
    metadata: { reason: 'smart-wakeup' },
  });
  const completion = active.done;
  legacyRunner.stopJob(args.ownerId, args.jobKey, { removeSchedule: false });
  await Promise.resolve(completion).catch(() => {});

  try {
    if (!getScheduledRunner(args.scheduleId)) return false;
    await startRunner({ ...args, initialNextCheckAt: null });
    return true;
  } finally {
    smartRestarting.delete(args.jobKey);
  }
}

function scheduleSmartWake(args, hint) {
  if (args.mode !== 'scheduled' || hint.reason === 'baseline') return;
  const at = Date.parse(hint.nextActionAt);
  if (!Number.isFinite(at)) return;

  const active = legacyRunner.getJob(args.jobKey);
  const currentNextAt = Date.parse(active?.summary?.().nextCheckAt);
  if (Number.isFinite(currentNextAt) && currentNextAt <= at) return;

  const existing = smartWakeups.get(args.jobKey);
  if (existing?.timer) clearTimeout(existing.timer);
  transitionRunnerState(args.jobKey, hintState(hint.reason), {
    nextActionAt: hint.nextActionAt,
    metadata: { reason: hint.reason, priority: hint.priority },
  });

  const delay = Math.max(0, at - Date.now());
  const timer = setTimeout(() => {
    const entry = smartWakeups.get(args.jobKey);
    if (entry) entry.timer = null;
    void wakeScheduledRunner(args).catch((error) => {
      const current = getRunnerState(args.jobKey);
      if (current) {
        transitionRunnerState(args.jobKey, RUNNER_STATE.FAILED, {
          lastError: error?.message ?? String(error),
          metadata: { stage: 'smart-wakeup' },
        });
      }
    });
  }, delay);
  timer.unref?.();
  smartWakeups.set(args.jobKey, {
    ...existing,
    timer,
    args,
    hint,
  });
}

function registerSmartWake(args) {
  if (args.mode !== 'scheduled') return;
  const existing = smartWakeups.get(args.jobKey);
  existing?.unsubscribe?.();
  const account = authorizationFingerprint(args.userToken);
  const unsubscribe = subscribeScheduleHints(account, (hint) => scheduleSmartWake(args, hint));
  smartWakeups.set(args.jobKey, {
    ...existing,
    args,
    unsubscribe,
  });
}

function observeCompletion(jobKey, mode, scheduleId = null) {
  if (observedCompletions.has(jobKey)) return;
  const job = legacyRunner.getJob(jobKey);
  if (!job?.done) return;
  observedCompletions.add(jobKey);
  void Promise.resolve(job.done)
    .then(() => {
      const current = getRunnerState(jobKey);
      if (smartRestarting.has(jobKey)) {
        if (current) transitionRunnerState(jobKey, RUNNER_STATE.RECOVERING);
        return;
      }
      if (current && ![RUNNER_STATE.FAILED, RUNNER_STATE.STOPPED].includes(current.state)) {
        transitionRunnerState(
          jobKey,
          mode === 'oneshot' ? RUNNER_STATE.COMPLETED : RUNNER_STATE.STOPPED,
          { metadata: { completion: 'runner-promise-settled' } },
        );
      }
      if (mode === 'oneshot' || !getScheduledRunner(scheduleId)) clearSmartWake(jobKey);
    }, (error) => {
      const current = getRunnerState(jobKey);
      if (current) {
        transitionRunnerState(jobKey, RUNNER_STATE.FAILED, {
          lastError: error?.message ?? String(error),
          metadata: { completion: 'runner-promise-rejected' },
        });
      }
      clearSmartWake(jobKey);
    })
    .finally(() => observedCompletions.delete(jobKey));
}

export async function startRunner(args) {
  beginRunnerState({
    jobKey: args.jobKey,
    ownerId: args.ownerId,
    accountId: args.accountId ?? null,
    username: args.username ?? null,
    mode: args.mode ?? 'oneshot',
    scheduleId: args.scheduleId ?? null,
    state: RUNNER_STATE.QUEUED,
    nextActionAt: args.initialNextCheckAt ?? null,
    metadata: { source: 'runner-service' },
  });
  transitionRunnerState(args.jobKey, RUNNER_STATE.AUTHENTICATING);

  try {
    const result = await legacyRunner.startRunner(args);
    transitionRunnerState(args.jobKey, RUNNER_STATE.RUNNING, {
      accountId: args.accountId ?? null,
      username: args.username ?? null,
      nextActionAt: args.initialNextCheckAt ?? null,
    });
    registerSmartWake(args);
    observeCompletion(args.jobKey, args.mode ?? 'oneshot', args.scheduleId ?? null);
    startRunnerStateObserver();
    return result;
  } catch (error) {
    transitionRunnerState(args.jobKey, RUNNER_STATE.FAILED, {
      lastError: error?.message ?? String(error),
      metadata: { stage: 'start' },
    });
    clearSmartWake(args.jobKey);
    throw error;
  }
}

export async function restoreScheduledRunners(client) {
  markInterruptedRunnerStates();
  const rows = listScheduledRunners();
  if (!rows.length) {
    startRunnerStateObserver();
    pruneRunnerStates();
    return { restored: 0, failed: 0 };
  }

  let restored = 0;
  let failed = 0;
  const restoredByOwner = new Map();
  const restoredAccounts = new Set();

  for (const row of rows) {
    const ownerCount = restoredByOwner.get(row.owner_id) ?? 0;
    if (ownerCount >= 10) {
      failed++;
      updateScheduledRunner(row.id, { lastError: 'Restore skipped: owner runner limit exceeded' });
      continue;
    }
    if (restoredAccounts.has(row.account_id)) {
      failed++;
      updateScheduledRunner(row.id, { lastError: 'Restore skipped: Discord account already restored' });
      continue;
    }

    try {
      const token = decryptRunnerToken(row, config.runnerTokenSecret);
      await startRunner({
        jobKey: `scheduled:${row.id}`,
        ownerId: row.owner_id,
        userToken: token,
        channelId: row.channel_id,
        client,
        mode: 'scheduled',
        scheduleId: row.id,
        accountId: row.account_id,
        username: row.username,
        initialNextCheckAt: row.next_check_at,
      });
      restored++;
      restoredByOwner.set(row.owner_id, ownerCount + 1);
      restoredAccounts.add(row.account_id);
    } catch (error) {
      failed++;
      updateScheduledRunner(row.id, { lastError: `Restore failed: ${error.message}` });
      await reportCriticalError(`Restore Scheduled Runner #${row.id}`, error);
    }
  }

  syncAllRunnerStates();
  startRunnerStateObserver();
  pruneRunnerStates();
  console.log(`♻️ Scheduled Runners restored: ${restored}, failed: ${failed}`);
  return { restored, failed };
}

export async function shutdownRunners(timeoutMs = null) {
  for (const job of legacyRunner.listJobs()) {
    const current = getRunnerState(job.key);
    if (current) transitionRunnerState(job.key, RUNNER_STATE.STOPPING);
    clearSmartWake(job.key);
  }
  const result = await legacyRunner.shutdownRunners(timeoutMs);
  syncAllRunnerStates();
  stopRunnerStateObserver();
  return result;
}

export const clearQuestEngineStatuses = legacyRunner.clearQuestEngineStatuses;
export const fetchMe = legacyRunner.fetchMe;
export const findAnyJobByAccount = legacyRunner.findAnyJobByAccount;
export const findUserJobByAccount = legacyRunner.findUserJobByAccount;
export const getJob = legacyRunner.getJob;
export const getQuestEngineStatus = legacyRunner.getQuestEngineStatus;
export const getUserJobs = legacyRunner.getUserJobs;
export const listJobs = legacyRunner.listJobs;
export const listQuestEngineStatuses = legacyRunner.listQuestEngineStatuses;
export const refreshBuildInfo = legacyRunner.refreshBuildInfo;
export const selectQuestClaimPlatform = legacyRunner.selectQuestClaimPlatform;
export const stopAllForUser = legacyRunner.stopAllForUser;
export const stopJob = legacyRunner.stopJob;
export const stopRunner = legacyRunner.stopRunner;
export const stopScheduledJob = legacyRunner.stopScheduledJob;
