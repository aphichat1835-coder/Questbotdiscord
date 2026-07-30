from __future__ import annotations

import json
from pathlib import Path


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    source = path.read_text(encoding='utf-8')
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one target, found {count}')
    path.write_text(source.replace(old, new, 1), encoding='utf-8')


observer = Path('bot/src/quest/runner-state-observer.js')
replace_once(
    observer,
    """const HIGH_PRIORITY_WAITING_STATES = new Set([\n  RUNNER_STATE.WAITING_ENROLLMENT,\n  RUNNER_STATE.WAITING_RATE_LIMIT,\n]);\nconst CONTROLLED_STATES = new Set([\n""",
    """const HIGH_PRIORITY_WAITING_STATES = new Set([\n  RUNNER_STATE.WAITING_ENROLLMENT,\n  RUNNER_STATE.WAITING_RATE_LIMIT,\n]);\nconst ACTIVE_MUTATION_STATUSES = new Set([\n  RUNNER_MUTATION_STATUS.PREPARED,\n  RUNNER_MUTATION_STATUS.IN_FLIGHT,\n  RUNNER_MUTATION_STATUS.ACCEPTED,\n  RUNNER_MUTATION_STATUS.UNCERTAIN,\n]);\nconst CONTROLLED_STATES = new Set([\n""",
    'runner observer active mutation set',
)
replace_once(
    observer,
    """function hasActiveMutationCheckpoint(current) {\n  return Boolean(\n    current?.mutation_status\n    && ![RUNNER_MUTATION_STATUS.NONE, RUNNER_MUTATION_STATUS.VERIFIED].includes(\n      current.mutation_status,\n    ),\n  );\n}\n""",
    """function hasActiveMutationCheckpoint(current) {\n  return ACTIVE_MUTATION_STATUSES.has(current?.mutation_status);\n}\n""",
    'runner observer failed checkpoint handling',
)

runner = Path('bot/src/discord-runner.js')
replace_once(
    runner,
    """      return {\n        attempted: false,\n        progressed: false,\n        supportedCount: 0,\n        transientError: true,\n      };\n""",
    """      return {\n        attempted: false,\n        progressed: false,\n        supportedCount: 0,\n        transientError: true,\n        retryError: error,\n      };\n""",
    'runner transient error propagation',
)
replace_once(
    runner,
    """  async function waitForTransientErrorRetry(attempt) {\n    const delayMs = transientRetryDelayMs(attempt);\n    nextCheckAt = new Date(Date.now() + delayMs).toISOString();\n    persistSchedule({ nextCheckAt });\n    addLog(`🌐 ${username}: NETWORK RETRY — อีก ${Math.round(delayMs / 60_000)} นาที`);\n""",
    """  async function waitForTransientErrorRetry(attempt, error) {\n    const delayMs = transientRetryDelayMs(attempt);\n    nextCheckAt = new Date(Date.now() + delayMs).toISOString();\n    persistSchedule({ nextCheckAt });\n    transitionCurrentRunner(RUNNER_STATE.WAITING_RETRY, {\n      nextActionAt: nextCheckAt,\n      lastError: error?.message ?? String(error ?? 'transient runner error'),\n    });\n    addLog(`🌐 ${username}: NETWORK RETRY — อีก ${Math.round(delayMs / 60_000)} นาที`);\n""",
    'runner durable retry deadline persistence',
)
replace_once(
    runner,
    """        transientErrorAttempts = await waitForTransientErrorRetry(transientErrorAttempts);\n""",
    """        transientErrorAttempts = await waitForTransientErrorRetry(\n          transientErrorAttempts,\n          outcome.retryError,\n        );\n""",
    'runner retry error forwarding',
)

test_file = Path('bot/test/runner-state-wait-observer.node-test.js')
replace_once(
    test_file,
    """  getRunnerState,\n  prepareRunnerMutation,\n  RUNNER_MUTATION_KIND,\n""",
    """  getRunnerState,\n  markRunnerMutationFailed,\n  prepareRunnerMutation,\n  RUNNER_MUTATION_KIND,\n""",
    'wait observer test imports',
)
append = r'''

test('failed mutation accepts and preserves the live runner retry deadline', () => {
  const jobKey = 'scheduled:observer-failed-mutation-retry';
  const nextCheckAt = '2030-01-01T00:05:00.000Z';
  beginRunnerState({
    jobKey,
    ownerId: 'wait-owner',
    mode: 'scheduled',
    scheduleId: 71,
  });
  prepareRunnerMutation(jobKey, {
    kind: RUNNER_MUTATION_KIND.VIDEO_PROGRESS,
    questId: 'wait-quest',
    payload: { timestamp: 10 },
  });
  markRunnerMutationFailed(jobKey, Object.assign(new Error('bad request'), { status: 400 }));

  syncRunnerState(job(jobKey, '🌐 wait-user: NETWORK RETRY — อีก 5 นาที', nextCheckAt));
  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.WAITING_RETRY);
  assert.equal(state.mutation_status, 'FAILED');
  assert.equal(state.next_action_at, nextCheckAt);
  assert.equal(state.state_source, 'legacy-observer');
});

test('failed mutation no longer blocks the next durable daily schedule', () => {
  const jobKey = 'scheduled:observer-failed-mutation-daily';
  const nextCheckAt = '2030-01-01T08:00:00.000Z';
  beginRunnerState({
    jobKey,
    ownerId: 'wait-owner',
    mode: 'scheduled',
    scheduleId: 71,
  });
  prepareRunnerMutation(jobKey, {
    kind: RUNNER_MUTATION_KIND.HEARTBEAT,
    questId: 'wait-quest',
    payload: { terminal: false },
  });
  markRunnerMutationFailed(jobKey, Object.assign(new Error('bad request'), { status: 400 }));

  syncRunnerState(job(jobKey, '💤 wait-user: AUTO DAILY ACTIVE', nextCheckAt));
  const state = getRunnerState(jobKey);
  assert.equal(state.state, RUNNER_STATE.WAITING_SCHEDULE);
  assert.equal(state.mutation_status, 'FAILED');
  assert.equal(state.next_action_at, nextCheckAt);
  assert.equal(state.metadata.scheduleReason, 'baseline');
});
'''
source = test_file.read_text(encoding='utf-8')
if "failed mutation accepts and preserves the live runner retry deadline" in source:
    raise SystemExit('wait observer integration tests already exist')
test_file.write_text((source.rstrip() + append).rstrip() + '\n', encoding='utf-8')

filter_script = Path('bot/scripts/filter-lcov-source.mjs')
if filter_script.exists():
    raise SystemExit('source-only LCOV filter already exists unexpectedly')
filter_script.write_text(r'''#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const [inputPath = 'coverage/lcov.raw.info', outputPath = 'coverage/lcov.info'] = process.argv.slice(2);
const raw = await readFile(inputPath, 'utf8');
const records = raw
  .split('end_of_record')
  .map((record) => record.trim())
  .filter(Boolean);

function sourcePath(record) {
  const line = record.split('\n').find((entry) => entry.startsWith('SF:'));
  return line?.slice(3).replaceAll('\\', '/') ?? '';
}

function isSourceRecord(record) {
  const file = sourcePath(record);
  const normalized = path.posix.normalize(file);
  return normalized.startsWith('src/') || normalized.includes('/src/');
}

function metric(record, name) {
  const line = record.split('\n').find((entry) => entry.startsWith(`${name}:`));
  return Number(line?.slice(name.length + 1) ?? 0);
}

function percent(hit, found) {
  return found > 0 ? `${((hit / found) * 100).toFixed(2)}%` : 'n/a';
}

const selected = records.filter(isSourceRecord);
if (selected.length === 0) {
  throw new Error(`No src coverage records found in ${inputPath}`);
}

await writeFile(outputPath, `${selected.join('\nend_of_record\n')}\nend_of_record\n`, 'utf8');

const totals = selected.reduce((result, record) => ({
  linesFound: result.linesFound + metric(record, 'LF'),
  linesHit: result.linesHit + metric(record, 'LH'),
  branchesFound: result.branchesFound + metric(record, 'BRF'),
  branchesHit: result.branchesHit + metric(record, 'BRH'),
  functionsFound: result.functionsFound + metric(record, 'FNF'),
  functionsHit: result.functionsHit + metric(record, 'FNH'),
}), {
  linesFound: 0,
  linesHit: 0,
  branchesFound: 0,
  branchesHit: 0,
  functionsFound: 0,
  functionsHit: 0,
});

console.log(`Source-only LCOV: ${selected.length} files`);
console.log(`Source-only lines: ${totals.linesHit}/${totals.linesFound} (${percent(totals.linesHit, totals.linesFound)})`);
console.log(`Source-only branches: ${totals.branchesHit}/${totals.branchesFound} (${percent(totals.branchesHit, totals.branchesFound)})`);
console.log(`Source-only functions: ${totals.functionsHit}/${totals.functionsFound} (${percent(totals.functionsHit, totals.functionsFound)})`);
''', encoding='utf-8')

package_path = Path('bot/package.json')
package_data = json.loads(package_path.read_text(encoding='utf-8'))
old_coverage = package_data['scripts']['test:coverage']
expected = "mkdir -p coverage && node --import ./test/setup-env.js --test --test-concurrency=1 --experimental-test-coverage --test-coverage-lines=60 --test-reporter=spec --test-reporter=lcov --test-reporter-destination=stdout --test-reporter-destination=coverage/lcov.info"
if old_coverage != expected:
    raise SystemExit(f'unexpected test:coverage command: {old_coverage}')
package_data['scripts']['test:coverage'] = (
    "rm -f coverage/lcov.raw.info coverage/lcov.info && mkdir -p coverage && "
    "node --import ./test/setup-env.js --test --test-concurrency=1 --experimental-test-coverage "
    "--test-coverage-lines=60 --test-reporter=spec --test-reporter=lcov "
    "--test-reporter-destination=stdout --test-reporter-destination=coverage/lcov.raw.info && "
    "node scripts/filter-lcov-source.mjs coverage/lcov.raw.info coverage/lcov.info && "
    "rm coverage/lcov.raw.info"
)
package_path.write_text(json.dumps(package_data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
