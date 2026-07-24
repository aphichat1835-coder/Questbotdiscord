import fs from 'node:fs';
import 'dotenv/config';

function configurationError(message) {
  throw new Error(`Invalid environment configuration: ${message}`);
}

function readRequired(name) {
  const value = process.env[name]?.trim();
  if (!value) configurationError(`${name} is required and cannot be blank`);
  return value;
}

function readOptional(name, fallback = '') {
  return process.env[name]?.trim() || fallback;
}

function validateSnowflake(name, value, { optional = false } = {}) {
  if (optional && !value) return value;
  if (!/^\d{17,20}$/.test(value)) {
    configurationError(`${name} must be a 17-20 digit Discord snowflake`);
  }
  return value;
}

function readBoolean(name, fallback = false) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw == null || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  configurationError(`${name} must be true/false, 1/0, yes/no or on/off`);
}

function readInteger(name, fallback, { min, max } = {}) {
  const raw = process.env[name]?.trim();
  if (raw == null || raw === '') return fallback;
  if (!/^-?\d+$/.test(raw)) configurationError(`${name} must be a whole number`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) configurationError(`${name} is outside the safe integer range`);
  if (min != null && value < min) configurationError(`${name} must be at least ${min}`);
  if (max != null && value > max) configurationError(`${name} must be at most ${max}`);
  return value;
}

function validateTimeZone(name, value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
  } catch {
    configurationError(`${name} is not a valid IANA timezone`);
  }
  return value;
}

function validateSecret(name, value, minLength = 16) {
  if (value.length < minLength) {
    configurationError(`${name} must be at least ${minLength} characters`);
  }
  return value;
}

function validateVersion(name, value) {
  if (value && !/^\d+(?:\.\d+){1,3}$/.test(value)) {
    configurationError(`${name} must contain numeric dot-separated version parts`);
  }
  return value;
}

function validateDiscordWebhookUrl(name, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    configurationError(`${name} must be a valid URL`);
  }

  const allowedHosts = new Set([
    'discord.com',
    'canary.discord.com',
    'ptb.discord.com',
    'discordapp.com',
    'canary.discordapp.com',
    'ptb.discordapp.com',
  ]);
  const pathMatch = /^\/api\/webhooks\/(\d{17,20})\/([A-Za-z0-9._-]{20,})\/?$/.exec(url.pathname);
  if (
    url.protocol !== 'https:'
    || !allowedHosts.has(url.hostname)
    || !pathMatch
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    configurationError(`${name} must be a standard HTTPS Discord incoming webhook URL`);
  }
  return url.toString().replace(/\/$/, '');
}

function canUsePersistentDataRoot() {
  try {
    if (!fs.statSync('/var/data').isDirectory()) return false;
    fs.accessSync('/var/data', fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function automaticDatabasePath() {
  return canUsePersistentDataRoot() ? '/var/data/quests.db' : './data/quests.db';
}

const clientId = validateSnowflake('DISCORD_CLIENT_ID', readRequired('DISCORD_CLIENT_ID'));
const guildId = validateSnowflake('DISCORD_GUILD_ID', readRequired('DISCORD_GUILD_ID'));
const ownerId = validateSnowflake('OWNER_ID', readRequired('OWNER_ID'));
const managerRoleId = validateSnowflake(
  'MANAGER_ROLE_ID',
  readOptional('MANAGER_ROLE_ID'),
  { optional: true },
);
const logChannelId = validateSnowflake(
  'LOG_CHANNEL_ID',
  readOptional('LOG_CHANNEL_ID'),
  { optional: true },
);
const logWebhookUrl = validateDiscordWebhookUrl(
  'LOG_WEBHOOK_URL',
  readRequired('LOG_WEBHOOK_URL'),
);
const timezone = validateTimeZone('TIMEZONE', readOptional('TIMEZONE', 'Asia/Bangkok'));
const discordTimezone = validateTimeZone(
  'DISCORD_TIMEZONE',
  readOptional('DISCORD_TIMEZONE', timezone),
);
const databasePath = readOptional('DATABASE_PATH', automaticDatabasePath());
if (!process.env.DATABASE_PATH?.trim()) process.env.DATABASE_PATH = databasePath;
const databaseBackupEnabled = readBoolean(
  'DATABASE_BACKUP_ENABLED',
  databasePath !== ':memory:',
);

const discordClientVersion = validateVersion(
  'DISCORD_CLIENT_VERSION',
  readOptional('DISCORD_CLIENT_VERSION', '1.0.9267'),
);
const discordChromeVersion = validateVersion(
  'DISCORD_CHROME_VERSION',
  readOptional('DISCORD_CHROME_VERSION', '138.0.7204.251'),
);
const discordElectronVersion = validateVersion(
  'DISCORD_ELECTRON_VERSION',
  readOptional('DISCORD_ELECTRON_VERSION', '37.6.0'),
);
const discordBuildNumber = readInteger('DISCORD_BUILD_NUMBER', 572700, { min: 0 });
const discordNativeBuildNumber = readInteger(
  'DISCORD_NATIVE_BUILD_NUMBER',
  47491,
  { min: 0 },
);
const discordLocale = readOptional('DISCORD_LOCALE', 'en-US');

export const config = Object.freeze({
  token: readRequired('DISCORD_BOT_TOKEN'),
  clientId,
  guildId,
  ownerId,
  timezone,
  discordTimezone,
  discordLocale,
  discordClientVersion,
  discordChromeVersion,
  discordElectronVersion,
  discordBuildNumber,
  discordNativeBuildNumber,
  logChannelId,
  logWebhookUrl,
  managerRoleId,
  databasePath,
  databaseBackupEnabled,
  databaseBackupRetention: readInteger('DATABASE_BACKUP_RETENTION', 7, { min: 1, max: 7 }),
  runnerTokenSecret: validateSecret(
    'RUNNER_TOKEN_SECRET',
    readRequired('RUNNER_TOKEN_SECRET'),
    16,
  ),
  healthStatusToken: (() => {
    const value = readOptional('HEALTH_STATUS_TOKEN');
    return value ? validateSecret('HEALTH_STATUS_TOKEN', value, 16) : '';
  })(),
  port: readInteger('PORT', 3000, { min: 1, max: 65535 }),
});