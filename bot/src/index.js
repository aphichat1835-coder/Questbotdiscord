import { Client, GatewayIntentBits, Collection } from 'discord.js';
import { config } from './config.js';
import * as ping from './commands/ping.js';
import * as help from './commands/help.js';
import * as questAdd from './commands/quest-add.js';
import * as questList from './commands/quest-list.js';
import * as questDone from './commands/quest-done.js';
import * as questRemove from './commands/quest-remove.js';
import * as questStatus from './commands/quest-status.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();

const commands = [ping, help, questAdd, questList, questDone, questRemove, questStatus];
for (const cmd of commands) {
  client.commands.set(cmd.data.name, cmd);
}

client.once('ready', () => {
  console.log(`✅ บอทพร้อมแล้ว — logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`❌ Error in /${interaction.commandName}:`, err);
    const msg = { content: '❌ เกิดข้อผิดพลาด กรุณาลองใหม่', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg);
    } else {
      await interaction.reply(msg);
    }
  }
});

client.login(config.token);
