import { listJobs } from '../discord-runner.js';
import {
  beginRunnerState,
  getRunnerState,
  RUNNER_STATE,
  transitionRunnerState,
} from './runner-state-store.js';
import { stateScheduleReason } from './smart-scheduler.js';

const OBSERVER_INTERVAL_MS = 1000;
const SMART_WAKE_STATES = new Set([
  RUNNER_STATE.WAITING_RATE_LIMIT,
  RUNNER_STATE.WAITING_ENROLLMENT,
  RUNNER_STATE.WAITING_RETRY,
  RUNNER_STATE.CLAIMING,
  RUNNER_STATE.VERIFYING_PROGRESS,
  RUNNER_STATE.VERIFYING_COMPLETION,
  RUNNER_STATE.VERIFYING_CLAIM,
]);
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

function observedTransition(job, current, observedState) {
  const preserveSmartWake = Boolean(
    current
    && SMART_WAKE_STATES.has(current.state)
    && observedState === RUNNER_STATE.WAITING_SCHEDULE,
  );
  const state = preserveSmartWake ? current.state : observedState;
  const questName = questNameFromStatus(job.status);
  const progress = progressFromStatus(job.status);
  const metadata = preserveSmartWake
    ? {
        ...(current.metadata ?? {}),
        lifecycle: job.lifecycle,
        status: String(job.status ?? '').slice(0, 500),
      }
    : {
        lifecycle: job.lifecycle,
        scheduleReason: stateScheduleReason(state),
        status: String(job.status ?? '').slice(0, 500),
      };

  return {
    state,
    values: {
      ...(job.accountId != null ? { accountId: job.accountId } : {}),
      ...(job.username != null ? { username: job.username } : {}),
      ...(questName != null ? { questName } : {}),
      ...(progress != null ? { progress } : {}),
      nextActionAt: preserveSmartWake ? current.next_action_at : job.nextCheckAt,
      lastError: state === RUNNER_STATE.FAILED
        ? String(job.status ?? '').slice(0, 500)
        : null,
      metadata,
    },
  };
}

export function syncRunnerState(job) {
  let current = getRunnerState(job.key);
  if (!current && (!job.ownerId || !job.mode)) return null;
  if (!current) {
    current = beginRunnerState({
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

  const transition = observedTransition(job, current, stateFromStatus(job));
  return transitionRunnerState(job.key, transition.state, transition.values);
}

export function syncAllRunnerStates() {
  return listJobs().flatMap((job) => {
    try {
      const result = syncRunnerState(job);
      return result ? [result] : [];
    } catch (error) {
      console.error(
        `[RunnerState:${String(job.key).slice(0, 100)}] sync failed — ${error?.message ?? 'unknown error'}`,
      );
      return [];
    }
  });
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
