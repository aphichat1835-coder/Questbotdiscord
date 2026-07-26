import { config } from '../config.js';
import { reportCriticalError } from '../error-reporter.js';
import {
  decryptRunnerToken,
  listScheduledRunners,
  updateScheduledRunner,
} from '../scheduled-runner-store.js';
import {
  getRunnerState,
  listRunnerStates,
  RUNNER_STATE,
  transitionRunnerState,
} from './runner-state-store.js';

const MAX_RUNNERS_PER_OWNER = 10;

function durableJobKey(row) {
  return `scheduled:${row.id}`;
}

function failDurableRestore(row, message) {
  const jobKey = durableJobKey(row);
  if (!getRunnerState(jobKey)) return;
  transitionRunnerState(jobKey, RUNNER_STATE.FAILED, {
    lastError: message,
    metadata: { stage: 'restore' },
  });
}

function recordSkippedRestore(row, message) {
  updateScheduledRunner(row.id, { lastError: message });
  failDurableRestore(row, message);
}

function failOrphanedRecoveringStates(rows) {
  const validScheduleIds = new Set(rows.map((row) => Number(row.id)));
  for (const state of listRunnerStates({ activeOnly: true, limit: 500 })) {
    if (state.state !== RUNNER_STATE.RECOVERING || state.mode !== 'scheduled') continue;
    if (validScheduleIds.has(Number(state.schedule_id))) continue;
    transitionRunnerState(state.job_key, RUNNER_STATE.FAILED, {
      lastError: 'Persisted runner state has no matching scheduled runner row',
      metadata: { stage: 'restore-reconcile' },
    });
  }
}

async function restoreRow({ row, client, startRunner, ownerCount }) {
  const token = decryptRunnerToken(row, config.runnerTokenSecret);
  await startRunner({
    jobKey: durableJobKey(row),
    ownerId: row.owner_id,
    userToken: token,
    channelId: row.channel_id,
    client,
    mode: 'scheduled',
    scheduleId: row.id,
    accountId: row.account_id,
    username: row.username,
    initialNextCheckAt: row.next_check_at,
  });
  return ownerCount + 1;
}

export async function restoreScheduledRunnerRows(client, startRunner, {
  rows = listScheduledRunners(),
} = {}) {
  failOrphanedRecoveringStates(rows);
  if (!rows.length) return { restored: 0, failed: 0 };

  if (!config.runnerTokenSecret || config.runnerTokenSecret.length < 16) {
    const message = 'Restore skipped: RUNNER_TOKEN_SECRET is unavailable or too short';
    for (const row of rows) recordSkippedRestore(row, message);
    return { restored: 0, failed: rows.length };
  }

  let restored = 0;
  let failed = 0;
  const restoredByOwner = new Map();
  const restoredAccounts = new Set();

  for (const row of rows) {
    const ownerCount = restoredByOwner.get(row.owner_id) ?? 0;
    if (ownerCount >= MAX_RUNNERS_PER_OWNER) {
      failed++;
      recordSkippedRestore(row, 'Restore skipped: owner runner limit exceeded');
      continue;
    }
    if (row.account_id && restoredAccounts.has(row.account_id)) {
      failed++;
      recordSkippedRestore(row, 'Restore skipped: Discord account already restored');
      continue;
    }

    try {
      const nextOwnerCount = await restoreRow({ row, client, startRunner, ownerCount });
      restored++;
      restoredByOwner.set(row.owner_id, nextOwnerCount);
      if (row.account_id) restoredAccounts.add(row.account_id);
    } catch (error) {
      failed++;
      const message = `Restore failed: ${error.message}`;
      updateScheduledRunner(row.id, { lastError: message });
      failDurableRestore(row, message);
      await reportCriticalError(`Restore Scheduled Runner #${row.id}`, error);
    }
  }

  console.log(`♻️ Scheduled Runners restored: ${restored}, failed: ${failed}`);
  return { restored, failed };
}
