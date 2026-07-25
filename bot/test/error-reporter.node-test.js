import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeDiscordWebhookUrl } from '../test-support/fake-webhook.js';

const WEBHOOK_URL = createFakeDiscordWebhookUrl('reporter');
const CRITICAL_EMBED_COLOR = Number.parseInt('ED4245', 16);
const RECOVERY_EMBED_COLOR = Number.parseInt('57F287', 16);
process.env.DISCORD_BOT_TOKEN = 'test-bot-token';
process.env.DISCORD_CLIENT_ID = '12345678901234567';
process.env.DISCORD_GUILD_ID = '22345678901234567';
process.env.OWNER_ID = '32345678901234567';
process.env.RUNNER_TOKEN_SECRET = 'test-runner-token-secret-32-characters';
process.env.LOG_WEBHOOK_URL = WEBHOOK_URL;
process.env.ALLOW_TEST_WEBHOOK = 'true';

const { INCIDENT } = await import('../src/incident-catalog.js');
const {
  buildIncidentWebhookPayload,
  getIncidentReporterStatus,
  isEmergencyIncident,
  redactSensitive,
  reportCriticalError,
  reportIncident,
  reportRecovery,
  resetIncidentReporterStateForTests,
} = await import('../src/error-reporter.js');

const originalConsoleError = console.error;
const originalFetch = globalThis.fetch;
console.error = () => {};

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  resetIncidentReporterStateForTests();
});

test.after(() => {
  console.error = originalConsoleError;
  delete process.env.ALLOW_TEST_WEBHOOK;
});

test('ordinary operational errors stay in Render logs and do not call the webhook', async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return new Response(null, { status: 204 });
  };

  const result = await reportCriticalError(
    'Runner authentication',
    new Error('one account token expired'),
  );

  assert.equal(attempts, 0);
  assert.deepEqual(result, { state: 'logged' });
  assert.equal(isEmergencyIncident('Runner authentication', new Error('expired')), false);
});

test('structured incidents send an allowlisted, mention-safe backend embed', async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(null, { status: 204 });
  };

  const result = await reportIncident({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    error: new Error(`backup failed near ${WEBHOOK_URL}`),
    context: {
      consecutiveFailures: 3,
      backupAgeHours: 27,
      storageMode: 'persistent-candidate',
      token: 'must-not-leak',
      arbitraryInternalObject: { password: 'hidden' },
    },
  });

  assert.equal(result.state, 'delivered');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, WEBHOOK_URL);
  const payload = JSON.parse(requests[0].options.body);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.match(payload.embeds[0].title, /การป้องกันฐานข้อมูล/);
  assert.equal(payload.embeds[0].color, CRITICAL_EMBED_COLOR);
  assert.match(payload.embeds[0].description, /REDACTED_WEBHOOK/);
  assert.match(JSON.stringify(payload), /consecutiveFailures/);
  assert.doesNotMatch(JSON.stringify(payload), /must-not-leak|arbitraryInternalObject|webhook_token/);
});

test('duplicate incidents are suppressed by code and scope', async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return new Response(null, { status: 204 });
  };

  const first = await reportIncident({
    code: INCIDENT.HEALTH_SERVER_BIND_FAILED,
    error: new Error('EADDRINUSE'),
    scope: 'health:10000',
  });
  const duplicate = await reportIncident({
    code: INCIDENT.HEALTH_SERVER_BIND_FAILED,
    error: new Error('wording changed but same invariant'),
    scope: 'health:10000',
  });
  const distinctScope = await reportIncident({
    code: INCIDENT.HEALTH_SERVER_BIND_FAILED,
    error: new Error('EADDRINUSE'),
    scope: 'health:10001',
  });

  assert.equal(first.state, 'delivered');
  assert.equal(duplicate.state, 'suppressed');
  assert.equal(distinctScope.state, 'delivered');
  assert.equal(attempts, 2);
  assert.equal(getIncidentReporterStatus().suppressedIncidents, 1);
});

test('an open incident sends one recovery using the same incident id', async () => {
  const payloads = [];
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return new Response(null, { status: 204 });
  };

  const opened = await reportIncident({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    error: new Error('three backup failures'),
    scope: 'database-backup',
    context: { consecutiveFailures: 3, backupAgeHours: 27 },
  });
  const recovered = await reportRecovery({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    scope: 'database-backup',
    context: { consecutiveFailures: 0, backupAgeHours: 0 },
  });
  const duplicateRecovery = await reportRecovery({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    scope: 'database-backup',
  });

  assert.equal(recovered.state, 'delivered');
  assert.equal(duplicateRecovery.state, 'not_open');
  assert.equal(payloads.length, 2);
  assert.match(payloads[1].embeds[0].title, /^✅/);
  assert.equal(payloads[1].embeds[0].color, RECOVERY_EMBED_COLOR);
  assert.ok(JSON.stringify(payloads[1]).includes(opened.incidentId));
});

test('Quest transport failures require three observations before one alert', async () => {
  const payloads = [];
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return new Response(null, { status: 204 });
  };
  const error = new Error('Quest API endpoints unavailable: upstream timeout');

  const first = await reportCriticalError('Quest API compatibility', error);
  const second = await reportCriticalError('Quest API compatibility', error);
  const third = await reportCriticalError('Quest API compatibility', error);

  assert.equal(first.state, 'logged_threshold');
  assert.equal(first.count, 1);
  assert.equal(second.state, 'logged_threshold');
  assert.equal(second.count, 2);
  assert.equal(third.state, 'delivered');
  assert.equal(payloads.length, 1);
  const serialized = JSON.stringify(payloads[0]);
  assert.match(serialized, /QUEST_API_TRANSPORT_OUTAGE/);
  assert.match(serialized, /consecutiveFailures/);
  assert.match(serialized, /3/);
});

test('scheduled restore failures aggregate before sending one backend incident', async () => {
  const payloads = [];
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return new Response(null, { status: 204 });
  };

  for (let row = 1; row <= 3; row++) {
    await reportCriticalError(
      `Restore Scheduled Runner #${row}`,
      new Error('Unsupported state or unable to authenticate data'),
    );
  }

  assert.equal(payloads.length, 1);
  const serialized = JSON.stringify(payloads[0]);
  assert.match(serialized, /RUNNER_RESTORE_SYSTEM_FAILED/);
  assert.match(serialized, /decryptFailures/);
  assert.match(serialized, /failed/);
  assert.match(serialized, /3/);
  assert.doesNotMatch(serialized, /Runner #1|Runner #2/);
});

test('legacy threshold evidence expires instead of accumulating forever', async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return new Response(null, { status: 204 });
  };
  const error = new Error('Quest API endpoints unavailable: temporary outage');

  const first = await reportCriticalError('Quest API compatibility', error, { now: 0 });
  const expired = await reportCriticalError('Quest API compatibility', error, { now: 10 * 60_000 + 1 });

  assert.equal(first.count, 1);
  assert.equal(expired.count, 1);
  assert.equal(attempts, 0);
});

test('legacy compatibility only escalates supported system sources', () => {
  assert.equal(
    isEmergencyIncident(
      'Quest API compatibility',
      Object.assign(new Error('Quest API schema changed'), { name: 'QuestCompatibilityError' }),
    ),
    true,
  );
  assert.equal(
    isEmergencyIncident(
      'Quest API compatibility',
      new Error('unknown events: WATCH_NEW_PROMO'),
    ),
    false,
  );
  assert.equal(isEmergencyIncident('Uncaught exception', new Error('boom')), true);
  assert.equal(isEmergencyIncident('Discord shard 0', new Error('temporary')), false);
});

test('incident payload remains within Discord embed limits', () => {
  const payload = buildIncidentWebhookPayload({
    code: INCIDENT.SYSTEM_FAILURE,
    error: new Error('M'.repeat(10_000)),
    context: { component: 'C'.repeat(5000) },
  });
  const embed = payload.embeds[0];
  const totalCharacters = [
    embed.title,
    embed.description,
    embed.footer.text,
    ...embed.fields.flatMap((field) => [field.name, field.value]),
  ].reduce((sum, value) => sum + value.length, 0);

  assert.ok(embed.description.length <= 4096);
  assert.ok(embed.fields.length <= 25);
  assert.ok(embed.fields.every((field) => field.value.length <= 1024));
  assert.ok(totalCharacters <= 6000);
});

test('redaction removes Discord webhook URLs from arbitrary text', () => {
  assert.equal(
    redactSensitive(`url=${WEBHOOK_URL}`),
    'url=[REDACTED_WEBHOOK]',
  );
});
