import {
  getJob,
  getUserJobs,
  stopJob as stopJobImmediately,
  stopScheduledJob as stopScheduledJobImmediately,
} from './discord-runner.js';

const DEFAULT_STOP_TIMEOUT_MS = 15_000;
const stoppingAccounts = new Set();
const stoppingJobs = new Map();

function accountKey(ownerId, accountId) {
  return accountId ? `${ownerId}:${accountId}` : null;
}

function result(accepted, cleanupComplete) {
  return { accepted, cleanupComplete };
}

async function waitForCompletion(completion, timeoutMs) {
  if (!completion || typeof completion.then !== 'function') return true;
  let timeout;
  try {
    return await Promise.race([
      completion.then(() => true),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function trackStoppingJob(jobKey, key, done) {
  const completion = Promise.resolve(done)
    .catch(() => {})
    .finally(() => {
      stoppingJobs.delete(jobKey);
      if (key) stoppingAccounts.delete(key);
    });
  stoppingJobs.set(jobKey, completion);
  return completion;
}

export function summarizeStopResults(results) {
  const accepted = results.filter((item) => item.accepted).length;
  const completed = results.filter((item) => item.accepted && item.cleanupComplete).length;
  return {
    accepted,
    completed,
    pending: accepted - completed,
  };
}

export function isAccountStopping(ownerId, accountId) {
  const key = accountKey(ownerId, accountId);
  return key ? stoppingAccounts.has(key) : false;
}

export function listStoppingAccounts(ownerId) {
  const prefix = `${ownerId}:`;
  return [...stoppingAccounts]
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
}

export async function stopJobAndWait(ownerId, jobKey, {
  removeSchedule = true,
  timeoutMs = DEFAULT_STOP_TIMEOUT_MS,
} = {}) {
  const existingCompletion = stoppingJobs.get(jobKey);
  if (existingCompletion) {
    return result(true, await waitForCompletion(existingCompletion, timeoutMs));
  }

  const job = getJob(jobKey);
  if (!job || job.ownerId !== ownerId) return result(false, false);
  const key = accountKey(ownerId, job.accountId);
  if (key) stoppingAccounts.add(key);

  const completion = trackStoppingJob(jobKey, key, job.done);
  const stopped = stopJobImmediately(ownerId, jobKey, { removeSchedule });
  if (!stopped) {
    stoppingJobs.delete(jobKey);
    if (key) stoppingAccounts.delete(key);
    return result(false, false);
  }

  // The caller may stop waiting after the timeout, but the account stays blocked
  // until job.done settles and the real cleanup finishes.
  return result(true, await waitForCompletion(completion, timeoutMs));
}

export async function stopScheduledJobAndWaitDetailed(ownerId, scheduleId, {
  timeoutMs = DEFAULT_STOP_TIMEOUT_MS,
} = {}) {
  const jobKey = `scheduled:${scheduleId}`;
  const job = getJob(jobKey);
  if (!job) {
    const removed = stopScheduledJobImmediately(ownerId, scheduleId);
    return result(removed, removed);
  }
  return stopJobAndWait(ownerId, jobKey, { removeSchedule: true, timeoutMs });
}

export async function stopScheduledJobAndWait(ownerId, scheduleId, options = {}) {
  return (await stopScheduledJobAndWaitDetailed(ownerId, scheduleId, options)).accepted;
}

export async function stopAllForUserAndWaitDetailed(ownerId, {
  mode = null,
  removeSchedule = true,
  timeoutMs = DEFAULT_STOP_TIMEOUT_MS,
} = {}) {
  const jobs = getUserJobs(ownerId, { mode, includeStopping: true });
  const results = await Promise.all(jobs.map((job) => stopJobAndWait(ownerId, job.key, {
    removeSchedule,
    timeoutMs,
  })));
  return summarizeStopResults(results);
}

export async function stopAllForUserAndWait(ownerId, options = {}) {
  return (await stopAllForUserAndWaitDetailed(ownerId, options)).accepted;
}

export async function stopRunnerAndWaitDetailed(ownerId, options = {}) {
  return stopAllForUserAndWaitDetailed(ownerId, options);
}

export async function stopRunnerAndWait(ownerId, options = {}) {
  return (await stopRunnerAndWaitDetailed(ownerId, options)).accepted > 0;
}
