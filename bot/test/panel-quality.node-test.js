import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const databasePath = `/tmp/questbot-panel-quality-${process.pid}.db`;

process.env.DISCORD_BOT_TOKEN = 'test-bot-token';
process.env.DISCORD_CLIENT_ID = 'test-client';
process.env.DISCORD_GUILD_ID = 'test-guild';
process.env.OWNER_ID = 'test-owner';
process.env.DATABASE_PATH = databasePath;
process.env.DATABASE_BACKUP_DIR = `/tmp/questbot-panel-quality-backups-${process.pid}`;
process.env.RUNNER_TOKEN_SECRET = 'panel-quality-test-secret-123456';

const panelCommand = await import('../src/commands/panel.js');
const { closeDatabase } = await import('../src/db.js');

test.after(async () => {
  closeDatabase();
  await Promise.all([
    fs.rm(databasePath, { force: true }),
    fs.rm(`${databasePath}-wal`, { force: true }),
    fs.rm(`${databasePath}-shm`, { force: true }),
  ]);
});

test('editing an unknown Quest reports not found', async () => {
  const deferred = [];
  const replies = [];
  const values = {
    id: '999999',
    name: 'Renamed Quest',
    deadline: '',
    note: '',
  };
  const interaction = {
    customId: 'panel_edit_modal',
    user: { id: 'test-owner' },
    fields: {
      getTextInputValue(customId) {
        return values[customId] ?? '';
      },
    },
    async deferReply(payload) {
      deferred.push(payload);
    },
    async editReply(payload) {
      replies.push(payload);
      return payload;
    },
    async reply(payload) {
      replies.push(payload);
      return payload;
    },
  };

  await panelCommand.handlePanelModal(interaction);

  assert.deepEqual(deferred, [{ flags: 64 }]);
  assert.equal(replies.at(-1), '❌ ไม่พบเควส ID #999999');
});

test('panel dispatch uses explicit allowlists and a stable decimal color', async () => {
  const source = await fs.readFile(new URL('../src/commands/panel.js', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /BUTTON_HANDLERS\s*\[/);
  assert.doesNotMatch(source, /MODAL_HANDLERS\s*\[/);
  assert.match(source, /const QUEST_STATS_COLOR = 16705372;/);
});
