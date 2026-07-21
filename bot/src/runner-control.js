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
    await waitForCompletion(existingCompletion, timeoutMs);
    return true;
  }

  const job = getJob(jobKey);
  if (!job || job.ownerId !== ownerId) return false;
  const key = accountKey(ownerId, job.accountId);
  if (key) stoppingAccounts.add(key);

  const completion = trackStoppingJob(jobKey, key, job.done);
  const stopped = stopJobImmediately(ownerId, jobKey, { removeSchedule });
  if (!stopped) {
    stoppingJobs.delete(jobKey);
    if (key) stoppingAccounts.delete(key);
    return false;
  }

  // Interaction replies stop waiting after the timeout, but the account remains
  // blocked until job.done actually settles and the real cleanup finishes.
  await waitForCompletion(completion, timeoutMs);
  return true;
}

export async function stopScheduledJobAndWait(ownerId, scheduleId, {
  timeoutMs = DEFAULT_STOP_TIMEOUT_MS,
} = {}) {
  const jobKey = `scheduled:${scheduleId}`;
  const job = getJob(jobKey);
  if (!job) return stopScheduledJobImmediately(ownerId, scheduleId);
  return stopJobAndWait(ownerId, jobKey, { removeSchedule: true, timeoutMs });
}

export async function stopAllForUserAndWait(ownerId, {
  mode = null,
  removeSchedule = true,
  timeoutMs = DEFAULT_STOP_TIMEOUT_MS,
} = {}) {
  const jobs = getUserJobs(ownerId, { mode });
  const results = await Promise.all(jobs.map((job) => stopJobAndWait(ownerId, job.key, {
    removeSchedule,
    timeoutMs,
  })));
  return results.filter(Boolean).length;
}

export async function stopRunnerAndWait(ownerId, options = {}) {
  return (await stopAllForUserAndWait(ownerId, options)) > 0;
}
