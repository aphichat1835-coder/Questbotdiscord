import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBootstrapIncidentPayload } from '../src/bootstrap-reporter.js';
import { INCIDENT } from '../src/incident-catalog.js';
import { isPersistentDatabasePath } from '../src/storage-profile.js';
import { executeDiscordWebhook } from '../src/webhook-delivery.js';
import { createFakeDiscordWebhookUrl } from '../test-support/fake-webhook.js';

process.env.DISCORD_BOT_TOKEN ??= 'review-regression-test-bot-token';
process.env.DISCORD_CLIENT_ID ??= '12345678901234567';
process.env.DISCORD_GUILD_ID ??= '22345678901234567';
process.env.OWNER_ID ??= '32345678901234567';
process.env.RUNNER_TOKEN_SECRET ??= 'review-regression-test-secret-32-characters';
process.env.LOG_WEBHOOK_URL ??= createFakeDiscordWebhookUrl('review-regressions');
process.env.QUESTBOT_TEST_MODE = 'true';
process.env.ALLOW_TEST_WEBHOOK = 'true';

const {
  buildIncidentWebhookPayload,
  getIncidentReporterStatus,
  reportIncident,
  reportRecovery,
  resetIncidentReporterStateForTests,
} = await import('../src/error-reporter.js');

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
console.error = () => {};

function deferred() {
  let resolve;
  const promise = new Promise((resolver) => { resolve = resolver; });
  return { promise, resolve };
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  resetIncidentReporterStateForTests();
});

test.after(() => {
  console.error = originalConsoleError;
  delete process.env.ALLOW_TEST_WEBHOOK;
});

test('runtime and bootstrap outbound payloads disable every Discord mention parse target', () => {
  const runtimePayload = buildIncidentWebhookPayload({
    code: INCIDENT.HEALTH_SERVER_BIND_FAILED,
    error: new Error('@everyone must stay inert'),
  });
  const bootstrapPayload = buildBootstrapIncidentPayload({
    code: INCIDENT.CLIENT_STARTUP_FAILED,
    error: new Error('@everyone must stay inert'),
  });

  assert.deepEqual(runtimePayload.allowed_mentions, { parse: [] });
  assert.deepEqual(bootstrapPayload.allowed_mentions, { parse: [] });
});

test('terminal non-OK webhook responses are drained before returning', async () => {
  let drained = 0;
  const result = await executeDiscordWebhook({
    url: createFakeDiscordWebhookUrl('terminal-drain'),
    payload: { content: 'test' },
    maxAttempts: 1,
    fetchFn: async () => ({
      ok: false,
      status: 400,
      headers: { get: () => null },
      arrayBuffer: async () => { drained++; },
    }),
  });

  assert.equal(result.state, 'permanent_failure');
  assert.equal(drained, 1);
});

test('a new failure during recovery_pending reuses the original incident identity', async () => {
  let request = 0;
  globalThis.fetch = async () => {
    request++;
    return new Response(null, { status: request === 2 ? 400 : 204 });
  };
  const base = Date.now();

  const opened = await reportIncident({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    error: new Error('backup unavailable'),
    scope: 'backup:primary',
    now: base,
  });
  const recovery = await reportRecovery({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    scope: 'backup:primary',
    now: base + 1_000,
  });
  const reopened = await reportIncident({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    error: new Error('backup failed again'),
    scope: 'backup:primary',
    now: base + 2_000,
  });

  assert.equal(opened.state, 'delivered');
  assert.equal(recovery.state, 'permanent_failure');
  assert.equal(reopened.state, 'delivered');
  assert.equal(reopened.incidentId, opened.incidentId);
  assert.equal(reopened.occurrences, 2);
  assert.equal(request, 3);
});

test('duplicate recovery calls do not inflate failure occurrence or suppression counters', async () => {
  globalThis.fetch = async () => new Response(null, { status: 204 });
  const base = Date.now();
  const opened = await reportIncident({
    code: INCIDENT.HEALTH_SERVER_BIND_FAILED,
    error: new Error('EADDRINUSE'),
    scope: 'health:10000',
    now: base,
  });

  const pendingResponse = deferred();
  globalThis.fetch = async () => pendingResponse.promise;
  const recoveryPromise = reportRecovery({
    code: INCIDENT.HEALTH_SERVER_BIND_FAILED,
    scope: 'health:10000',
    now: base + 1_000,
  });
  await Promise.resolve();

  const before = getIncidentReporterStatus();
  const duplicate = await reportRecovery({
    code: INCIDENT.HEALTH_SERVER_BIND_FAILED,
    scope: 'health:10000',
    now: base + 1_001,
  });
  const during = getIncidentReporterStatus();

  assert.equal(duplicate.state, 'recovery_in_progress');
  assert.equal(duplicate.incidentId, opened.incidentId);
  assert.equal(during.suppressedIncidents, before.suppressedIncidents);

  pendingResponse.resolve(new Response(null, { status: 204 }));
  const recovered = await recoveryPromise;
  assert.equal(recovered.state, 'delivered');
});

test('unrecovered open incidents expire after the absolute maximum age', async () => {
  globalThis.fetch = async () => new Response(null, { status: 204 });
  const base = Date.now();
  const first = await reportIncident({
    code: INCIDENT.HEALTH_SERVER_BIND_FAILED,
    error: new Error('first failure'),
    scope: 'health:old',
    now: base,
  });

  const afterMaximumAge = base + (31 * 24 * 60 * 60_000);
  await reportIncident({
    code: INCIDENT.HEALTH_SERVER_BIND_FAILED,
    error: new Error('prune trigger'),
    scope: 'health:new',
    now: afterMaximumAge,
  });
  const replacement = await reportIncident({
    code: INCIDENT.HEALTH_SERVER_BIND_FAILED,
    error: new Error('old scope failed again'),
    scope: 'health:old',
    now: afterMaximumAge + 1,
  });

  assert.notEqual(replacement.incidentId, first.incidentId);
  assert.equal(replacement.occurrences, 1);
});

test('settled incident state remains capped when caller-controlled scopes keep changing', async () => {
  globalThis.fetch = async () => new Response(null, { status: 204 });
  const base = Date.now();

  for (let index = 0; index < 270; index++) {
    const result = await reportIncident({
      code: INCIDENT.HEALTH_SERVER_BIND_FAILED,
      error: new Error(`failure ${index}`),
      scope: `caller-scope-${index}`,
      now: base + index,
      log: false,
    });
    assert.equal(result.state, 'delivered');
  }

  assert.ok(getIncidentReporterStatus().openIncidents <= 256);
});

test('relative database paths are never classified as persistent regardless of cwd', () => {
  assert.equal(isPersistentDatabasePath('/var/data/quests.db'), true);
  assert.equal(isPersistentDatabasePath('/var/data/nested/quests.db'), true);
  assert.equal(isPersistentDatabasePath('./var/data/quests.db'), false);
  assert.equal(isPersistentDatabasePath('var/data/quests.db'), false);
  assert.equal(isPersistentDatabasePath(':memory:'), false);
});
