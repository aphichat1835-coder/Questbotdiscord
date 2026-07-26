import './setup-env.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { shouldDelegateScheduledRunner } from '../src/quest/runner-service.js';

async function source(path) {
  return readFile(new URL(path, import.meta.url), 'utf8');
}

test('control delegates only scheduled jobs', () => {
  assert.equal(shouldDelegateScheduledRunner('control', 'scheduled'), true);
  assert.equal(shouldDelegateScheduledRunner('control', 'oneshot'), false);
  assert.equal(shouldDelegateScheduledRunner('all', 'scheduled'), false);
  assert.equal(shouldDelegateScheduledRunner('worker', 'scheduled'), false);
});

test('bootstrap selects the standalone worker application only for worker role', async () => {
  const index = await source('../src/index.js');
  assert.match(index, /config\.processRole === 'worker'/);
  assert.match(index, /\.\/worker-app\.js/);
  assert.match(index, /createWorkerApp/);
  assert.match(index, /\.\/app\.js/);
  assert.match(index, /createApp/);
});

test('standalone worker uses REST output and does not create a Discord gateway client', async () => {
  const worker = await source('../src/worker-app.js');
  assert.match(worker, /createWorkerDiscordClient/);
  assert.match(worker, /startScheduledWorkerSupervisor/);
  assert.doesNotMatch(worker, /new Client\(/);
  assert.doesNotMatch(worker, /client\.login/);
  assert.doesNotMatch(worker, /GatewayIntentBits/);
});

test('all-in-one remains the default role and split start scripts are explicit', async () => {
  const [config, packageJson] = await Promise.all([
    source('../src/config.js'),
    source('../package.json'),
  ]);
  assert.match(config, /\['all', 'control', 'worker'\], 'all'/);
  const manifest = JSON.parse(packageJson);
  assert.equal(manifest.scripts.start, 'node src/index.js');
  assert.match(manifest.scripts['start:control'], /QUEST_PROCESS_ROLE=control/);
  assert.match(manifest.scripts['start:worker'], /QUEST_PROCESS_ROLE=worker/);
});
