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

async function waitForJobDone(done, timeoutMs) {
  if (!done || typeof done.then !== 'function') return;
  let timeout;
  try {
    await Promise.race([
      done,
      new Promise((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
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
  if (stoppingJobs.has(jobKey)) return stoppingJobs.get(jobKey);

  const job = getJob(jobKey);
  if (!job || job.ownerId !== ownerId) return false;
  const key = accountKey(ownerId, job.accountId);
  if (key) stoppingAccounts.add(key);

  const operation = (async () => {
    const done = job.done;
    const stopped = stopJobImmediately(ownerId, jobKey, { removeSchedule });
    if (!stopped) return false;
    await waitForJobDone(done, timeoutMs);
    return true;
  })().finally(() => {
    stoppingJobs.delete(jobKey);
    if (key) stoppingAccounts.delete(key);
  });

  stoppingJobs.set(jobKey, operation);
  return operation;
}

export async function stopScheduledJobAndWait(ownerId, scheduleId, options = {}) {
  const jobKey = `scheduled:${scheduleId}`;
  const job = getJob(jobKey);
  if (!job) return stopScheduledJobImmediately(ownerId, scheduleId);

  if (stoppingJobs.has(jobKey)) return stoppingJobs.get(jobKey);
  const key = accountKey(ownerId, job.accountId);
  if (key) stoppingAccounts.add(key);

  const operation = (async () => {
    const done = job.done;
    const stopped = stopScheduledJobImmediately(ownerId, scheduleId);
    if (!stopped) return false;
    await waitForJobDone(done, options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
    return true;
  })().finally(() => {
    stoppingJobs.delete(jobKey);
    if (key) stoppingAccounts.delete(key);
  });

  stoppingJobs.set(jobKey, operation);
  return operation;
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
