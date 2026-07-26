import * as legacyRunner from '../discord-runner.js';
import { getScheduledRunner } from '../scheduled-runner-store.js';
import {
  getRunnerState,
  RUNNER_STATE,
  transitionRunnerState,
} from './runner-state-store.js';
import {
  clearSmartWake,
  isSmartWakeRestarting,
} from './smart-wake-controller.js';

const observedCompletions = new Set();

function settledState(current, mode, scheduleId) {
  if (!current) return null;
  if ([RUNNER_STATE.COMPLETED, RUNNER_STATE.FAILED, RUNNER_STATE.STOPPED].includes(current.state)) {
    return current.state;
  }
  if (current.state === RUNNER_STATE.STOPPING) return RUNNER_STATE.STOPPED;
  if (mode === 'oneshot') return RUNNER_STATE.STOPPED;
  return getScheduledRunner(scheduleId) ? RUNNER_STATE.FAILED : RUNNER_STATE.STOPPED;
}

function handleResolved(jobKey, mode, scheduleId) {
  const current = getRunnerState(jobKey);
  if (isSmartWakeRestarting(jobKey)) {
    if (current) transitionRunnerState(jobKey, RUNNER_STATE.RECOVERING);
    return;
  }

  const state = settledState(current, mode, scheduleId);
  if (state && current?.state !== state) {
    transitionRunnerState(jobKey, state, {
      lastError: state === RUNNER_STATE.FAILED
        ? 'Scheduled runner exited while its persisted schedule was still active'
        : null,
      metadata: { completion: 'runner-promise-settled' },
    });
  }
  if (mode === 'oneshot' || !getScheduledRunner(scheduleId)) clearSmartWake(jobKey);
}

function handleRejected(jobKey, error) {
  if (isSmartWakeRestarting(jobKey)) return;
  const current = getRunnerState(jobKey);
  if (current) {
    transitionRunnerState(jobKey, RUNNER_STATE.FAILED, {
      lastError: error?.message ?? String(error),
      metadata: { completion: 'runner-promise-rejected' },
    });
  }
  clearSmartWake(jobKey);
}

export function observeRunnerCompletion(jobKey, mode, scheduleId = null) {
  if (observedCompletions.has(jobKey)) return false;
  const job = legacyRunner.getJob(jobKey);
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
