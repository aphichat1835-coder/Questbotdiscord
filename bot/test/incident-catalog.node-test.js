import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allowlistedIncidentContext,
  getIncidentDefinition,
  INCIDENT,
  listIncidentCodes,
} from '../src/incident-catalog.js';

test('every public incident code has an operational contract', () => {
  const codes = listIncidentCodes();
  assert.deepEqual(new Set(codes), new Set(Object.values(INCIDENT)));
  for (const code of codes) {
    const definition = getIncidentDefinition(code);
    assert.ok(definition.title.length >= 5);
    assert.ok(definition.impact.length >= 10);
    assert.ok(definition.action.length >= 10);
    assert.ok(Array.isArray(definition.context));
  }
});

test('incident context only keeps explicitly allowed values', () => {
  const context = allowlistedIncidentContext(INCIDENT.BACKUP_PROTECTION_LOST, {
    consecutiveFailures: 3,
    lastSuccessAt: '2026-07-25T00:00:00.000Z',
    backupAgeHours: 27,
    storageMode: 'persistent-candidate',
    unapprovedField: 'must-not-survive',
    nested: { internalValue: 'must-not-survive' },
  });

  assert.deepEqual(context, {
    consecutiveFailures: 3,
    lastSuccessAt: '2026-07-25T00:00:00.000Z',
    backupAgeHours: 27,
    storageMode: 'persistent-candidate',
  });
  assert.doesNotMatch(JSON.stringify(context), /must-not-survive/);
});

test('unknown incident codes fail closed', () => {
  assert.throws(() => getIncidentDefinition('UNKNOWN_CODE'), /Unknown incident code/);
  assert.throws(() => allowlistedIncidentContext('UNKNOWN_CODE', {}), /Unknown incident code/);
});
