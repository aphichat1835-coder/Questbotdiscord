import { RUNNER_STATE } from './runner-state-store.js';

export const MAX_ALL_MODE_RECOVERY_TIMER_MS = 24 * 60 * 60 * 1000;

function retryTimestamp(state) {
  const value = Date.parse(state?.next_action_at);
  return Number.isFinite(value) ? value : null;
}

export function createAllModeRecoveryController({
  readState,
  readJob,
  readScheduled,
  restore,
  currentTime = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  reportError = () => {},
} = {}) {
  for (const [name, value] of Object.entries({ readState, readJob, readScheduled, restore })) {
    if (typeof value !== 'function') throw new TypeError(`${name} callback is required`);
  }

  const timers = new Map();
  const restoring = new Set();

  function cancel(jobKey) {
    const entry = timers.get(jobKey);
    if (!entry) return false;
    clearTimer(entry.timer);
    timers.delete(jobKey);
    return true;
  }

  function eligible(context) {
    if (!context || context.mode !== 'scheduled' || context.processRole !== 'all') return null;
    if (readJob(context.jobKey)) return null;
    const state = readState(context.jobKey);
    if (state?.state !== RUNNER_STATE.WAITING_RETRY) return null;
    if (Number(state.schedule_id) !== Number(context.scheduleId)) return null;
    const row = readScheduled(context.scheduleId);
    if (!row) return null;
    const nextAt = retryTimestamp(state);
    if (nextAt == null) return null;
    return { state, row, nextAt };
  }

  async function run(context) {
    timers.delete(context.jobKey);
    const candidate = eligible(context);
    if (!candidate || restoring.has(context.jobKey)) return false;
    if (candidate.nextAt > currentTime()) {
      schedule(context);
      return false;
    }

    restoring.add(context.jobKey);
    try {
      const fresh = eligible(context);
      if (!fresh || fresh.nextAt > currentTime()) return false;
      await restore(fresh.row, context);
      return true;
    } catch (error) {
      reportError(error, context);
      return false;
    } finally {
      restoring.delete(context.jobKey);
    }
  }

  function schedule(context) {
    cancel(context?.jobKey);
    const candidate = eligible(context);
    if (!candidate) return false;
    const delay = Math.max(
      0,
      Math.min(MAX_ALL_MODE_RECOVERY_TIMER_MS, candidate.nextAt - currentTime()),
    );
    const timer = setTimer(() => {
      void run(context);
    }, delay);
    timer?.unref?.();
    timers.set(context.jobKey, { timer, context });
    return true;
  }

  function clear() {
    for (const jobKey of [...timers.keys()]) cancel(jobKey);
  }

  return Object.freeze({
    cancel,
    clear,
    isScheduled: (jobKey) => timers.has(jobKey),
    run,
    schedule,
  });
}
