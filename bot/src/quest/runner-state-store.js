import { db } from '../db.js';

export const RUNNER_STATE = Object.freeze({
  QUEUED: 'QUEUED',
  AUTHENTICATING: 'AUTHENTICATING',
  FETCHING_QUESTS: 'FETCHING_QUESTS',
  ENROLLING: 'ENROLLING',
  RUNNING_PROGRESS: 'RUNNING_PROGRESS',
  VERIFYING_PROGRESS: 'VERIFYING_PROGRESS',
  VERIFYING_COMPLETION: 'VERIFYING_COMPLETION',
  CLAIMING: 'CLAIMING',
  VERIFYING_CLAIM: 'VERIFYING_CLAIM',
  WAITING_RATE_LIMIT: 'WAITING_RATE_LIMIT',
  WAITING_ENROLLMENT: 'WAITING_ENROLLMENT',
  WAITING_RETRY: 'WAITING_RETRY',
  WAITING_SCHEDULE: 'WAITING_SCHEDULE',
  RECOVERING: 'RECOVERING',
  RUNNING: 'RUNNING',
  STOPPING: 'STOPPING',
  STOPPED: 'STOPPED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
});

const VALID_STATES = new Set(Object.values(RUNNER_STATE));
const TERMINAL_STATES = new Set([
  RUNNER_STATE.STOPPED,
  RUNNER_STATE.COMPLETED,
  RUNNER_STATE.FAILED,
]);
const ACTIVE_STATES = [...VALID_STATES].filter((state) => !TERMINAL_STATES.has(state));
const ACTIVE_STATE_PLACEHOLDERS = ACTIVE_STATES.map(() => '?').join(', ');

function assertState(state) {
  if (!VALID_STATES.has(state)) throw new Error(`Unknown durable runner state: ${state}`);
}

function json(value) {
  return value == null ? null : JSON.stringify(value);
}

function parseMetadata(row) {
  if (!row) return null;
  let metadata = null;
  try {
    metadata = row.metadata_json ? JSON.parse(row.metadata_json) : null;
  } catch {
    metadata = { invalidMetadata: true };
  }
  return { ...row, metadata };
}

function optionOrCurrent(options, optionName, current, columnName, fallback = null) {
  if (Object.hasOwn(options, optionName)) return options[optionName];
  return current?.[columnName] ?? fallback;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS runner_states (
    job_key          TEXT PRIMARY KEY,
    owner_id         TEXT NOT NULL,
    account_id       TEXT,
    username         TEXT,
    mode             TEXT NOT NULL,
    schedule_id      INTEGER,
    state            TEXT NOT NULL,
    quest_id         TEXT,
    quest_name       TEXT,
    progress         REAL,
    next_action_at   TEXT,
    retry_count      INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT,
    metadata_json    TEXT,
    started_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_runner_states_owner
    ON runner_states(owner_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_runner_states_state
    ON runner_states(state, next_action_at);
`);

const upsertRunnerState = db.prepare(`
  INSERT INTO runner_states (
    job_key, owner_id, account_id, username, mode, schedule_id, state,
    quest_id, quest_name, progress, next_action_at, retry_count,
    last_error, metadata_json, completed_at
  ) VALUES (
    @jobKey, @ownerId, @accountId, @username, @mode, @scheduleId, @state,
    @questId, @questName, @progress, @nextActionAt, @retryCount,
    @lastError, @metadataJson, @completedAt
  )
  ON CONFLICT(job_key) DO UPDATE SET
    owner_id = excluded.owner_id,
    account_id = COALESCE(excluded.account_id, runner_states.account_id),
    username = COALESCE(excluded.username, runner_states.username),
    mode = excluded.mode,
    schedule_id = COALESCE(excluded.schedule_id, runner_states.schedule_id),
    state = excluded.state,
    quest_id = excluded.quest_id,
    quest_name = excluded.quest_name,
    progress = excluded.progress,
    next_action_at = excluded.next_action_at,
    retry_count = excluded.retry_count,
    last_error = excluded.last_error,
    metadata_json = excluded.metadata_json,
    completed_at = excluded.completed_at,
    updated_at = datetime('now')
`);

export function beginRunnerState({
  jobKey,
  ownerId,
  accountId = null,
  username = null,
  mode,
  scheduleId = null,
  state = RUNNER_STATE.QUEUED,
  nextActionAt = null,
  metadata = null,
}) {
  assertState(state);
  upsertRunnerState.run({
    jobKey,
    ownerId,
    accountId,
    username,
    mode,
    scheduleId,
    state,
    questId: null,
    questName: null,
    progress: null,
    nextActionAt,
    retryCount: 0,
    lastError: null,
    metadataJson: json(metadata),
    completedAt: TERMINAL_STATES.has(state) ? new Date().toISOString() : null,
  });
  return getRunnerState(jobKey);
}

export function transitionRunnerState(jobKey, state, options = {}) {
  assertState(state);
  const current = getRunnerState(jobKey);
  const ownerId = optionOrCurrent(options, 'ownerId', current, 'owner_id');
  const mode = optionOrCurrent(options, 'mode', current, 'mode');
  if (!current && (!ownerId || !mode)) {
    throw new Error(`Runner state ${jobKey} does not exist and cannot be created implicitly`);
  }

  upsertRunnerState.run({
    jobKey,
    ownerId,
    accountId: optionOrCurrent(options, 'accountId', current, 'account_id'),
    username: optionOrCurrent(options, 'username', current, 'username'),
    mode,
    scheduleId: optionOrCurrent(options, 'scheduleId', current, 'schedule_id'),
    state,
    questId: optionOrCurrent(options, 'questId', current, 'quest_id'),
    questName: optionOrCurrent(options, 'questName', current, 'quest_name'),
    progress: optionOrCurrent(options, 'progress', current, 'progress'),
    nextActionAt: optionOrCurrent(options, 'nextActionAt', current, 'next_action_at'),
    retryCount: optionOrCurrent(options, 'retryCount', current, 'retry_count', 0),
    lastError: optionOrCurrent(options, 'lastError', current, 'last_error'),
    metadataJson: json(optionOrCurrent(options, 'metadata', current, 'metadata')),
    completedAt: TERMINAL_STATES.has(state) ? new Date().toISOString() : null,
  });
  return getRunnerState(jobKey);
}

export function getRunnerState(jobKey) {
  return parseMetadata(db.prepare(
    'SELECT * FROM runner_states WHERE job_key = ?',
  ).get(jobKey));
}

export function listRunnerStates({ ownerId = null, activeOnly = false, limit = 100 } = {}) {
  const clauses = [];
  const params = [];
  if (ownerId) {
    clauses.push('owner_id = ?');
    params.push(ownerId);
  }
  if (activeOnly) {
    clauses.push(`state IN (${ACTIVE_STATE_PLACEHOLDERS})`);
    params.push(...ACTIVE_STATES);
  }
  params.push(Math.max(1, Math.min(500, limit)));
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT * FROM runner_states
    ${where}
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(...params).map(parseMetadata);
}

export function markInterruptedRunnerStates(now = new Date(), { includeOneShot = true } = {}) {
  const nextActionAt = now.toISOString();
  const completedAt = now.toISOString();
  const markScheduled = db.prepare(`
    UPDATE runner_states
    SET state = ?,
        next_action_at = ?,
        completed_at = NULL,
        last_error = 'Process restarted before the previous lifecycle completed',
        updated_at = datetime('now')
    WHERE mode = 'scheduled'
      AND state IN (${ACTIVE_STATE_PLACEHOLDERS})
  `);
  const failOneShot = db.prepare(`
    UPDATE runner_states
    SET state = ?,
        next_action_at = NULL,
        completed_at = ?,
        last_error = 'Process restarted; one-shot runners cannot be restored',
        updated_at = datetime('now')
    WHERE mode != 'scheduled'
      AND state IN (${ACTIVE_STATE_PLACEHOLDERS})
  `);
  const reconcile = db.transaction(() => {
    const scheduled = markScheduled.run(
      RUNNER_STATE.RECOVERING,
      nextActionAt,
      ...ACTIVE_STATES,
    ).changes;
    if (!includeOneShot) return scheduled;
    const oneShot = failOneShot.run(
      RUNNER_STATE.FAILED,
      completedAt,
      ...ACTIVE_STATES,
    ).changes;
    return scheduled + oneShot;
  });
  return reconcile();
}

export function pruneRunnerStates({ retentionDays = 30, keepLatest = 500 } = {}) {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  db.prepare(`
    DELETE FROM runner_states
    WHERE state IN (?, ?, ?)
      AND completed_at IS NOT NULL
      AND completed_at < ?
  `).run(RUNNER_STATE.STOPPED, RUNNER_STATE.COMPLETED, RUNNER_STATE.FAILED, cutoff);

  const stale = db.prepare(`
    SELECT job_key FROM runner_states
    WHERE state IN (?, ?, ?)
    ORDER BY updated_at DESC
    LIMIT -1 OFFSET ?
  `).all(RUNNER_STATE.STOPPED, RUNNER_STATE.COMPLETED, RUNNER_STATE.FAILED, keepLatest);
  const remove = db.prepare('DELETE FROM runner_states WHERE job_key = ?');
  const transaction = db.transaction((rows) => rows.forEach((row) => remove.run(row.job_key)));
  transaction(stale);
  return stale.length;
}

export function clearRunnerStatesForTests() {
  db.prepare('DELETE FROM runner_states').run();
}
