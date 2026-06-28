import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import * as ping from './commands/ping.js';
import * as help from './commands/help.js';
import * as questAdd from './commands/quest-add.js';
import * as questList from './commands/quest-list.js';
import * as questDone from './commands/quest-done.js';
import * as questRemove from './commands/quest-remove.js';
import * as questStatus from './commands/quest-status.js';

const commands = [ping, help, questAdd, questList, questDone, questRemove, questStatus].map(
  (cmd) => cmd.data.toJSON()
);

const rest = new REST({ version: '10' }).setToken(config.token);

console.log('📡 กำลัง register slash commands...');

try {
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), {
    body: commands,
  });
  console.log(`✅ Register ${commands.length} commands สำเร็จแล้วที่ guild: ${config.guildId}`);
} catch (err) {
  console.error('❌ Register ล้มเหลว:', err);
  process.exit(1);
}
