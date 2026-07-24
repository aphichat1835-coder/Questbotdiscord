import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const REQUIRED_ENV = Object.freeze({
  DISCORD_BOT_TOKEN: 'test-bot-token',
  DISCORD_CLIENT_ID: '12345678901234567',
  DISCORD_GUILD_ID: '22345678901234567',
  OWNER_ID: '32345678901234567',
  RUNNER_TOKEN_SECRET: 'test-runner-token-secret-32-characters',
  LOG_WEBHOOK_URL: 'https://discord.com/api/webhooks/42345678901234567/test_webhook_token_abcdefghijklmnopqrstuvwxyz',
});

function runConfig({ overrides = {}, remove = [] } = {}) {
  const env = { ...process.env, ...REQUIRED_ENV };
  for (const name of [
    'DATABASE_PATH',
    'DATABASE_BACKUP_ENABLED',
    'LOG_CHANNEL_ID',
    'MANAGER_ROLE_ID',
    'HEALTH_STATUS_TOKEN',
    ...remove,
  ]) delete env[name];
  Object.assign(env, overrides);

  const script = `import('./src/config.js').then(({config}) => console.log(JSON.stringify({databasePath:config.databasePath,databaseBackupEnabled:config.databaseBackupEnabled,logChannelId:config.logChannelId,hasWebhook:Boolean(config.logWebhookUrl),hasRunnerSecret:Boolean(config.runnerTokenSecret)}))).catch((error)=>{console.error(error.message);process.exitCode=1;});`;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: '.', env, encoding: 'utf8', timeout: 10_000,
  });
}

test('the six primary environment values are sufficient', () => {
  const child = runConfig();
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const output = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.match(output.databasePath, /^(?:\.\/data\/quests\.db|\/var\/data\/quests\.db)$/);
  assert.equal(output.databaseBackupEnabled, true);
  assert.equal(output.logChannelId, '');
  assert.equal(output.hasWebhook, true);
  assert.equal(output.hasRunnerSecret, true);
});

test('LOG_WEBHOOK_URL is required and validated', () => {
  const missing = runConfig({ remove: ['LOG_WEBHOOK_URL'] });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /LOG_WEBHOOK_URL is required/);
  const invalid = runConfig({ overrides: { LOG_WEBHOOK_URL: 'https://example.com/hook' } });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /standard HTTPS Discord incoming webhook URL/);
});

test('RUNNER_TOKEN_SECRET is required and long enough', () => {
  const missing = runConfig({ remove: ['RUNNER_TOKEN_SECRET'] });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /RUNNER_TOKEN_SECRET is required/);
  const short = runConfig({ overrides: { RUNNER_TOKEN_SECRET: 'too-short' } });
  assert.notEqual(short.status, 0);
  assert.match(short.stderr, /at least 16 characters/);
});

test('optional overrides remain available', () => {
  const child = runConfig({
    overrides: {
      DATABASE_PATH: ':memory:',
      DATABASE_BACKUP_ENABLED: 'false',
      LOG_CHANNEL_ID: '52345678901234567',
    },
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const output = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.equal(output.databasePath, ':memory:');
  assert.equal(output.databaseBackupEnabled, false);
  assert.equal(output.logChannelId, '52345678901234567');
});