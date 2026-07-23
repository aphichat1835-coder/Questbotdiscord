import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

const dbPath = process.env.DATABASE_PATH ?? './data/quests.db';
if (dbPath !== ':memory:') {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const usePersistentBackupDirectory = dbPath !== ':memory:'
  && path.resolve(dbPath).startsWith('/var/data/');
const backupDirectory = usePersistentBackupDirectory ? '/var/data/backups' : './data/backups';

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
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

  CREATE TABLE IF NOT EXISTS runtime_leases (
    name       TEXT PRIMARY KEY,
    holder     TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

export const DATABASE_BACKUP_SLOT_COUNT = 7;
let legacyMigrationBackupPath = null;

function ensureBackupDirectory() {
  if (!fs.existsSync(backupDirectory)) {
    fs.mkdirSync(backupDirectory, { recursive: true });
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

async function backupLocalSlot(slotIndex) {
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
      throw new RangeError(`Database backup slot is out of range: ${slotIndex}`);
  }
}

async function backupPersistentSlot(slotIndex) {
  switch (slotIndex) {
    case 0:
      await db.backup('/var/data/backups/questbot-slot-1.db');
      return '/var/data/backups/questbot-slot-1.db';
    case 1:
      await db.backup('/var/data/backups/questbot-slot-2.db');
      return '/var/data/backups/questbot-slot-2.db';
    case 2:
      await db.backup('/var/data/backups/questbot-slot-3.db');
      return '/var/data/backups/questbot-slot-3.db';
    case 3:
      await db.backup('/var/data/backups/questbot-slot-4.db');
      return '/var/data/backups/questbot-slot-4.db';
    case 4:
      await db.backup('/var/data/backups/questbot-slot-5.db');
      return '/var/data/backups/questbot-slot-5.db';
    case 5:
      await db.backup('/var/data/backups/questbot-slot-6.db');
      return '/var/data/backups/questbot-slot-6.db';
    case 6:
      await db.backup('/var/data/backups/questbot-slot-7.db');
      return '/var/data/backups/questbot-slot-7.db';
    default:
      throw new RangeError(`Database backup slot is out of range: ${slotIndex}`);
  }
}

export async function backupDatabaseSlot(slotIndex) {
  ensureBackupDirectory();
  return usePersistentBackupDirectory
    ? backupPersistentSlot(slotIndex)
    : backupLocalSlot(slotIndex);
}

async function clearLocalInactiveSlots(keep) {
  const removals = [];
  if (keep < 7) removals.push(fs.promises.rm('./data/backups/questbot-slot-7.db', { force: true }));
  if (keep < 6) removals.push(fs.promises.rm('./data/backups/questbot-slot-6.db', { force: true }));
  if (keep < 5) removals.push(fs.promises.rm('./data/backups/questbot-slot-5.db', { force: true }));
  if (keep < 4) removals.push(fs.promises.rm('./data/backups/questbot-slot-4.db', { force: true }));
  if (keep < 3) removals.push(fs.promises.rm('./data/backups/questbot-slot-3.db', { force: true }));
  if (keep < 2) removals.push(fs.promises.rm('./data/backups/questbot-slot-2.db', { force: true }));
  await Promise.all(removals);
}

async function clearPersistentInactiveSlots(keep) {
  const removals = [];
  if (keep < 7) removals.push(fs.promises.rm('/var/data/backups/questbot-slot-7.db', { force: true }));
  if (keep < 6) removals.push(fs.promises.rm('/var/data/backups/questbot-slot-6.db', { force: true }));
  if (keep < 5) removals.push(fs.promises.rm('/var/data/backups/questbot-slot-5.db', { force: true }));
  if (keep < 4) removals.push(fs.promises.rm('/var/data/backups/questbot-slot-4.db', { force: true }));
  if (keep < 3) removals.push(fs.promises.rm('/var/data/backups/questbot-slot-3.db', { force: true }));
  if (keep < 2) removals.push(fs.promises.rm('/var/data/backups/questbot-slot-2.db', { force: true }));
  await Promise.all(removals);
}

export async function clearInactiveDatabaseBackupSlots(retention) {
  const keep = Math.max(1, Math.min(DATABASE_BACKUP_SLOT_COUNT, retention));
  if (usePersistentBackupDirectory) return clearPersistentInactiveSlots(keep);
  return clearLocalInactiveSlots(keep);
}

export async function clearAllDatabaseBackupSlots() {
  if (usePersistentBackupDirectory) {
    await Promise.all([
      fs.promises.rm('/var/data/backups/questbot-slot-1.db', { force: true }),
      fs.promises.rm('/var/data/backups/questbot-slot-2.db', { force: true }),
      fs.promises.rm('/var/data/backups/questbot-slot-3.db', { force: true }),
      fs.promises.rm('/var/data/backups/questbot-slot-4.db', { force: true }),
      fs.promises.rm('/var/data/backups/questbot-slot-5.db', { force: true }),
      fs.promises.rm('/var/data/backups/questbot-slot-6.db', { force: true }),
      fs.promises.rm('/var/data/backups/questbot-slot-7.db', { force: true }),
    ]);
    return;
  }

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
  if (usePersistentBackupDirectory) {
    await fs.promises.rm('/var/data/backups/pre-tracker-removal.db', { force: true });
    await db.backup('/var/data/backups/pre-tracker-removal.db');
    return '/var/data/backups/pre-tracker-removal.db';
  }

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
    `🧹 Removed legacy Quest Tracker tables: ${existing.join(', ')}`
      + (legacyMigrationBackupPath ? ` · backup: ${legacyMigrationBackupPath}` : ''),
  );
}

await migrateLegacyTracker();

const acquireRuntimeLeaseTransaction = db.transaction((name, holder, ttlMs, now) => {
  db.prepare('DELETE FROM runtime_leases WHERE expires_at <= ?').run(now);
  const existing = db.prepare('SELECT holder FROM runtime_leases WHERE name = ?').get(name);
  if (existing && existing.holder !== holder) return false;
  db.prepare(`
    INSERT INTO runtime_leases (name, holder, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      holder = excluded.holder,
      expires_at = excluded.expires_at
  `).run(name, holder, now + ttlMs);
  return true;
});

export function acquireRuntimeLease(name, holder, ttlMs = 90_000) {
  if (!name || !holder) throw new TypeError('Runtime lease name and holder are required');
  return acquireRuntimeLeaseTransaction(name, holder, ttlMs, Date.now());
}

export function renewRuntimeLease(name, holder, ttlMs = 90_000) {
  return db.prepare(`
    UPDATE runtime_leases
    SET expires_at = ?
    WHERE name = ? AND holder = ?
  `).run(Date.now() + ttlMs, name, holder).changes > 0;
}

export function releaseRuntimeLease(name, holder) {
  return db.prepare(
    'DELETE FROM runtime_leases WHERE name = ? AND holder = ?',
  ).run(name, holder).changes > 0;
}

export function closeDatabase() {
  if (db.open) db.close();
}

export function getDatabasePath() {
  return dbPath;
}

export function getDatabaseBackupDirectory() {
  return backupDirectory;
}

export function getLegacyMigrationBackupPath() {
  return legacyMigrationBackupPath;
}

export function stats() {
  const scheduled = db.prepare('SELECT COUNT(*) AS n FROM scheduled_runners').get().n;
  return { scheduled };
}
