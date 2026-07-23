import { randomUUID } from 'node:crypto';
import { Client, Collection, GatewayIntentBits } from 'discord.js';
import { config } from './config.js';
import { startWorker, stopWorker } from './worker.js';
import { startDashboard, stopDashboard } from './dashboard.js';
import {
  refreshBuildInfo as logConfiguredClientProfile,
  restoreScheduledRunners,
  shutdownRunners,
} from './discord-runner.js';
import {
  acquireRuntimeLease,
  closeDatabase,
  releaseRuntimeLease,
  renewRuntimeLease,
} from './db.js';
import {
  redactSensitive,
  reportCriticalError,
  setErrorReporterClient,
} from './error-reporter.js';
import { installPersistentRunnerStatusHeaders } from './runner-status-header.js';

import * as ping from './commands/ping.js';
import * as help from './commands/help.js';
import * as apiStatus from './commands/api-status.js';
import * as run from './commands/run.js';
import * as stop from './commands/stop.js';
import * as panel from './commands/panel.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();
installPersistentRunnerStatusHeaders(client);
setErrorReporterClient(client);

const commands = [ping, help, apiStatus, run, stop, panel];
for (const command of commands) client.commands.set(command.data.name, command);

let shuttingDown = false;
const runtimeLeaseName = 'bot-runtime';
const runtimeLeaseHolder = `${process.pid}:${randomUUID()}`;
if (!acquireRuntimeLease(runtimeLeaseName, runtimeLeaseHolder)) {
  throw new Error('Another Quest Bot process already holds the shared database runtime lease');
}
const runtimeLeaseTimer = setInterval(() => {
  if (!renewRuntimeLease(runtimeLeaseName, runtimeLeaseHolder)) {
    void fatalShutdown('Runtime lease', new Error('Lost the shared database runtime lease'));
  }
}, 30_000);
runtimeLeaseTimer.unref?.();

startDashboard(null);

// The client profile is fixed for the lifetime of the process. Environment
// overrides are read at startup, so changing them requires a normal restart.
await logConfiguredClientProfile();

client.once('clientReady', () => {
  void onClientReady().catch((error) => fatalShutdown('Client startup', error));
});

async function onClientReady() {
  console.log(`✅ บอทพร้อมแล้ว — logged in as ${client.user.tag}`);
  startDashboard(client);
  startWorker();
  await restoreScheduledRunners(client);
}

function isIgnorableInteractionError(error) {
  return error?.code === 10062 || error?.code === 40060;
}

function logDiscordError(label, error) {
  console.error(label, {
    code: error?.code,
    status: error?.status,
    message: redactSensitive(error?.message),
    method: error?.method,
  });
}

const seenInteractions = new Set();
function markInteractionSeen(id) {
  if (seenInteractions.has(id)) return false;
  seenInteractions.add(id);
  setTimeout(() => seenInteractions.delete(id), 60_000).unref?.();
  return true;
}

function routeModalSubmit(interaction) {
  if (interaction.customId.startsWith('run_modal:')) return run.handleModal(interaction);
  return undefined;
}

function routeButton(interaction) {
  if (interaction.customId.startsWith('panel:')) return panel.handleButton(interaction);
  if (interaction.customId.startsWith('runner-stop:')) return stop.handleButton(interaction);
  return undefined;
}

function routeStringSelect(interaction) {
  if (interaction.customId === 'runner-stop:select') return stop.handleSelect(interaction);
  return undefined;
}

function routeChatInput(interaction) {
  const command = client.commands.get(interaction.commandName);
  return command?.execute(interaction);
}

function routeInteraction(interaction) {
  if (interaction.isModalSubmit()) return routeModalSubmit(interaction);
  if (interaction.isButton()) return routeButton(interaction);
  if (interaction.isStringSelectMenu()) return routeStringSelect(interaction);
  if (interaction.isChatInputCommand()) return routeChatInput(interaction);
  return undefined;
}

async function sendInteractionFailure(interaction) {
  const message = { content: '❌ เกิดข้อผิดพลาด กรุณาลองใหม่', flags: 64 };
  if (interaction.replied || interaction.deferred) return interaction.followUp(message);
  return interaction.reply(message);
}

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

async function handleInteraction(interaction) {
  if (!markInteractionSeen(interaction.id)) return;
  try {
    await routeInteraction(interaction);
  } catch (error) {
    await reportInteractionFailure(interaction, error);
  }
}

client.on('interactionCreate', handleInteraction);
client.on('error', (error) => void reportCriticalError('Discord client', error));
client.on('shardError', (error, shardId) => void reportCriticalError(`Discord shard ${shardId}`, error));
client.on('warn', (message) => console.warn('⚠️ [Discord]', message));
client.on('invalidated', () => {
  void fatalShutdown('Discord session invalidated', new Error('Discord gateway session invalidated'));
});

async function gracefulShutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(runtimeLeaseTimer);
  console.log(`🧹 Graceful shutdown — ${reason}`);
  await stopWorker();

  try {
    const stopped = await shutdownRunners();
    console.log(`🧹 Runner stopped cleanly: ${stopped}`);
  } catch (error) {
    console.error('❌ Runner shutdown error:', error);
    exitCode ||= 1;
  }

  try {
    client.destroy();
    await stopDashboard();
  } catch (error) {
    console.error('❌ Resource shutdown error:', error);
    exitCode ||= 1;
  }

  try {
    releaseRuntimeLease(runtimeLeaseName, runtimeLeaseHolder);
    closeDatabase();
  } catch (error) {
    console.error('❌ Database shutdown error:', error);
    exitCode ||= 1;
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

process.once('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.once('SIGINT', () => void gracefulShutdown('SIGINT'));
process.on('unhandledRejection', (reason) => void fatalShutdown('Unhandled rejection', reason));
process.on('uncaughtException', (error) => void fatalShutdown('Uncaught exception', error));

try {
  await client.login(config.token);
} catch (error) {
  await fatalShutdown('Discord login', error);
}
