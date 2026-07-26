import * as legacyRunner from '../discord-runner.js';
import { observeRunnerCompletion } from './runner-completion-observer.js';
import { restoreScheduledRunnerRows } from './scheduled-restore.js';
import {
  clearAllSmartWakes,
  clearSmartWake,
  configureSmartWakeController,
  registerSmartWake,
} from './smart-wake-controller.js';
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

function beginDurableStart(args) {
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
}

function markStarted(args) {
  transitionRunnerState(args.jobKey, RUNNER_STATE.RUNNING, {
    accountId: args.accountId ?? null,
    username: args.username ?? null,
    nextActionAt: args.initialNextCheckAt ?? null,
  });
  registerSmartWake(args);
  observeRunnerCompletion(args.jobKey, args.mode ?? 'oneshot', args.scheduleId ?? null);
  startRunnerStateObserver();
}

function markStartFailure(args, error) {
  transitionRunnerState(args.jobKey, RUNNER_STATE.FAILED, {
    lastError: error?.message ?? String(error),
    metadata: { stage: 'start' },
  });
  clearSmartWake(args.jobKey);
}

export async function startRunner(args) {
  beginDurableStart(args);
  try {
    const result = await legacyRunner.startRunner(args);
    markStarted(args);
    return result;
  } catch (error) {
    markStartFailure(args, error);
    throw error;
  }
}

configureSmartWakeController(startRunner);

export async function restoreScheduledRunners(client) {
  markInterruptedRunnerStates();
  const result = await restoreScheduledRunnerRows(client, startRunner);
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
  clearAllSmartWakes();
  const result = await legacyRunner.shutdownRunners(timeoutMs);
  syncAllRunnerStates();
  stopRunnerStateObserver();
  return result;
}

export function stopJob(ownerId, jobKey, options = {}) {
  const stopped = legacyRunner.stopJob(ownerId, jobKey, options);
  if (stopped && options.removeSchedule !== false) clearSmartWake(jobKey);
  return stopped;
}

export function stopScheduledJob(ownerId, scheduleId) {
  const stopped = legacyRunner.stopScheduledJob(ownerId, scheduleId);
  if (stopped) clearSmartWake(`scheduled:${scheduleId}`);
  return stopped;
}

export function stopAllForUser(ownerId, options = {}) {
  const jobs = legacyRunner.getUserJobs(ownerId, {
    mode: options.mode ?? null,
    includeStopping: true,
  });
  const stopped = legacyRunner.stopAllForUser(ownerId, options);
  if (stopped > 0) jobs.forEach((job) => clearSmartWake(job.key));
  return stopped;
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
export const stopRunner = legacyRunner.stopRunner;
