import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRunnerStatusContent,
  installPersistentRunnerStatusHeaders,
} from '../src/runner-status-header.js';

test('runner headers stay pinned while activity lines rotate', () => {
  const state = {};
  const first = formatRunnerStatusContent([
    '```',
    '✅ LOGIN : example-user',
    '🤖 AUTO DAILY ENABLED — CHECK 00:00 / 08:00 / 16:00',
    '🔎 example-user: พบ 3 QUESTS',
    '▶️ example-user: กำลังทำ Quest A',
    '```',
  ].join('\n'), state, {
    state: 'compatible',
    questCount: 5,
  });

  assert.match(first, /^```\n✅ LOGIN : example-user\n🤖 AUTO DAILY ENABLED/);
  assert.match(first, /🔍 ตรวจพบ Quest ทั้งหมด : 5\n─+/);
  assert.doesNotMatch(first, /⚙️ Quest ที่ระบบทำได้/);

  const activity = Array.from({ length: 40 }, (_, index) => `⌛ Quest A ${index}%`);
  const updated = formatRunnerStatusContent([
    '```',
    ...activity,
    '🔎 example-user: พบ 2 QUESTS',
    '```',
  ].join('\n'), state, {
    state: 'compatible',
    questCount: 4,
  });

  assert.match(updated, /^```\n✅ LOGIN : example-user\n🤖 AUTO DAILY ENABLED/);
  assert.match(updated, /🔍 ตรวจพบ Quest ทั้งหมด : 4\n─+/);
  assert.doesNotMatch(updated, /⚙️ Quest ที่ระบบทำได้/);
  assert.ok(updated.length <= 1950);
  assert.doesNotMatch(updated, /Quest ทั้งหมด : 5/);
});

test('oversized single activity line is removed to stay within Discord limit', () => {
  const oversizedActivity = `⌛ ${'x'.repeat(2500)}`;
  const formatted = formatRunnerStatusContent([
    '```',
    '✅ LOGIN : example-user',
    '🔎 example-user: พบ 1 QUESTS',
    oversizedActivity,
    '```',
  ].join('\n'), {}, {
    state: 'compatible',
    questCount: 1,
  });

  assert.ok(formatted.length <= 1950);
  assert.match(formatted, /🔍 ตรวจพบ Quest ทั้งหมด : 1/);
  assert.doesNotMatch(formatted, /x{100}/);
});

test('installed wrapper only reformats runner status messages', async () => {
  const sentPayloads = [];
  const editedPayloads = [];
  const rawMessage = {
    async edit(payload) {
      editedPayloads.push(payload);
      return this;
    },
  };
  const channel = {
    async send(payload) {
      sentPayloads.push(payload);
      return rawMessage;
    },
    isTextBased() {
      return true;
    },
  };
  const client = {
    channels: {
      async fetch() {
        return channel;
      },
    },
  };
  let status = {
    state: 'compatible',
    questCount: 6,
  };
  const getStatus = () => status;

  assert.equal(installPersistentRunnerStatusHeaders(client, getStatus), true);
  assert.equal(installPersistentRunnerStatusHeaders(client, getStatus), false);

  const wrappedChannel = await client.channels.fetch('channel-id');
  const ordinary = await wrappedChannel.send({ content: 'hello' });
  assert.equal(ordinary, rawMessage);
  assert.equal(sentPayloads[0].content, 'hello');

  const runnerMessage = await wrappedChannel.send({
    content: '```\n✅ LOGIN : example-user\n🔎 example-user: พบ 4 QUESTS\n```',
  });
  assert.match(sentPayloads[1].content, /✅ LOGIN : example-user/);
  assert.match(sentPayloads[1].content, /🔍 ตรวจพบ Quest ทั้งหมด : 6/);
  assert.doesNotMatch(sentPayloads[1].content, /⚙️ Quest ที่ระบบทำได้/);
  assert.match(sentPayloads[1].content, /────────────────────────/);

  status = {
    state: 'compatible',
    questCount: 5,
  };
  await runnerMessage.edit({
    content: '```\n⌛ example-user: Quest A 25%\n🔎 example-user: พบ 3 QUESTS\n```',
  });
  assert.match(editedPayloads[0].content, /^```\n✅ LOGIN : example-user/);
  assert.match(editedPayloads[0].content, /🔍 ตรวจพบ Quest ทั้งหมด : 5/);
  assert.doesNotMatch(editedPayloads[0].content, /⚙️ Quest ที่ระบบทำได้/);
  assert.match(editedPayloads[0].content, /⌛ example-user: Quest A 25%/);

  status = {
    state: 'compatible',
    questCount: 99,
  };
  await runnerMessage.edit({
    content: '```\n⌛ example-user: Quest A 50%\n```',
  });
  assert.match(editedPayloads[1].content, /🔍 ตรวจพบ Quest ทั้งหมด : 5/);
  assert.doesNotMatch(editedPayloads[1].content, /⚙️ Quest ที่ระบบทำได้/);
  assert.doesNotMatch(editedPayloads[1].content, /99/);
});
