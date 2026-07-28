import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyRunnerError,
  RUNNER_ERROR_CATEGORY,
} from '../src/quest/runner-state-store.js';

const cases = [
  ['abort by name', { name: 'AbortError' }, RUNNER_ERROR_CATEGORY.ABORTED],
  ['abort by message', { message: 'aborted' }, RUNNER_ERROR_CATEGORY.ABORTED],
  ['schema compatibility', { name: 'QuestCompatibilityError' }, RUNNER_ERROR_CATEGORY.SCHEMA],
  ['timeout by name', { name: 'RequestTimeoutError' }, RUNNER_ERROR_CATEGORY.TIMEOUT],
  ['timeout by code', { code: 'ETIMEDOUT' }, RUNNER_ERROR_CATEGORY.TIMEOUT],
  ['authentication 401', { status: 401 }, RUNNER_ERROR_CATEGORY.AUTH],
  ['authentication 403', { status: 403 }, RUNNER_ERROR_CATEGORY.AUTH],
  ['rate limit', { status: 429 }, RUNNER_ERROR_CATEGORY.RATE_LIMIT],
  ['API 5xx', { status: 503 }, RUNNER_ERROR_CATEGORY.API_5XX],
  ['API 4xx', { status: 404 }, RUNNER_ERROR_CATEGORY.API_4XX],
  ['SQLite storage', { code: 'SQLITE_BUSY' }, RUNNER_ERROR_CATEGORY.STORAGE],
  ['connection reset', { code: 'ECONNRESET' }, RUNNER_ERROR_CATEGORY.NETWORK],
  ['connection refused', { code: 'ECONNREFUSED' }, RUNNER_ERROR_CATEGORY.NETWORK],
  ['DNS not found', { code: 'ENOTFOUND' }, RUNNER_ERROR_CATEGORY.NETWORK],
  ['temporary DNS failure', { code: 'EAI_AGAIN' }, RUNNER_ERROR_CATEGORY.NETWORK],
  ['generic Error without HTTP status', new Error('socket closed'), RUNNER_ERROR_CATEGORY.NETWORK],
  ['unknown plain value', { code: 'OTHER' }, RUNNER_ERROR_CATEGORY.UNKNOWN],
  ['null', null, RUNNER_ERROR_CATEGORY.UNKNOWN],
];

for (const [name, error, expected] of cases) {
  test(`runner error classification: ${name}`, () => {
    assert.equal(classifyRunnerError(error), expected);
  });
}

test('abort classification takes precedence over an HTTP status', () => {
  assert.equal(
    classifyRunnerError({ name: 'AbortError', status: 503 }),
    RUNNER_ERROR_CATEGORY.ABORTED,
  );
});

test('timeout classification takes precedence over an HTTP status', () => {
  assert.equal(
    classifyRunnerError({ name: 'RequestTimeoutError', status: 503 }),
    RUNNER_ERROR_CATEGORY.TIMEOUT,
  );
});

test('HTTP classification takes precedence over a storage-shaped code', () => {
  assert.equal(
    classifyRunnerError({ status: 503, code: 'SQLITE_BUSY' }),
    RUNNER_ERROR_CATEGORY.API_5XX,
  );
});
