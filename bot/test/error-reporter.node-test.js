import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DISCORD_BOT_TOKEN = 'test-bot-token';
process.env.DISCORD_CLIENT_ID = '12345678901234567';
process.env.DISCORD_GUILD_ID = '22345678901234567';
process.env.OWNER_ID = '32345678901234567';
process.env.RUNNER_TOKEN_SECRET = 'test-runner-token-secret-32-characters';
process.env.LOG_WEBHOOK_URL = 'https://discord.com/api/webhooks/42345678901234567/test_webhook_token_abcdefghijklmnopqrstuvwxyz';
process.env.ALLOW_TEST_WEBHOOK = 'true';

const {
  buildEmergencyWebhookPayload,
  isEmergencyIncident,
  redactSensitive,
  reportCriticalError,
} = await import('../src/error-reporter.js');

const originalConsoleError = console.error;
const originalFetch = globalThis.fetch;
console.error = () => {};
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});
test.after(() => {
  console.error = originalConsoleError;
  delete process.env.ALLOW_TEST_WEBHOOK;
});

test('ordinary operational errors stay in Render logs and do not call the webhook', async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return { ok: true, status: 204 };
  };

  await reportCriticalError(
    'Runner authentication',
    new Error('one account token expired'),
  );

  assert.equal(attempts, 0);
  assert.equal(isEmergencyIncident('Runner authentication', new Error('expired')), false);
});

test('true system emergencies send a styled and mention-safe webhook embed', async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 204 };
  };

  await reportCriticalError(
    'Database backup',
    new Error(`backup failed near ${process.env.LOG_WEBHOOK_URL}`),
    { context: { slot: 3, token: 'must-not-leak' } },
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, process.env.LOG_WEBHOOK_URL);
  const payload = JSON.parse(requests[0].options.body);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].title, '🚨 SYSTEM EMERGENCY');
  assert.equal(payload.embeds[0].color, 0xED4245);
  assert.match(payload.embeds[0].description, /REDACTED_WEBHOOK/);
  assert.doesNotMatch(JSON.stringify(payload), /must-not-leak/);
  assert.doesNotMatch(JSON.stringify(payload), /test_webhook_token/);
});

test('failed emergency delivery releases its dedupe reservation', async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    if (attempts <= 2) return { ok: false, status: 503 };
    return { ok: true, status: 204 };
  };

  const error = new Error('unique emergency delivery failure');
  await reportCriticalError('Health server', error);
  await reportCriticalError('Health server', error);
  await reportCriticalError('Health server', error);

  assert.equal(attempts, 3);
});

test('emergency classifier only escalates compatibility failures that break the engine', () => {
  assert.equal(
    isEmergencyIncident(
      'Quest API compatibility',
      new Error('Quest API schema changed at /quests/@me'),
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

test('webhook payload remains within Discord embed limits', () => {
  const payload = buildEmergencyWebhookPayload(
    'S'.repeat(5000),
    new Error('M'.repeat(10_000)),
    { details: 'C'.repeat(5000) },
  );
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
    redactSensitive(`url=${process.env.LOG_WEBHOOK_URL}`),
    'url=[REDACTED_WEBHOOK]',
  );
});