import * as legacyRunner from '../discord-runner.js';
import { transientRetryDelayMs } from '../runner-schedule.js';
import { getScheduledRunner } from '../scheduled-runner-store.js';
import {
  getRunnerState,
  RUNNER_MUTATION_STATUS,
  RUNNER_STATE,
  transitionRunnerState,
} from './runner-state-store.js';
import {
  clearSmartWake,
  isSmartWakeRestarting,
} from './smart-wake-controller.js';

const observedCompletions = new Set();
const RECOVERY_STATES = new Set([
  RUNNER_STATE.RECOVERING,
  RUNNER_STATE.VERIFYING_ENROLLMENT,
  RUNNER_STATE.VERIFYING_PROGRESS,
  RUNNER_STATE.VERIFYING_COMPLETION,
  RUNNER_STATE.VERIFYING_CLAIM,
]);
const UNVERIFIED_MUTATION_STATUSES = new Set([
  RUNNER_MUTATION_STATUS.PREPARED,
  RUNNER_MUTATION_STATUS.IN_FLIGHT,
  RUNNER_MUTATION_STATUS.ACCEPTED,
  RUNNER_MUTATION_STATUS.UNCERTAIN,
]);

let readJob = legacyRunner.getJob;
let readScheduledRunner = getScheduledRunner;
let now = Date.now;

function scheduleExists(scheduleId) {
  return scheduleId != null && Boolean(readScheduledRunner(scheduleId));
}

function shouldDeferRecovery(current, mode, scheduleId) {
  return Boolean(
    current
    && mode === 'scheduled'
    && scheduleExists(scheduleId)
    && (
      RECOVERY_STATES.has(current.state)
      || UNVERIFIED_MUTATION_STATUSES.has(current.mutation_status)
    )
  );
}

function settledState(current, mode, scheduleId) {
  if (!current) return null;
  if ([RUNNER_STATE.COMPLETED, RUNNER_STATE.FAILED, RUNNER_STATE.STOPPED].includes(current.state)) {
    return current.state;
  }
  if (current.state === RUNNER_STATE.STOPPING) return RUNNER_STATE.STOPPED;
  if (mode === 'oneshot') return RUNNER_STATE.STOPPED;
  if (!scheduleExists(scheduleId)) return RUNNER_STATE.STOPPED;
  if (shouldDeferRecovery(current, mode, scheduleId)) return RUNNER_STATE.WAITING_RETRY;
  return RUNNER_STATE.FAILED;
}

function resolvedValues(current, state) {
  if (state === RUNNER_STATE.WAITING_RETRY) {
    const nextActionAt = new Date(now() + transientRetryDelayMs(0)).toISOString();
    return {
      nextActionAt,
      lastError: 'Recovery verification was deferred after a transient runner exit',
      metadata: {
        ...(current?.metadata ?? {}),
        completion: 'recovery-deferred',
      },
      stateSource: 'runner-recovery-deferred',
    };
  }
  return {
    nextActionAt: null,
    lastError: state === RUNNER_STATE.FAILED
      ? 'Scheduled runner exited while its persisted schedule was still active'
      : null,
    metadata: { completion: 'runner-promise-settled' },
    stateSource: 'runner-completion-observer',
  };
}

function handleResolved(jobKey, mode, scheduleId) {
  const current = getRunnerState(jobKey);
  if (isSmartWakeRestarting(jobKey)) {
    if (current) transitionRunnerState(jobKey, RUNNER_STATE.RECOVERING);
    return;
  }

  const state = settledState(current, mode, scheduleId);
  if (state && current?.state !== state) {
    transitionRunnerState(jobKey, state, resolvedValues(current, state));
  }
  if (mode === 'oneshot' || !scheduleExists(scheduleId)) clearSmartWake(jobKey);
}

function handleRejected(jobKey, error) {
  if (isSmartWakeRestarting(jobKey)) return;
  const current = getRunnerState(jobKey);
  if (current) {
    transitionRunnerState(jobKey, RUNNER_STATE.FAILED, {
      nextActionAt: null,
      lastError: error?.message ?? String(error),
      metadata: { completion: 'runner-promise-rejected' },
      stateSource: 'runner-completion-observer',
    });
  }
  clearSmartWake(jobKey);
}

export function configureRunnerCompletionObserver({
  getJob = legacyRunner.getJob,
  getScheduled = getScheduledRunner,
  currentTime = Date.now,
} = {}) {
  readJob = getJob;
  readScheduledRunner = getScheduled;
  now = currentTime;
}

export function observeRunnerCompletion(jobKey, mode, scheduleId = null) {
  if (observedCompletions.has(jobKey)) return false;
  const job = readJob(jobKey);
  if (!job?.done) return false;
  observedCompletions.add(jobKey);
  void Promise.resolve(job.done)
    .then(
      () => handleResolved(jobKey, mode, scheduleId),
      (error) => handleRejected(jobKey, error),
    )
    .finally(() => observedCompletions.delete(jobKey));
  return true;
}

export function clearRunnerCompletionObserversForTests() {
  observedCompletions.clear();
  configureRunnerCompletionObserver();
}
