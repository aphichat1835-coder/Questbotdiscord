import { Client, GatewayIntentBits, Collection } from 'discord.js';
import { config } from './config.js';
import { startWorker } from './worker.js';
import { startDashboard } from './dashboard.js';
import { refreshBuildInfo } from './discord-runner.js';
import './db.js';

import * as ping        from './commands/ping.js';
import * as help        from './commands/help.js';
import * as apiStatus   from './commands/api-status.js';
import * as run         from './commands/run.js';
import * as stop        from './commands/stop.js';
import * as panel       from './commands/panel.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();

const commands = [
  ping, help, apiStatus,
  run, stop, panel,
];
for (const cmd of commands) {
  client.commands.set(cmd.data.name, cmd);
}

startDashboard(null);

// ดึง build info ล่าสุดก่อน login และ refresh ทุก 6 ชั่วโมง
await refreshBuildInfo();
setInterval(refreshBuildInfo, 6 * 60 * 60 * 1000);

client.once('clientReady', () => {
  console.log(`✅ บอทพร้อมแล้ว — logged in as ${client.user.tag}`);
  startDashboard(client);
  startWorker(client);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('run_modal:')) return run.handleModal(interaction);
      if (['panel_add_modal', 'panel_done_modal', 'panel_edit_modal', 'panel_delete_modal'].includes(interaction.customId)) {
        return panel.handlePanelModal(interaction);
      }
      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('panel:')) return panel.handleButton(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    const command = client.commands.get(interaction.commandName);
    if (!command) return;
    await command.execute(interaction);
  } catch (err) {
    console.error('❌ Interaction error:', err);
    const msg = { content: '❌ เกิดข้อผิดพลาด กรุณาลองใหม่', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
});

client.login(config.token);
