import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { INCIDENT } from './incident-catalog.js';
import { isPersistentDatabasePath } from './storage-profile.js';

const dbPath = config.databasePath;
if (dbPath !== ':memory:') {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const LOCAL_BACKUP_ROOT = './data/backups';
const PERSISTENT_BACKUP_ROOT = '/var/data/backups';
const LOCAL_BACKUP_SLOT_PATHS = Object.freeze([
  './data/backups/questbot-slot-1.db',
  './data/backups/questbot-slot-2.db',
  './data/backups/questbot-slot-3.db',
  './data/backups/questbot-slot-4.db',
  './data/backups/questbot-slot-5.db',
  './data/backups/questbot-slot-6.db',
  './data/backups/questbot-slot-7.db',
]);
const PERSISTENT_BACKUP_SLOT_PATHS = Object.freeze([
  '/var/data/backups/questbot-slot-1.db',
  '/var/data/backups/questbot-slot-2.db',
  '/var/data/backups/questbot-slot-3.db',
  '/var/data/backups/questbot-slot-4.db',
  '/var/data/backups/questbot-slot-5.db',
  '/var/data/backups/questbot-slot-6.db',
  '/var/data/backups/questbot-slot-7.db',
]);
const LOCAL_LEGACY_MIGRATION_BACKUP_PATH = './data/backups/pre-tracker-removal.db';
const PERSISTENT_LEGACY_MIGRATION_BACKUP_PATH = '/var/data/backups/pre-tracker-removal.db';

export const DATABASE_BACKUP_SLOT_COUNT = LOCAL_BACKUP_SLOT_PATHS.length;

function tagDatabaseError(error, incidentCode, operation) {
  const tagged = error instanceof Error ? error : new Error(String(error));
  tagged.incidentCode = incidentCode;
  tagged.bootstrapContext = {
    storageMode: config.storageProfile.mode,
    databasePathType: config.storageProfile.databasePathType,
    operation,
    errorCode: tagged.code,
  };
  return tagged;
}

export function resolveDatabaseBackupDirectory(databasePath) {
  return isPersistentDatabasePath(databasePath)
    ? PERSISTENT_BACKUP_ROOT
    : LOCAL_BACKUP_ROOT;
}

export function resolveDatabaseBackupSlotPath(databasePath, slotIndex) {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= DATABASE_BACKUP_SLOT_COUNT) {
    throw new RangeError(`Database backup slot is out of range: ${slotIndex}`);
  }
  const allowedPaths = isPersistentDatabasePath(databasePath)
    ? PERSISTENT_BACKUP_SLOT_PATHS
    : LOCAL_BACKUP_SLOT_PATHS;
  return allowedPaths[slotIndex];
}

const backupDirectory = config.storageProfile.backupDirectory
  ?? resolveDatabaseBackupDirectory(dbPath);

function openDatabase() {
  try {
    const database = new Database(dbPath);
    database.pragma('journal_mode = WAL');
    database.pragma('foreign_keys = ON');
    return database;
  } catch (error) {
    throw tagDatabaseError(error, INCIDENT.DATABASE_OPEN_FAILED, 'open');
  }
}

export const db = openDatabase();

try {
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
} catch (error) {
  throw tagDatabaseError(error, INCIDENT.DATABASE_MIGRATION_FAILED, 'schema-bootstrap');
}

let legacyMigrationBackupPath = null;

function ensureBackupDirectory() {
  if (!backupDirectory) return;
  fs.mkdirSync(backupDirectory, { recursive: true });
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
  if (dbPath === ':memory:') throw new Error('Database backup is unavailable for in-memory storage');
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

export function getLatestDatabaseBackupAt() {
  if (!config.databaseBackupEnabled || dbPath === ':memory:') return null;
  let latest = 0;
  for (const file of slotPaths()) {
    try {
      latest = Math.max(latest, fs.statSync(file).mtimeMs);
    } catch {}
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

async function createLegacyMigrationBackup() {
  if (dbPath === ':memory:') return null;
  ensureBackupDirectory();
  const destination = isPersistentDatabasePath(dbPath)
    ? PERSISTENT_LEGACY_MIGRATION_BACKUP_PATH
    : LOCAL_LEGACY_MIGRATION_BACKUP_PATH;
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

try {
  await migrateLegacyTracker();
} catch (error) {
  throw tagDatabaseError(error, INCIDENT.DATABASE_MIGRATION_FAILED, 'legacy-tracker-migration');
}

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
