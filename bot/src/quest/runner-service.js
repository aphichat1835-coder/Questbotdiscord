import * as legacyRunner from '../discord-runner.js';
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

function observeCompletion(jobKey, mode) {
  if (observedCompletions.has(jobKey)) return;
  const job = legacyRunner.getJob(jobKey);
  if (!job?.done) return;
  observedCompletions.add(jobKey);
  void Promise.resolve(job.done)
    .then(() => {
      const current = getRunnerState(jobKey);
      if (current && ![RUNNER_STATE.FAILED, RUNNER_STATE.STOPPED].includes(current.state)) {
        transitionRunnerState(
          jobKey,
          mode === 'oneshot' ? RUNNER_STATE.COMPLETED : RUNNER_STATE.STOPPED,
          { metadata: { completion: 'runner-promise-settled' } },
        );
      }
    }, (error) => {
      const current = getRunnerState(jobKey);
      if (current) {
        transitionRunnerState(jobKey, RUNNER_STATE.FAILED, {
          lastError: error?.message ?? String(error),
          metadata: { completion: 'runner-promise-rejected' },
        });
      }
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
    observeCompletion(args.jobKey, args.mode ?? 'oneshot');
    startRunnerStateObserver();
    return result;
  } catch (error) {
    transitionRunnerState(args.jobKey, RUNNER_STATE.FAILED, {
      lastError: error?.message ?? String(error),
      metadata: { stage: 'start' },
    });
    throw error;
  }
}

export async function restoreScheduledRunners(client) {
  markInterruptedRunnerStates();
  const result = await legacyRunner.restoreScheduledRunners(client);
  for (const job of legacyRunner.listJobs().filter((item) => item.mode === 'scheduled')) {
    beginRunnerState({
      jobKey: job.key,
      ownerId: job.ownerId,
      accountId: job.accountId,
      username: job.username,
      mode: job.mode,
      scheduleId: job.scheduleId,
      state: RUNNER_STATE.RECOVERING,
      nextActionAt: job.nextCheckAt,
      metadata: { source: 'restore' },
    });
    transitionRunnerState(job.key, RUNNER_STATE.RUNNING, {
      nextActionAt: job.nextCheckAt,
      metadata: { source: 'restore-complete' },
    });
    observeCompletion(job.key, job.mode);
  }
  syncAllRunnerStates();
  startRunnerStateObserver();
  pruneRunnerStates();
  return result;
}

export async function shutdownRunners(timeoutMs = null) {
  for (const job of legacyRunner.listJobs()) {
    const current = getRunnerState(job.key);
    if (current) transitionRunnerState(job.key, RUNNER_STATE.STOPPING);
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
