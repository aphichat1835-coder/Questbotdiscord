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
  if (value && value.length < minLength) {
    configurationError(`${name} must be at least ${minLength} characters when configured`);
  }
  return value;
}

function validateVersion(name, value) {
  if (value && !/^\d+(?:\.\d+){1,3}$/.test(value)) {
    configurationError(`${name} must contain numeric dot-separated version parts`);
  }
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
const timezone = validateTimeZone('TIMEZONE', readOptional('TIMEZONE', 'Asia/Bangkok'));
const discordTimezone = validateTimeZone(
  'DISCORD_TIMEZONE',
  readOptional('DISCORD_TIMEZONE', timezone),
);

for (const name of [
  'DISCORD_CLIENT_VERSION',
  'DISCORD_CHROME_VERSION',
  'DISCORD_ELECTRON_VERSION',
]) {
  validateVersion(name, readOptional(name));
}
readInteger('DISCORD_BUILD_NUMBER', 0, { min: 0 });
readInteger('DISCORD_NATIVE_BUILD_NUMBER', 0, { min: 0 });

export const config = Object.freeze({
  token: readRequired('DISCORD_BOT_TOKEN'),
  clientId,
  guildId,
  ownerId,
  timezone,
  discordTimezone,
  logChannelId,
  managerRoleId,
  databasePath: readOptional('DATABASE_PATH', './data/quests.db'),
  databaseBackupEnabled: readBoolean('DATABASE_BACKUP_ENABLED', false),
  databaseBackupRetention: readInteger('DATABASE_BACKUP_RETENTION', 7, { min: 1, max: 7 }),
  runnerTokenSecret: validateSecret(
    'RUNNER_TOKEN_SECRET',
    readOptional('RUNNER_TOKEN_SECRET'),
    16,
  ),
  healthStatusToken: validateSecret(
    'HEALTH_STATUS_TOKEN',
    readOptional('HEALTH_STATUS_TOKEN'),
    16,
  ),
  port: readInteger('PORT', 3000, { min: 1, max: 65535 }),
});
