import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDiscordUserHeaders,
  DISCORD_API_BASE,
  DiscordApiError,
  discordFetch,
  fetchQuestPayload,
} from '../src/quest/api/discord-client.js';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('Quest client source uses API v10 directly and builds coherent headers', () => {
  assert.equal(DISCORD_API_BASE, 'https://discord.com/api/v10');
  const headers = buildDiscordUserHeaders('fixture-token', '/quests/@me', {
    clientVersion: '1.0.1',
    chromeVersion: '138.0.1',
    electronVersion: '37.0.0',
    buildNumber: 1,
    nativeBuildNumber: 2,
    locale: 'en-US',
    timezone: 'Asia/Bangkok',
  });
  assert.equal(headers.Authorization, 'fixture-token');
  assert.equal(headers.Referer, 'https://discord.com/quest-home');
  const properties = JSON.parse(Buffer.from(headers['X-Super-Properties'], 'base64').toString('utf8'));
  assert.equal(properties.client_build_number, 1);
  assert.equal(properties.native_build_number, 2);
});

test('discordFetch sends Quest traffic to v10 without relying on runtime rewriting', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options.method ?? 'GET' });
    return new Response(JSON.stringify({ id: 'me' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const result = await discordFetch('fixture-token', '/users/@me');
  assert.equal(result.id, 'me');
  assert.deepEqual(calls, [{
    url: 'https://discord.com/api/v10/users/@me',
    method: 'GET',
  }]);
});

test('Quest endpoint fallback accepts an empty first endpoint and populated second endpoint', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/quests/@me')) {
      return new Response(JSON.stringify({ quests: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ quests: [{ id: 'quest-1' }] }), { status: 200 });
  };
  const payload = await fetchQuestPayload('fixture-token');
  assert.equal(payload.path, '/users/@me/quests');
  assert.equal(payload.quests[0].id, 'quest-1');
  assert.equal(calls.length, 2);
});

test('Discord API errors preserve fatal authentication classification', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Unauthorized' }), {
    status: 401,
  });
  await assert.rejects(
    () => discordFetch('bad-token', '/users/@me'),
    (error) => error instanceof DiscordApiError && error.fatalAuth === true,
  );
});
