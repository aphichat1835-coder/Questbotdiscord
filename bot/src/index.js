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

const PANEL_MODAL_IDS = new Set([
  'panel_add_modal',
  'panel_done_modal',
  'panel_edit_modal',
  'panel_delete_modal',
]);

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

/** Start runtime services after the Discord client is ready. */
async function onClientReady() {
  console.log(`✅ บอทพร้อมแล้ว — logged in as ${client.user.tag}`);
  startDashboard(client);
  startWorker(client);
  await restoreScheduledRunners(client);
}

/** Return whether an interaction error is safe to ignore without retrying. */
function isIgnorableInteractionError(error) {
  return error?.code === 10062 || error?.code === 40060;
}

/** Log a compact Discord API error without exposing request payloads. */
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

/** Claim one interaction ID for this process and expire the claim after one minute. */
function markInteractionSeen(id) {
  if (seenInteractions.has(id)) return false;
  seenInteractions.add(id);
  setTimeout(() => seenInteractions.delete(id), 60_000).unref?.();
  return true;
}

/** Route one modal submission to its owning command module. */
function routeModalSubmit(interaction) {
  if (interaction.customId.startsWith('run_modal:')) return run.handleModal(interaction);
  if (PANEL_MODAL_IDS.has(interaction.customId)) return panel.handlePanelModal(interaction);
  return undefined;
}

/** Route one button interaction to its owning command module. */
function routeButton(interaction) {
  if (interaction.customId.startsWith('panel:')) return panel.handleButton(interaction);
  if (interaction.customId.startsWith('runner-stop:')) return stop.handleButton(interaction);
  return undefined;
}

/** Route one string-select interaction to its owning command module. */
function routeStringSelect(interaction) {
  if (interaction.customId === 'runner-stop:select') return stop.handleSelect(interaction);
  return undefined;
}

/** Execute a registered slash command when one matches the interaction name. */
function routeChatInput(interaction) {
  const command = client.commands.get(interaction.commandName);
  return command?.execute(interaction);
}

/** Dispatch an interaction by Discord interaction type. */
function routeInteraction(interaction) {
  if (interaction.isModalSubmit()) return routeModalSubmit(interaction);
  if (interaction.isButton()) return routeButton(interaction);
  if (interaction.isStringSelectMenu()) return routeStringSelect(interaction);
  if (interaction.isChatInputCommand()) return routeChatInput(interaction);
  return undefined;
}

/** Send the standard private interaction failure response. */
async function sendInteractionFailure(interaction) {
  const message = { content: '❌ เกิดข้อผิดพลาด กรุณาลองใหม่', flags: 64 };
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(message);
    return;
  }
  await interaction.reply(message);
}

/** Report an interaction failure while suppressing expired/already-acknowledged errors. */
async function reportInteractionFailure(interaction, error) {
  if (isIgnorableInteractionError(error)) {
    console.warn(`⚠️ Ignored interaction error: ${error.code} ${error.message}`);
    return;
  }

  logDiscordError('❌ Interaction error:', error);
  try {
    await sendInteractionFailure(interaction);
  } catch (replyError) {
    if (!isIgnorableInteractionError(replyError)) {
      logDiscordError('❌ Failed to report interaction error:', replyError);
    }
  }
}

/** Deduplicate, route, and contain failures for one Discord interaction. */
async function handleInteraction(interaction) {
  if (!markInteractionSeen(interaction.id)) return;

  try {
    await routeInteraction(interaction);
  } catch (error) {
    await reportInteractionFailure(interaction, error);
  }
}

client.on('interactionCreate', handleInteraction);

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

/** Stop workers, runners, Discord, dashboard, and database resources once. */
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

/** Report a fatal runtime error with a bounded wait, then shut down. */
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
