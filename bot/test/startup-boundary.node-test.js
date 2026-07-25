import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const botRoot = fileURLToPath(new URL('..', import.meta.url));
const dashboardModuleUrl = new URL('../src/dashboard.js', import.meta.url).href;
const appModuleUrl = new URL('../src/app.js', import.meta.url).href;

test('entrypoint installs bootstrap handlers before importing runtime modules', async () => {
  const index = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');

  assert.match(index, /installBootstrapProcessHandlers\(\)/);
  assert.match(index, /await import\('\.\/app\.js'\)/);
  assert.doesNotMatch(index, /from '\.\/config\.js'/);
  assert.doesNotMatch(index, /from '\.\/db\.js'/);
});

test('health server bind failure rejects startup instead of leaving a partial service', async () => {
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const port = blocker.address().port;
  try {
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', `
        const { startDashboard } = await import(${JSON.stringify(dashboardModuleUrl)});
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
        cwd: botRoot,
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

test('concurrent shutdown requests clean up once and keep the highest exit code', () => {
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `
      const exits = [];
      const { createApp } = await import(${JSON.stringify(appModuleUrl)});
      const app = createApp({ exit: (code) => exits.push(code) });
      const normal = app.gracefulShutdown('SIGTERM', 0);
      const fatal = app.gracefulShutdown('fatal-overlap', 1);
      const results = await Promise.all([normal, fatal]);
      if (exits.length !== 1 || exits[0] !== 1) {
        throw new Error('shutdown did not preserve a single highest-severity exit');
      }
      if (results[0] !== 1 || results[1] !== 1) {
        throw new Error('shutdown callers did not share the final exit result');
      }
      console.log('serialized shutdown verified');
    `],
    {
      cwd: botRoot,
      env: {
        ...process.env,
        DATABASE_PATH: ':memory:',
        QUESTBOT_TEST_MODE: 'true',
      },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );

  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /serialized shutdown verified/);
});
