import './setup-env.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function source(path) {
  return readFile(new URL(path, import.meta.url), 'utf8');
}

test('api-status exposes rate-limit hardening and worker ownership counts', async () => {
  const status = await source('../src/commands/api-status.js');
  assert.match(status, /listActiveWorkerHolders/);
  assert.match(status, /listScheduledRunnerClaims/);
  assert.match(status, /knownScopes/);
  assert.match(status, /openCircuits/);
  assert.match(status, /halfOpenCircuits/);
  assert.match(status, /checkpointErrors/);
  assert.match(status, /VERIFYING_ENROLLMENT/);
  assert.match(status, /Scheduled claims/);
});

test('api-status reports distinct worker and claim totals without rendering holder identifiers', async () => {
  const status = await source('../src/commands/api-status.js');
  assert.match(status, /new Set\(listActiveWorkerHolders\(\)\)/);
  assert.match(status, /workerHolders\.size/);
  assert.match(status, /activeClaims\.length/);
  assert.doesNotMatch(status, /workerHolders\.length/);
  assert.doesNotMatch(status, /workerHolders\.join/);
  assert.doesNotMatch(status, /activeClaims\.map/);
});
