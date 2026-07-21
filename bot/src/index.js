import { Client, GatewayIntentBits, Collection } from 'discord.js';
import { config } from './config.js';
import { startWorker, stopWorker } from './worker.js';
import { startDashboard, stopDashboard } from './dashboard.js';
import {
  getQuestEngineStatus,
  refreshBuildInfo,
  restoreScheduledRunners,
  shutdownRunners,
} from './discord-runner.js';
import { closeDatabase } from './db.js';
import {
  reportCriticalError,
  setErrorReporterClient,
} from './error-reporter.js';
import { installPersistentRunnerStatusHeaders } from './runner-status-header.js';

import * as ping        from './commands/ping.js';
import * as help        from './commands/help.js';
import * as apiStatus   from './commands/api-status.js';
import * as run         from './commands/run.js';
import * as stop        from './commands/stop.js';
import * as panel       from './commands/panel.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();
installPersistentRunnerStatusHeaders(client, getQuestEngineStatus);
setErrorReporterClient(client);
let buildInfoInterval = null;
let shuttingDown = false;

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
buildInfoInterval = setInterval(() => {
  void refreshBuildInfo().catch((error) => reportCriticalError('Build info refresh', error));
}, 6 * 60 * 60 * 1000);
buildInfoInterval.unref?.();

client.once('clientReady', () => {
  void onClientReady().catch((error) => fatalShutdown('Client startup', error));
});

async function onClientReady() {
  console.log(`✅ บอทพร้อมแล้ว — logged in as ${client.user.tag}`);
  startDashboard(client);
  startWorker(client);
  await restoreScheduledRunners(client);
}

// interaction หมดอายุ (10062) หรือถูกตอบไปแล้ว (40060) — ไม่ต้อง retry
function isIgnorableInteractionError(error) {
  return error?.code === 10062 || error?.code === 40060;
}

function logDiscordError(label, error) {
  console.error(label, {
    code: error?.code,
    status: error?.status,
    message: error?.message,
    method: error?.method,
  });
}

// กัน handler รับ interaction เดียวกันซ้ำใน process เดียว
const seenInteractions = new Set();
function markInteractionSeen(id) {
  if (seenInteractions.has(id)) return false;
  seenInteractions.add(id);
  setTimeout(() => seenInteractions.delete(id), 60_000).unref?.();
  return true;
}

client.on('interactionCreate', async (interaction) => {
  if (!markInteractionSeen(interaction.id)) return;

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
      if (interaction.customId.startsWith('runner-stop:')) return stop.handleButton(interaction);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'runner-stop:select') return stop.handleSelect(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    const command = client.commands.get(interaction.commandName);
    if (!command) return;
    await command.execute(interaction);
  } catch (err) {
    if (isIgnorableInteractionError(err)) {
      console.warn(`⚠️ Ignored interaction error: ${err.code} ${err.message}`);
      return;
    }
    logDiscordError('❌ Interaction error:', err);
    const msg = { content: '❌ เกิดข้อผิดพลาด กรุณาลองใหม่', flags: 64 };
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(msg);
      } else {
        await interaction.reply(msg);
      }
    } catch (replyError) {
      if (!isIgnorableInteractionError(replyError)) {
        logDiscordError('❌ Failed to report interaction error:', replyError);
      }
    }
  }
});

client.on('error', (error) => {
  void reportCriticalError('Discord client', error);
});
client.on('shardError', (error, shardId) => {
  void reportCriticalError(`Discord shard ${shardId}`, error);
});
client.on('warn', (message) => {
  console.warn('⚠️ [Discord]', message);
});
client.on('invalidated', () => {
  void fatalShutdown('Discord session invalidated', new Error('Discord gateway session invalidated'));
});

async function gracefulShutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🧹 Graceful shutdown — ${reason}`);

  clearInterval(buildInfoInterval);
  await stopWorker();

  try {
    const stopped = await shutdownRunners();
    console.log(`🧹 Runner stopped cleanly: ${stopped}`);
  } catch (error) {
    console.error('❌ Runner shutdown error:', error);
  }

  try {
    client.destroy();
    await stopDashboard();
    closeDatabase();
  } catch (error) {
    console.error('❌ Resource shutdown error:', error);
    exitCode = exitCode || 1;
  }

  process.exit(exitCode);
}

async function fatalShutdown(source, error) {
  await Promise.race([
    reportCriticalError(source, error),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]).catch(() => {});
  await gracefulShutdown(source, 1);
}

process.once('SIGTERM', () => {
  void gracefulShutdown('SIGTERM');
});
process.once('SIGINT', () => {
  void gracefulShutdown('SIGINT');
});
process.on('unhandledRejection', (reason) => {
  void fatalShutdown('Unhandled rejection', reason);
});
process.on('uncaughtException', (error) => {
  void fatalShutdown('Uncaught exception', error);
});

try {
  await client.login(config.token);
} catch (error) {
  await fatalShutdown('Discord login', error);
}
