import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISCORD_API_VERSION,
  installDiscordApiRuntime,
  uninstallDiscordApiRuntime,
} from '../src/quest/discord-api-runtime.js';
import { DiscordRateLimitCoordinator } from '../src/quest/rate-limit-coordinator.js';

function response(status = 200, headers = {}) {
  return new Response('{}', { status, headers });
}

test('Discord API runtime rewrites older versioned URLs to v10 only', async () => {
  const calls = [];
  installDiscordApiRuntime({
    fetchFn: async (input) => {
      calls.push(String(input));
      return response();
    },
  });

  try {
    await globalThis.fetch('https://discord.com/api/v9/users/@me', {
      headers: { Authorization: 'fixture-user-token' },
    });
    assert.equal(DISCORD_API_VERSION, 10);
    assert.equal(calls[0], 'https://discord.com/api/v10/users/@me');
  } finally {
    uninstallDiscordApiRuntime();
  }
});

test('non-Discord traffic is not rewritten or coordinated', async () => {
  const calls = [];
  installDiscordApiRuntime({
    fetchFn: async (input) => {
      calls.push(String(input));
      return response();
    },
  });

  try {
    await globalThis.fetch('https://example.com/api/v9/health');
    assert.deepEqual(calls, ['https://example.com/api/v9/health']);
  } finally {
    uninstallDiscordApiRuntime();
  }
});

test('coordinator never runs two requests for the same account concurrently', async () => {
  const coordinator = new DiscordRateLimitCoordinator({ maxConcurrency: 4 });
  let active = 0;
  let maximum = 0;
  const execute = async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return response();
  };

  await Promise.all([
    coordinator.schedule('https://discord.com/api/v10/quests/@me', {
      headers: { Authorization: 'same-account' },
    }, execute),
    coordinator.schedule('https://discord.com/api/v10/quests/@me', {
      headers: { Authorization: 'same-account' },
    }, execute),
  ]);

  assert.equal(maximum, 1);
});

test('global 429 pauses the next queued Discord request', async () => {
  const coordinator = new DiscordRateLimitCoordinator({ maxConcurrency: 1 });
  const started = [];
  const first = coordinator.schedule('https://discord.com/api/v10/quests/@me', {
    headers: { Authorization: 'account-a' },
  }, async () => {
    started.push(Date.now());
    return response(429, {
      'retry-after': '0.03',
      'x-ratelimit-global': 'true',
    });
  });
  const second = coordinator.schedule('https://discord.com/api/v10/quests/@me', {
    headers: { Authorization: 'account-b' },
  }, async () => {
    started.push(Date.now());
    return response();
  });

  await Promise.all([first, second]);
  assert.ok(started[1] - started[0] >= 20, `global pause was only ${started[1] - started[0]}ms`);
  assert.equal(coordinator.snapshot().globalRateLimits, 1);
});
