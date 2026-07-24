import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DISCORD_BOT_TOKEN = 'test-bot-token';
process.env.DISCORD_CLIENT_ID = '12345678901234567';
process.env.DISCORD_GUILD_ID = '22345678901234567';
process.env.OWNER_ID = '32345678901234567';
process.env.LOG_CHANNEL_ID = '42345678901234567';

const {
  reportCriticalError,
  setErrorReporterClient,
} = await import('../src/error-reporter.js');

const originalConsoleError = console.error;
console.error = () => {};
test.after(() => {
  console.error = originalConsoleError;
  setErrorReporterClient(null);
});

test('failed critical-error delivery releases only its own dedupe reservation', async () => {
  let attempts = 0;
  setErrorReporterClient({
    isReady: () => true,
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        send: async () => {
          attempts++;
          if (attempts === 1) throw new Error('temporary delivery failure');
        },
      }),
    },
  });

  const error = new Error('same critical failure');
  await reportCriticalError('dedupe-release', error);
  await reportCriticalError('dedupe-release', error);
  await reportCriticalError('dedupe-release', error);

  assert.equal(attempts, 2);
});

test('critical-error notification never exceeds the Discord message limit', async () => {
  const contents = [];
  setErrorReporterClient({
    isReady: () => true,
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        send: async ({ content }) => contents.push(content),
      }),
    },
  });

  await reportCriticalError('S'.repeat(5000), new Error('M'.repeat(5000)));

  assert.equal(contents.length, 1);
  assert.ok(contents[0].length <= 2000);
  assert.match(contents[0], /^🚨 \*\*Critical Error — /);
  assert.match(contents[0], /\n```$/);
});
