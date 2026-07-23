import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

const dbPath = process.env.DATABASE_PATH ?? './data/quests.db';
if (dbPath !== ':memory:') {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function resolveDatabaseBackupDirectory(databasePath) {
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

function slotPath(slotIndex) {
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

export async function clearInactiveDatabaseBackupSlots(retention) {
  const keep = Math.max(1, Math.min(DATABASE_BACKUP_SLOT_COUNT, retention));
  await Promise.all(slotPaths(keep).map((file) => fs.promises.rm(file, { force: true })));
}

export async function clearAllDatabaseBackupSlots() {
  await Promise.all(slotPaths().map((file) => fs.promises.rm(file, { force: true })));
}

async function createLegacyMigrationBackup() {
  if (dbPath === ':memory:') return null;
  ensureBackupDirectory();
  const destination = `${backupDirectory}/pre-tracker-removal.db`;
  await fs.promises.rm(destination, { force: true });
  await db.backup(destination);
  return destination;
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
