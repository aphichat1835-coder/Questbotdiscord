import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBootstrapIncidentPayload } from '../src/bootstrap-reporter.js';
import { INCIDENT } from '../src/incident-catalog.js';
import { redactSensitive } from '../src/error-reporter.js';

test('runtime redaction bounds large input before returning output', () => {
  const redacted = redactSensitive(`apiToken=hidden ${'x'.repeat(500_000)}`);

  assert.ok(redacted.length <= 8000);
  assert.match(redacted, /^apiToken=\[REDACTED\]/);
  assert.doesNotMatch(redacted, /hidden/);
});

test('bootstrap payload bounds and redacts large error messages', () => {
  const payload = buildBootstrapIncidentPayload({
    code: INCIDENT.CLIENT_STARTUP_FAILED,
    error: new Error(`databasePassword=hidden ${'x'.repeat(500_000)}`),
  });
  const serialized = JSON.stringify(payload);

  assert.ok(payload.embeds[0].description.length <= 4096);
  assert.match(serialized, /databasePassword=\[REDACTED\]/);
  assert.doesNotMatch(serialized, /databasePassword=hidden/);
});
