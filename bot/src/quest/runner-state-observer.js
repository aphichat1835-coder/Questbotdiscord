import { listJobs } from '../discord-runner.js';
import {
  beginRunnerState,
  getRunnerState,
  RUNNER_STATE,
  transitionRunnerState,
} from './runner-state-store.js';
import { stateScheduleReason } from './smart-scheduler.js';

const OBSERVER_INTERVAL_MS = 1000;
let observerTimer = null;

function stateFromStatus(job) {
  const status = String(job.status ?? '');
  if (job.lifecycle === 'stopping') return RUNNER_STATE.STOPPING;
  if (/TOKEN INVALID|ERROR|ไม่สำเร็จ/.test(status)) return RUNNER_STATE.FAILED;
  if (/STOPPED BY USER/.test(status)) return RUNNER_STATE.STOPPED;
  if (/NETWORK RETRY/.test(status)) return RUNNER_STATE.WAITING_RETRY;
  if (/NEXT CHECK|AUTO DAILY ACTIVE/.test(status)) return RUNNER_STATE.WAITING_SCHEDULE;
  if (/VERIFY/.test(status)) return RUNNER_STATE.VERIFYING_COMPLETION;
  if (/กำลังเตรียมทำ/.test(status)) return RUNNER_STATE.ENROLLING;
  if (/กำลังทำ|\b\d{1,3}%/.test(status)) return RUNNER_STATE.RUNNING_PROGRESS;
  if (/LOGIN/.test(status)) return RUNNER_STATE.AUTHENTICATING;
  return RUNNER_STATE.RUNNING;
}

function progressFromStatus(status) {
  const match = String(status ?? '').match(/\b(\d{1,3})%/);
  if (!match) return null;
  return Math.min(100, Math.max(0, Number(match[1])));
}

function questNameFromStatus(status) {
  const value = String(status ?? '');
  const running = value.match(/กำลัง(?:เตรียม)?ทำ\s+(.+)$/);
  if (running) return running[1].trim().slice(0, 160);
  const progress = value.match(/^[^:]*:?\s*(.+?)\s+\d{1,3}%$/);
  return progress?.[1]?.trim().slice(0, 160) ?? null;
}

export function syncRunnerState(job) {
  const current = getRunnerState(job.key);
  if (!current) {
    beginRunnerState({
      jobKey: job.key,
      ownerId: job.ownerId,
      accountId: job.accountId,
      username: job.username,
      mode: job.mode,
      scheduleId: job.scheduleId,
      state: RUNNER_STATE.RUNNING,
      nextActionAt: job.nextCheckAt,
      metadata: { source: 'observer' },
    });
  }

  const state = stateFromStatus(job);
  return transitionRunnerState(job.key, state, {
    accountId: job.accountId,
    username: job.username,
    questName: questNameFromStatus(job.status),
    progress: progressFromStatus(job.status),
    nextActionAt: job.nextCheckAt,
    lastError: state === RUNNER_STATE.FAILED ? String(job.status ?? '').slice(0, 500) : null,
    metadata: {
      lifecycle: job.lifecycle,
      scheduleReason: stateScheduleReason(state),
      status: String(job.status ?? '').slice(0, 500),
    },
  });
}

export function syncAllRunnerStates() {
  return listJobs().map(syncRunnerState);
}

export function startRunnerStateObserver() {
  if (observerTimer) return false;
  syncAllRunnerStates();
  observerTimer = setInterval(syncAllRunnerStates, OBSERVER_INTERVAL_MS);
  observerTimer.unref?.();
  return true;
}

export function stopRunnerStateObserver() {
  if (!observerTimer) return false;
  clearInterval(observerTimer);
  observerTimer = null;
  return true;
}
