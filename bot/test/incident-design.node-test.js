import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('incident design keeps the six required environment values documented', () => {
  const design = fs.readFileSync('./INCIDENT-DESIGN.md', 'utf8');
  for (const name of [
    'DISCORD_BOT_TOKEN',
    'DISCORD_CLIENT_ID',
    'DISCORD_GUILD_ID',
    'OWNER_ID',
    'RUNNER_TOKEN_SECRET',
    'LOG_WEBHOOK_URL',
  ]) {
    assert.match(design, new RegExp(`^${name}=`, 'm'));
  }
});

test('incident design preserves Render logs and restricts webhook context', () => {
  const design = fs.readFileSync('./INCIDENT-DESIGN.md', 'utf8');
  assert.match(design, /Render\/Console logs/);
  assert.match(design, /Allowlist/);
  assert.match(design, /Controlled UAT/);
});
