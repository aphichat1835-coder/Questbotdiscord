import fs from 'node:fs';

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`Missing anchor: ${label}`);
  const updated = source.replace(before, after);
  if (updated.includes(before)) throw new Error(`Anchor still present: ${label}`);
  return updated;
}

const dbSource = `import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

const dbPath = process.env.DATABASE_PATH ?? './data/quests.db';
if (dbPath !== ':memory:') {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(\`
  CREATE TABLE IF NOT EXISTS scheduled_runners (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id          TEXT NOT NULL,
    guild_id          TEXT,
    channel_id        TEXT NOT NULL,
    account_id        TEXT NOT NULL,
    username          TEXT NOT NULL,
    token_ciphertext  TEXT NOT NULL,
    token_iv          TEXT NOT NULL,
    token_tag         TEXT NOT NULL,
    token_salt        TEXT NOT NULL,
    next_check_at     TEXT,
    last_check_at     TEXT,
    last_error        TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(owner_id, account_id)
  );
  CREATE INDEX IF NOT EXISTS idx_scheduled_runners_owner
    ON scheduled_runners(owner_id);
\`);

export const DATABASE_BACKUP_SLOT_COUNT = 7;
let legacyMigrationBackupPath = null;

function ensureBackupDirectory() {
  if (!fs.existsSync('./data/backups')) {
    fs.mkdirSync('./data/backups', { recursive: true });
  }
}

function tableExists(name) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
}

function existingLegacyTables() {
  const tables = [];
  if (tableExists('quest_logs')) tables.push('quest_logs');
  if (tableExists('guild_settings')) tables.push('guild_settings');
  if (tableExists('quests')) tables.push('quests');
  return tables;
}

function dropLegacyTables(existing) {
  if (existing.includes('quest_logs')) db.exec('DROP TABLE IF EXISTS quest_logs');
  if (existing.includes('guild_settings')) db.exec('DROP TABLE IF EXISTS guild_settings');
  if (existing.includes('quests')) db.exec('DROP TABLE IF EXISTS quests');
}

export async function backupDatabaseSlot(slotIndex) {
  ensureBackupDirectory();
  switch (slotIndex) {
    case 0:
      await db.backup('./data/backups/questbot-slot-1.db');
      return './data/backups/questbot-slot-1.db';
    case 1:
      await db.backup('./data/backups/questbot-slot-2.db');
      return './data/backups/questbot-slot-2.db';
    case 2:
      await db.backup('./data/backups/questbot-slot-3.db');
      return './data/backups/questbot-slot-3.db';
    case 3:
      await db.backup('./data/backups/questbot-slot-4.db');
      return './data/backups/questbot-slot-4.db';
    case 4:
      await db.backup('./data/backups/questbot-slot-5.db');
      return './data/backups/questbot-slot-5.db';
    case 5:
      await db.backup('./data/backups/questbot-slot-6.db');
      return './data/backups/questbot-slot-6.db';
    case 6:
      await db.backup('./data/backups/questbot-slot-7.db');
      return './data/backups/questbot-slot-7.db';
    default:
      throw new RangeError(\`Database backup slot is out of range: \${slotIndex}\`);
  }
}

export async function clearInactiveDatabaseBackupSlots(retention) {
  const keep = Math.max(1, Math.min(DATABASE_BACKUP_SLOT_COUNT, retention));
  const removals = [];
  if (keep < 7) removals.push(fs.promises.rm('./data/backups/questbot-slot-7.db', { force: true }));
  if (keep < 6) removals.push(fs.promises.rm('./data/backups/questbot-slot-6.db', { force: true }));
  if (keep < 5) removals.push(fs.promises.rm('./data/backups/questbot-slot-5.db', { force: true }));
  if (keep < 4) removals.push(fs.promises.rm('./data/backups/questbot-slot-4.db', { force: true }));
  if (keep < 3) removals.push(fs.promises.rm('./data/backups/questbot-slot-3.db', { force: true }));
  if (keep < 2) removals.push(fs.promises.rm('./data/backups/questbot-slot-2.db', { force: true }));
  await Promise.all(removals);
}

export async function clearAllDatabaseBackupSlots() {
  await Promise.all([
    fs.promises.rm('./data/backups/questbot-slot-1.db', { force: true }),
    fs.promises.rm('./data/backups/questbot-slot-2.db', { force: true }),
    fs.promises.rm('./data/backups/questbot-slot-3.db', { force: true }),
    fs.promises.rm('./data/backups/questbot-slot-4.db', { force: true }),
    fs.promises.rm('./data/backups/questbot-slot-5.db', { force: true }),
    fs.promises.rm('./data/backups/questbot-slot-6.db', { force: true }),
    fs.promises.rm('./data/backups/questbot-slot-7.db', { force: true }),
  ]);
}

async function createLegacyMigrationBackup() {
  if (dbPath === ':memory:') return null;
  ensureBackupDirectory();
  await fs.promises.rm('./data/backups/pre-tracker-removal.db', { force: true });
  await db.backup('./data/backups/pre-tracker-removal.db');
  return './data/backups/pre-tracker-removal.db';
}

async function migrateLegacyTracker() {
  const existing = existingLegacyTables();
  if (!existing.length) return;

  legacyMigrationBackupPath = await createLegacyMigrationBackup();
  db.transaction(() => {
    dropLegacyTables(existing);
    db.pragma('user_version = 2');
  })();

  console.log(
    \`🧹 Removed legacy Quest Tracker tables: \${existing.join(', ')}\`
      + (legacyMigrationBackupPath ? \` · backup: \${legacyMigrationBackupPath}\` : ''),
  );
}

await migrateLegacyTracker();

export function closeDatabase() {
  if (db.open) db.close();
}

export function getDatabasePath() {
  return dbPath;
}

export function getLegacyMigrationBackupPath() {
  return legacyMigrationBackupPath;
}

export function stats() {
  const scheduled = db.prepare('SELECT COUNT(*) AS n FROM scheduled_runners').get().n;
  return { scheduled };
}
`;

fs.writeFileSync(new URL('../src/db.js', import.meta.url), dbSource);

const runnerModesFile = new URL('../test/runner-modes.node-test.js', import.meta.url);
let runnerModes = fs.readFileSync(runnerModesFile, 'utf8');
runnerModes = replaceOnce(
  runnerModes,
  "process.env.DATABASE_PATH = `/tmp/questbot-runner-modes-${process.pid}.db`;",
  "process.env.DATABASE_PATH = './test/.tmp/runner-modes.db';",
  'runner modes database path',
);
runnerModes = replaceOnce(
  runnerModes,
  "const { backupDatabase, clearAllDatabaseBackupSlots } = await import('../src/db.js');",
  "const { backupDatabaseSlot, clearAllDatabaseBackupSlots } = await import('../src/db.js');",
  'runner modes backup import',
);
runnerModes = replaceOnce(
  runnerModes,
  `test('database backup creates a readable SQLite snapshot', async () => {
  const destination = \`/tmp/questbot-backup-\${process.pid}-\${Date.now()}.db\`;
  await backupDatabase(destination);
  const stat = await fs.stat(destination);
  assert.ok(stat.size > 0);
  await fs.unlink(destination);
});`,
  `test('database backup slot creates a readable SQLite snapshot', async () => {
  await clearAllDatabaseBackupSlots();
  const destination = await backupDatabaseSlot(0);
  const stat = await fs.stat(destination);
  assert.ok(stat.size > 0);
  assert.equal(destination, './data/backups/questbot-slot-1.db');
  await clearAllDatabaseBackupSlots();
});`,
  'runner modes generic backup test',
);
fs.writeFileSync(runnerModesFile, runnerModes);

const finalHardeningFile = new URL('../test/final-hardening.node-test.js', import.meta.url);
let finalHardening = fs.readFileSync(finalHardeningFile, 'utf8');
finalHardening = replaceOnce(finalHardening, "import os from 'node:os';\n", '', 'remove os import');
finalHardening = replaceOnce(finalHardening, "import path from 'node:path';\n", '', 'remove path import');
finalHardening = replaceOnce(
  finalHardening,
  "import { appendSafeSuffix } from '../src/path-safety.js';\n",
  '',
  'remove path safety import',
);
finalHardening = replaceOnce(
  finalHardening,
  "process.env.DATABASE_PATH = `/tmp/questbot-final-hardening-${process.pid}.db`;",
  "process.env.DATABASE_PATH = './test/.tmp/final-hardening-main.db';",
  'final hardening database path',
);
finalHardening = replaceOnce(
  finalHardening,
  `  await Promise.all([
    fs.rm(process.env.DATABASE_PATH, { force: true }),
    fs.rm(\`\${process.env.DATABASE_PATH}-wal\`, { force: true }),
    fs.rm(\`\${process.env.DATABASE_PATH}-shm\`, { force: true }),
  ]);`,
  `  await Promise.all([
    fs.rm('./test/.tmp/final-hardening-main.db', { force: true }),
    fs.rm('./test/.tmp/final-hardening-main.db-wal', { force: true }),
    fs.rm('./test/.tmp/final-hardening-main.db-shm', { force: true }),
    fs.rm('./test/.tmp/final-hardening-legacy.db', { force: true }),
    fs.rm('./data/backups/pre-tracker-removal.db', { force: true }),
  ]);`,
  'final hardening cleanup',
);
finalHardening = replaceOnce(
  finalHardening,
  `  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'questbot-migration-'));
  const databasePath = path.join(tempDir, 'legacy.db');`,
  `  await fs.mkdir('./test/.tmp', { recursive: true });
  await fs.rm('./test/.tmp/final-hardening-legacy.db', { force: true });
  await fs.rm('./data/backups/pre-tracker-removal.db', { force: true });
  const databasePath = './test/.tmp/final-hardening-legacy.db';`,
  'final hardening migration setup',
);
finalHardening = replaceOnce(
  finalHardening,
  "  const backupPath = appendSafeSuffix(databasePath, '.pre-tracker-removal.bak');\n  const backup = new Database(backupPath, { readonly: true });",
  "  const backup = new Database('./data/backups/pre-tracker-removal.db', { readonly: true });",
  'final hardening migration backup path',
);
finalHardening = replaceOnce(
  finalHardening,
  "  await fs.rm(tempDir, { recursive: true, force: true });",
  `  await Promise.all([
    fs.rm('./test/.tmp/final-hardening-legacy.db', { force: true }),
    fs.rm('./data/backups/pre-tracker-removal.db', { force: true }),
  ]);`,
  'final hardening migration cleanup',
);
fs.writeFileSync(finalHardeningFile, finalHardening);

fs.rmSync(new URL('../src/path-safety.js', import.meta.url), { force: true });
fs.rmSync(new URL('../test/path-safety.node-test.js', import.meta.url), { force: true });

console.log('Applied literal-only database backup architecture');
