import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerDiscordClient } from '../src/quest/worker-discord-client.js';

test('worker status client sends and edits messages through Discord API v10', async () => {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    const id = calls.length === 1 ? 'message-1' : 'message-1';
    return new Response(JSON.stringify({ id }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = createWorkerDiscordClient({
    fetchFn,
    botToken: 'bot-token-fixture',
  });

  const channel = await client.channels.fetch('channel-1');
  assert.equal(channel.isTextBased(), true);
  const sent = await channel.send({ content: 'hello' });
  await sent.edit({ content: 'updated' });

  assert.deepEqual(calls.map((call) => [call.url, call.options.method]), [
    ['https://discord.com/api/v10/channels/channel-1/messages', 'POST'],
    ['https://discord.com/api/v10/channels/channel-1/messages/message-1', 'PATCH'],
  ]);
  for (const call of calls) {
    assert.equal(call.options.headers.Authorization, 'Bot bot-token-fixture');
    const payload = JSON.parse(call.options.body);
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
  }
});

test('worker status client rejects Discord REST failures without exposing response bodies', async () => {
  const client = createWorkerDiscordClient({
    botToken: 'bot-token-fixture',
    fetchFn: async () => new Response(JSON.stringify({
      message: 'sensitive upstream detail',
      code: 50001,
    }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    }),
  });

  const channel = await client.channels.fetch('channel-1');
  await assert.rejects(
    channel.send({ content: 'hello' }),
    (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.code, 50001);
      assert.doesNotMatch(error.message, /sensitive upstream detail/);
      return true;
    },
  );
});
