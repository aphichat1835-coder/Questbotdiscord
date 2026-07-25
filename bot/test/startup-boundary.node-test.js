import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('entrypoint installs bootstrap handlers before importing runtime modules', async () => {
  const index = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  const dashboard = await readFile(new URL('../src/dashboard.js', import.meta.url), 'utf8');

  assert.match(index, /installBootstrapProcessHandlers\(\)/);
  assert.match(index, /await import\('\.\/app\.js'\)/);
  assert.doesNotMatch(index, /from '\.\/config\.js'/);
  assert.doesNotMatch(index, /from '\.\/db\.js'/);
  assert.match(app, /INCIDENT\.RUNTIME_LEASE_CONFLICT/);
  assert.match(app, /INCIDENT\.HEALTH_SERVER_BIND_FAILED/);
  assert.match(app, /reportWithinFatalBudget/);
  assert.match(dashboard, /new Promise\(\(resolve, reject\)/);
  assert.match(dashboard, /once\('error', onStartupError\)/);
});

test('health server bind failure rejects startup instead of leaving a partial service', async () => {
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const port = blocker.address().port;
  try {
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', `
        const { startDashboard } = await import('./src/dashboard.js');
        try {
          await startDashboard(null);
          console.error('dashboard unexpectedly started');
          process.exit(2);
        } catch (error) {
          if (error?.code !== 'EADDRINUSE') throw error;
          console.log('expected bind failure');
        }
      `],
      {
        cwd: '.',
        env: {
          ...process.env,
          PORT: String(port),
          DATABASE_PATH: ':memory:',
          QUESTBOT_TEST_MODE: 'true',
        },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.match(child.stdout, /expected bind failure/);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});
