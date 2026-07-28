import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscordRateLimitCoordinator } from '../src/quest/rate-limit-coordinator.js';

function task(overrides = {}) {
  return {
    account: 'rate-limit-response-account',
    jobKey: null,
    route: 'GET:/quests/@me',
    ...overrides,
  };
}

test('successful responses with remaining quota never clone or parse their body', async () => {
  const coordinator = new DiscordRateLimitCoordinator({ now: () => 1_000 });
  let clones = 0;
  await coordinator.updateRateLimitState(task(), {
    status: 200,
    headers: new Headers({
      'x-ratelimit-bucket': 'normal-bucket',
      'x-ratelimit-remaining': '4',
    }),
    clone() {
      clones++;
      throw new Error('normal response body must stay untouched');
    },
  });

  assert.equal(clones, 0);
  assert.equal(coordinator.bucketResetAt.size, 0);
});

test('server Retry-After headers above sixty seconds are preserved exactly', async () => {
  const now = 10_000;
  const coordinator = new DiscordRateLimitCoordinator({ now: () => now });
  await coordinator.updateRateLimitState(task(), {
    status: 429,
    headers: new Headers({
      'x-ratelimit-bucket': 'long-header-bucket',
      'x-ratelimit-scope': 'shared',
      'retry-after': '120',
    }),
    clone() {
      throw new Error('header delay must not require body parsing');
    },
  });

  assert.equal(coordinator.bucketResetAt.get('long-header-bucket'), now + 120_000);
});

test('server retry_after response bodies above sixty seconds are preserved exactly', async () => {
  const now = 20_000;
  const coordinator = new DiscordRateLimitCoordinator({ now: () => now });
  let clones = 0;
  await coordinator.updateRateLimitState(task(), {
    status: 429,
    headers: new Headers({
      'x-ratelimit-bucket': 'long-body-bucket',
      'x-ratelimit-scope': 'shared',
    }),
    clone() {
      clones++;
      return {
        async json() {
          return { retry_after: 180 };
        },
      };
    },
  });

  assert.equal(clones, 1);
  assert.equal(coordinator.bucketResetAt.get('long-body-bucket'), now + 180_000);
});
