from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path):
    return (ROOT / path).read_text()


def write(path, content):
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def replace_section(text, start, end, replacement, label):
    start_index = text.find(start)
    if start_index < 0:
        raise RuntimeError(f"{label}: start marker not found")
    end_index = text.find(end, start_index)
    if end_index < 0:
        raise RuntimeError(f"{label}: end marker not found")
    return text[:start_index] + replacement + text[end_index:]


# Runtime database artifacts
text = read('.gitignore')
text = replace_once(
    text,
    '*.db-wal\n*.db-shm\n*.sqlite\n*.sqlite-wal\n*.sqlite-shm\n',
    '*.db-wal\n*.db-shm\n*.db-journal\n*.sqlite\n*.sqlite-wal\n*.sqlite-shm\n*.sqlite-journal\n',
    'gitignore sqlite journals',
)
write('.gitignore', text)

# CI: make the guards semantic and make failures explicit.
text = read('.github/workflows/ci.yml')
text = replace_once(
    text,
    '''          ! grep -R "panel_\\(add\\|done\\|edit\\|delete\\)_modal" bot/src/index.js
          ! grep -R "getAllQuests\\|addQuest\\|editQuest\\|markDone\\|removeQuest" bot/src
          test -z "$(git ls-files | grep -E '(^|/)backups/|\\.(db|sqlite)(-wal|-shm)?$' || true)"
''',
    '''          test -z "$(grep -R "panel_\\(add\\|done\\|edit\\|delete\\)_modal" bot/src/index.js || true)"
          test -z "$(grep -R "getAllQuests\\|addQuest\\|editQuest\\|markDone\\|removeQuest" bot/src || true)"
          test -z "$(git ls-files | grep -E '(^|/)backups/|\\.(db|sqlite)(-(wal|shm|journal))?$' || true)"
''',
    'ci repository shape guards',
)
text = replace_once(
    text,
    '''          test "$(grep -c "await db.backup(" src/db.js)" -eq 16
          ! grep -n "db.backup(" src/db.js | grep -vE "db.backup\\('(\\./data|/var/data)/backups/"
          ! grep -R "backupDatabase(destination" src test
          ! grep -R "DATABASE_BACKUP_DIR" src scripts test .env.example README.md
          test ! -f src/path-safety.js
          test ! -f test/path-safety.node-test.js
''',
    '''          node --test test/backup-paths.node-test.js
          if grep -R "backupDatabase(destination" src test; then
            echo "Unsupported arbitrary backup destination API detected"
            exit 1
          fi
          if grep -R "DATABASE_BACKUP_DIR" src scripts .env.example; then
            echo "Unsupported DATABASE_BACKUP_DIR runtime/config usage detected"
            exit 1
          fi
          test ! -f src/path-safety.js
          test ! -f test/path-safety.node-test.js
''',
    'ci backup guards',
)
write('.github/workflows/ci.yml', text)

# Documentation fixes.
text = read('bot/README.md')
text = replace_once(
    text,
    "DISCORD_USER_TOKEN='ส่งผ่าน Environment เท่านั้น' npm run smoke:quest",
    "export DISCORD_USER_TOKEN='REPLACE_WITH_TOKEN_FROM_SECRET_STORE'\nnpm run smoke:quest",
    'readme smoke command',
)
write('bot/README.md', text)

text = read('CONTRIBUTING.md')
text = replace_once(
    text,
    "ห้าม Commit Runtime SQLite, WAL/SHM หรือ Backup ทุกชนิด ก่อน Push ให้ตรวจ:",
    "ห้าม Commit Runtime SQLite, WAL/SHM/rollback journal หรือ Backup ทุกชนิด ก่อน Push ให้ตรวจ:",
    'contributing runtime wording',
)
text = replace_once(
    text,
    "git ls-files | grep -E '(^|/)(data|backups)/|\\.(db|sqlite)(-wal|-shm)?$'",
    "git ls-files | grep -E '(^|/)(data|backups)/|\\.(db|sqlite)(-(wal|shm|journal))?$'",
    'contributing artifact regex',
)
write('CONTRIBUTING.md', text)

# Single source of truth for Discord client profile.
text = read('bot/src/config.js')
text = replace_once(
    text,
    '''function validateVersion(name, value) {
  if (value && !/^\\d+(?:\\.\\d+){1,3}$/.test(value)) {
    configurationError(`${name} must contain numeric dot-separated version parts`);
  }
}
''',
    '''function validateVersion(name, value) {
  if (value && !/^\\d+(?:\\.\\d+){1,3}$/.test(value)) {
    configurationError(`${name} must contain numeric dot-separated version parts`);
  }
  return value;
}
''',
    'config validateVersion return',
)
text = replace_once(
    text,
    '''for (const name of [
  'DISCORD_CLIENT_VERSION',
  'DISCORD_CHROME_VERSION',
  'DISCORD_ELECTRON_VERSION',
]) {
  validateVersion(name, readOptional(name));
}
readInteger('DISCORD_BUILD_NUMBER', 0, { min: 0 });
readInteger('DISCORD_NATIVE_BUILD_NUMBER', 0, { min: 0 });
''',
    '''const discordClientVersion = validateVersion(
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
''',
    'config profile values',
)
text = replace_once(
    text,
    '''  timezone,
  discordTimezone,
  logChannelId,
''',
    '''  timezone,
  discordTimezone,
  discordLocale,
  discordClientVersion,
  discordChromeVersion,
  discordElectronVersion,
  discordBuildNumber,
  discordNativeBuildNumber,
  logChannelId,
''',
    'config profile exports',
)
write('bot/src/config.js', text)

# Abortable delay shared by HTTP and mutation retry paths.
write('bot/src/abortable-delay.js', '''function abortFailure() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

export function abortableDelay(ms, signal, { unref = false } = {}) {
  if (signal?.aborted) return Promise.reject(abortFailure());

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(abortFailure());
    };

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, Math.max(0, ms));
    if (unref) timer.unref?.();

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
''')

text = read('bot/src/http-retry.js')
text = replace_once(
    text,
    "const DEFAULT_TIMEOUT_MS = 15_000;\n",
    "import { abortableDelay } from './abortable-delay.js';\n\nconst DEFAULT_TIMEOUT_MS = 15_000;\n",
    'http retry delay import',
)
text = replace_once(
    text,
    '''function abortedError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

export function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError());
      return;
    }

    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
''',
    '''export function wait(ms, signal) {
  return abortableDelay(ms, signal);
}
''',
    'http retry duplicated wait',
)
write('bot/src/http-retry.js', text)

text = read('bot/src/mutation-retry.js')
text = replace_once(
    text,
    "const MAX_RETRY_DELAY_MS = 60_000;\n",
    "import { abortableDelay } from './abortable-delay.js';\n\nconst MAX_RETRY_DELAY_MS = 60_000;\n",
    'mutation retry delay import',
)
text = replace_once(
    text,
    '''function abortedError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

''',
    '',
    'mutation retry duplicate abort error',
)
text = replace_once(
    text,
    '''export async function waitForMutationRetry(ms, signal) {
  if (signal?.aborted) throw abortedError();
  await new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
''',
    '''export function waitForMutationRetry(ms, signal) {
  return abortableDelay(ms, signal, { unref: true });
}
''',
    'mutation retry duplicated wait',
)
write('bot/src/mutation-retry.js', text)

# Database backup paths use one validated resolver.
text = read('bot/src/db.js')
text = replace_once(
    text,
    '''const usePersistentBackupDirectory = dbPath !== ':memory:'
  && path.resolve(dbPath).startsWith('/var/data/');
const backupDirectory = usePersistentBackupDirectory ? '/var/data/backups' : './data/backups';
''',
    '''export function resolveDatabaseBackupDirectory(databasePath) {
  return databasePath !== ':memory:' && path.resolve(databasePath).startsWith('/var/data/')
    ? '/var/data/backups'
    : './data/backups';
}

export function resolveDatabaseBackupSlotPath(databasePath, slotIndex) {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= DATABASE_BACKUP_SLOT_COUNT) {
    throw new RangeError(`Database backup slot is out of range: ${slotIndex}`);
  }
  return `${resolveDatabaseBackupDirectory(databasePath)}/questbot-slot-${slotIndex + 1}.db`;
}

const backupDirectory = resolveDatabaseBackupDirectory(dbPath);
''',
    'db backup directory resolver',
)
text = replace_section(
    text,
    'async function backupLocalSlot(slotIndex) {',
    'async function clearLocalInactiveSlots(keep) {',
    '''function slotPath(slotIndex) {
  return resolveDatabaseBackupSlotPath(dbPath, slotIndex);
}

function slotPaths(startIndex = 0) {
  return Array.from(
    { length: DATABASE_BACKUP_SLOT_COUNT - startIndex },
    (_, offset) => slotPath(startIndex + offset),
  );
}

export async function backupDatabaseSlot(slotIndex) {
  ensureBackupDirectory();
  const destination = slotPath(slotIndex);
  await db.backup(destination);
  return destination;
}

''',
    'db backup slots',
)
text = replace_section(
    text,
    'async function clearLocalInactiveSlots(keep) {',
    'async function createLegacyMigrationBackup() {',
    '''export async function clearInactiveDatabaseBackupSlots(retention) {
  const keep = Math.max(1, Math.min(DATABASE_BACKUP_SLOT_COUNT, retention));
  await Promise.all(slotPaths(keep).map((file) => fs.promises.rm(file, { force: true })));
}

export async function clearAllDatabaseBackupSlots() {
  await Promise.all(slotPaths().map((file) => fs.promises.rm(file, { force: true })));
}

''',
    'db clear backup slots',
)
text = replace_once(
    text,
    '''async function createLegacyMigrationBackup() {
  if (dbPath === ':memory:') return null;
  ensureBackupDirectory();
  if (usePersistentBackupDirectory) {
    await fs.promises.rm('/var/data/backups/pre-tracker-removal.db', { force: true });
    await db.backup('/var/data/backups/pre-tracker-removal.db');
    return '/var/data/backups/pre-tracker-removal.db';
  }

  await fs.promises.rm('./data/backups/pre-tracker-removal.db', { force: true });
  await db.backup('./data/backups/pre-tracker-removal.db');
  return './data/backups/pre-tracker-removal.db';
}
''',
    '''async function createLegacyMigrationBackup() {
  if (dbPath === ':memory:') return null;
  ensureBackupDirectory();
  const destination = `${backupDirectory}/pre-tracker-removal.db`;
  await fs.promises.rm(destination, { force: true });
  await db.backup(destination);
  return destination;
}
''',
    'db migration backup path',
)
write('bot/src/db.js', text)

# Reuse stop-result summarization.
text = read('bot/src/runner-control.js')
text = replace_once(
    text,
    'function summarizeResults(results) {',
    'export function summarizeStopResults(results) {',
    'export stop summary',
)
text = text.replace('return summarizeResults(results);', 'return summarizeStopResults(results);')
write('bot/src/runner-control.js', text)

text = read('bot/src/commands/stop.js')
text = replace_once(
    text,
    "import { stopScheduledJobAndWaitDetailed } from '../runner-control.js';",
    "import { stopScheduledJobAndWaitDetailed, summarizeStopResults } from '../runner-control.js';",
    'stop summary import',
)
text = replace_once(
    text,
    '''function summarizeStopResults(results) {
  const accepted = results.filter((item) => item.accepted).length;
  const completed = results.filter((item) => item.accepted && item.cleanupComplete).length;
  return { accepted, completed, pending: accepted - completed };
}

''',
    '',
    'remove duplicated stop summary',
)
write('bot/src/commands/stop.js', text)

# Runner: consume validated config, lower normalize complexity, and merge failure helper.
text = read('bot/src/discord-runner.js')
text = replace_once(
    text,
    '''// ── Build info — hardcoded fallbacks, overwritten by refreshBuildInfo() ────────
const FALLBACK = Object.freeze({
  clientVersion:   '1.0.9267',
  chromeVersion:   '138.0.7204.251',
  electronVersion: '37.6.0',
  buildNumber:     572700,
  nativeBuildNumber: 47491,
});

let live = {
  clientVersion: process.env.DISCORD_CLIENT_VERSION?.trim() || FALLBACK.clientVersion,
  chromeVersion: process.env.DISCORD_CHROME_VERSION?.trim() || FALLBACK.chromeVersion,
  electronVersion: process.env.DISCORD_ELECTRON_VERSION?.trim() || FALLBACK.electronVersion,
  buildNumber: Number.parseInt(process.env.DISCORD_BUILD_NUMBER ?? '', 10) || FALLBACK.buildNumber,
  nativeBuildNumber: Number.parseInt(process.env.DISCORD_NATIVE_BUILD_NUMBER ?? '', 10) || FALLBACK.nativeBuildNumber,
};
const clientLocale = process.env.DISCORD_LOCALE?.trim() || 'en-US';
const clientTimezone = process.env.DISCORD_TIMEZONE?.trim() || config.timezone;
''',
    '''// ── Validated Discord client profile ───────────────────────────────────────────
const live = {
  clientVersion: config.discordClientVersion,
  chromeVersion: config.discordChromeVersion,
  electronVersion: config.discordElectronVersion,
  buildNumber: config.discordBuildNumber,
  nativeBuildNumber: config.discordNativeBuildNumber,
};
const clientLocale = config.discordLocale;
const clientTimezone = config.discordTimezone;
''',
    'runner validated profile',
)
text = replace_section(
    text,
    'export function normalizeQuest(raw) {',
    '\nfunction sleep(ms, signal) {',
    '''function questProgressPercent(completedSeconds, secondsNeeded) {
  if (secondsNeeded <= 0) return 0;
  return Math.min(100, (completedSeconds / secondsNeeded) * 100);
}

function questConfigMetadata(config, rawId) {
  return {
    name: config.messages?.quest_name ?? rawId,
    applicationId: config.application?.id ?? null,
    rewardPlatforms: rewardPlatforms(config),
    startsAt: config.starts_at ?? null,
    expiresAt: config.expires_at ?? null,
  };
}

function questUserMetadata(userStatus) {
  return {
    enrolledAt: userStatus.enrolled_at ?? null,
    enrolled: Boolean(userStatus.enrolled_at),
    completed: Boolean(userStatus.completed_at),
    claimed: Boolean(userStatus.claimed_at) || userStatus.orb_quantity_claimed != null,
  };
}

export function normalizeQuest(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) {
    throw new QuestCompatibilityError('Quest item is missing a valid id');
  }

  const config = raw.config ?? {};
  const userStatus = raw.user_status ?? {};
  const taskConfig = config.task_config_v2 ?? config.task_config;
  const taskEntries = questTaskEntries(taskConfig);
  const normalizedEntries = normalizeTaskEntries(taskEntries);
  const selectedTask = selectQuestTask(normalizedEntries, progressMapFromStatus(userStatus));
  const validation = validateQuestTask(raw.id, taskConfig, taskEntries, selectedTask);
  const completedSeconds = progressSeconds(
    userStatus,
    selectedTask.key,
    selectedTask.type,
    validation.secondsNeeded,
  );

  return {
    id: raw.id,
    ...questConfigMetadata(config, raw.id),
    eventName: selectedTask.type,
    progress: questProgressPercent(completedSeconds, validation.secondsNeeded),
    secondsNeeded: validation.secondsNeeded,
    progressSecs: completedSeconds,
    progressKey: selectedTask.key,
    autoSupported: validation.autoSupported,
    ...questUserMetadata(userStatus),
    schemaIssues: validation.schemaIssues,
  };
}
''',
    'normalize quest complexity',
)
text = replace_once(
    text,
    'async function enrollmentFailureOutcome(quest, selection, reason, scheduledMessage) {',
    'async function questFailureOutcome(quest, selection, reason, scheduledMessage) {',
    'rename quest failure helper',
)
text = text.replace('enrollmentFailureOutcome(', 'questFailureOutcome(')
text = text.replace('verificationFailureOutcome(', 'questFailureOutcome(')
text = replace_once(
    text,
    '''  async function verificationFailureOutcome(quest, selection, reason, scheduledMessage) {
    if (mode === 'oneshot') return reportOneShotFailure(quest, reason);
    addLog(scheduledMessage);
    await render();
    return attemptedQuestOutcome(selection.runnable.length);
  }

''',
    '',
    'remove duplicate verification failure helper',
)
write('bot/src/discord-runner.js', text)

# Runtime backup destination tests.
write('bot/test/backup-paths.node-test.js', '''import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

process.env.DATABASE_PATH = ':memory:';
const {
  closeDatabase,
  DATABASE_BACKUP_SLOT_COUNT,
  resolveDatabaseBackupDirectory,
  resolveDatabaseBackupSlotPath,
} = await import('../src/db.js');

test.after(() => closeDatabase());

test('backup destination resolver permits only the fixed local and persistent roots', () => {
  assert.equal(resolveDatabaseBackupDirectory('/tmp/questbot.db'), './data/backups');
  assert.equal(resolveDatabaseBackupDirectory('./data/questbot.db'), './data/backups');
  assert.equal(resolveDatabaseBackupDirectory('/var/data/questbot.db'), '/var/data/backups');
  assert.equal(resolveDatabaseBackupDirectory('/var/database/questbot.db'), './data/backups');

  for (let slot = 0; slot < DATABASE_BACKUP_SLOT_COUNT; slot++) {
    assert.equal(
      resolveDatabaseBackupSlotPath('/tmp/questbot.db', slot),
      `./data/backups/questbot-slot-${slot + 1}.db`,
    );
    assert.equal(
      resolveDatabaseBackupSlotPath('/var/data/questbot.db', slot),
      `/var/data/backups/questbot-slot-${slot + 1}.db`,
    );
  }
  for (const invalid of [-1, DATABASE_BACKUP_SLOT_COUNT, 1.5, '1']) {
    assert.throws(
      () => resolveDatabaseBackupSlotPath('/tmp/questbot.db', invalid),
      /slot is out of range/,
    );
  }
});

test('backupDatabaseSlot writes and clears a backup beneath the resolved local root', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'questbot-backup-path-'));
  const moduleUrl = pathToFileURL(path.resolve('src/db.js')).href;
  const databasePath = path.join(tempRoot, 'runtime.db');
  const script = `
    const db = await import(${JSON.stringify(moduleUrl)});
    const destination = await db.backupDatabaseSlot(0);
    const fs = await import('node:fs');
    const path = await import('node:path');
    const absolute = path.resolve(destination);
    const existed = fs.existsSync(absolute);
    await db.clearAllDatabaseBackupSlots();
    const removed = !fs.existsSync(absolute);
    db.closeDatabase();
    console.log(JSON.stringify({ destination, absolute, existed, removed }));
  `;

  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: tempRoot,
      env: { ...process.env, DATABASE_PATH: databasePath },
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const output = JSON.parse(child.stdout.trim().split('\n').at(-1));
    assert.equal(output.destination, './data/backups/questbot-slot-1.db');
    assert.equal(output.absolute.startsWith(tempRoot), true);
    assert.equal(output.existed, true);
    assert.equal(output.removed, true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
''')

write('bot/test/abortable-delay.node-test.js', '''import assert from 'node:assert/strict';
import test from 'node:test';
import { abortableDelay } from '../src/abortable-delay.js';

test('abortableDelay resolves normally', async () => {
  await abortableDelay(1);
});

test('abortableDelay rejects a signal that was already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(abortableDelay(100, controller.signal), /aborted/);
});

test('abortableDelay closes the abort race after timer registration', async () => {
  const controller = new AbortController();
  const pending = abortableDelay(100, controller.signal);
  controller.abort();
  await assert.rejects(pending, /aborted/);
});
''')

# Tests for shared stop summary and config profile.
text = read('bot/test/runner-control.node-test.js')
text = replace_once(
    text,
    '''  isAccountStopping,
  stopRunnerAndWait,
''',
    '''  isAccountStopping,
  stopRunnerAndWait,
  summarizeStopResults,
''',
    'runner control summary import',
)
text = replace_once(
    text,
    "test('stop control blocks restart state until runner cleanup finishes', async () => {",
    '''test('stop result summary is shared by runner control and stop command flows', () => {
  assert.deepEqual(summarizeStopResults([
    { accepted: true, cleanupComplete: true },
    { accepted: true, cleanupComplete: false },
    { accepted: false, cleanupComplete: false },
  ]), { accepted: 2, completed: 1, pending: 1 });
});

test('stop control blocks restart state until runner cleanup finishes', async () => {''',
    'runner control summary test',
)
write('bot/test/runner-control.node-test.js', text)

text = read('bot/test/audit-hardening.node-test.js')
text = replace_once(
    text,
    "test('invalid environment values fail fast', () => {",
    '''test('validated Discord client profile is exposed through config', () => {
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `
      const { config } = await import('./src/config.js');
      console.log(JSON.stringify({
        client: config.discordClientVersion,
        chrome: config.discordChromeVersion,
        electron: config.discordElectronVersion,
        build: config.discordBuildNumber,
        nativeBuild: config.discordNativeBuildNumber,
        locale: config.discordLocale,
      }));
    `],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DISCORD_CLIENT_VERSION: '9.8.7',
        DISCORD_CHROME_VERSION: '140.1.2.3',
        DISCORD_ELECTRON_VERSION: '40.2.1',
        DISCORD_BUILD_NUMBER: '700001',
        DISCORD_NATIVE_BUILD_NUMBER: '50001',
        DISCORD_LOCALE: 'th-TH',
      },
      encoding: 'utf8',
    },
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.deepEqual(JSON.parse(child.stdout.trim().split('\\n').at(-1)), {
    client: '9.8.7',
    chrome: '140.1.2.3',
    electron: '40.2.1',
    build: 700001,
    nativeBuild: 50001,
    locale: 'th-TH',
  });
});

test('invalid environment values fail fast', () => {''',
    'config profile test',
)
write('bot/test/audit-hardening.node-test.js', text)

# Extend static regression guards without depending on implementation formatting.
text = read('bot/test/quality-refactor.node-test.js')
text = replace_once(
    text,
    "  const worker = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');\n",
    "  const worker = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');\n"
    "  const httpRetry = await readFile(new URL('../src/http-retry.js', import.meta.url), 'utf8');\n"
    "  const mutationRetry = await readFile(new URL('../src/mutation-retry.js', import.meta.url), 'utf8');\n"
    "  const stopCommand = await readFile(new URL('../src/commands/stop.js', import.meta.url), 'utf8');\n"
    "  const db = await readFile(new URL('../src/db.js', import.meta.url), 'utf8');\n",
    'quality test source reads',
)
text = replace_once(
    text,
    '''  const executeProgressEnd = runner.indexOf(
    'async function verificationFailureOutcome',
    executeProgressIndex,
  );
''',
    '''  const executeProgressEnd = runner.indexOf(
    'async function verifyQuestCompletion',
    executeProgressIndex,
  );
''',
    'quality test abort boundary',
)
text = replace_once(
    text,
    '''  assert.ok(abortAfterRunnerIndex > executeProgressIndex);
  assert.ok(abortAfterRunnerIndex < executeProgressEnd);
});
''',
    '''  assert.ok(abortAfterRunnerIndex > executeProgressIndex);
  assert.ok(abortAfterRunnerIndex < executeProgressEnd);

  assert.doesNotMatch(runner, /process\\.env\\.DISCORD_(?:CLIENT|CHROME|ELECTRON|BUILD|NATIVE)/);
  assert.equal((runner.match(/async function questFailureOutcome/g) ?? []).length, 1);
  assert.doesNotMatch(runner, /verificationFailureOutcome|enrollmentFailureOutcome/);
  assert.match(httpRetry, /abortableDelay\\(ms, signal\\)/);
  assert.match(mutationRetry, /abortableDelay\\(ms, signal, \\{ unref: true \\}\\)/);
  assert.doesNotMatch(stopCommand, /function summarizeStopResults/);
  assert.match(db, /resolveDatabaseBackupSlotPath/);
  assert.doesNotMatch(db, /backupLocalSlot|backupPersistentSlot|clearLocalInactiveSlots|clearPersistentInactiveSlots/);
});
''',
    'quality test new guards',
)
write('bot/test/quality-refactor.node-test.js', text)

print('review batch applied')
