import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { appendSafeSuffix, resolveContainedPath } from './path-safety.js';

const dbPath = process.env.DATABASE_PATH ?? './data/quests.db';
if (dbPath !== ':memory:') {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

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
`);

const LEGACY_TABLES = ['quest_logs', 'guild_settings', 'quests'];
const LEGACY_BACKUP_SUFFIX = '.pre-tracker-removal.bak';
const BACKUP_DIRECTORY_URL = new URL('../data/backups/', import.meta.url);
const BACKUP_SLOT_URLS = Object.freeze([
  new URL('questbot-slot-1.db', BACKUP_DIRECTORY_URL),
  new URL('questbot-slot-2.db', BACKUP_DIRECTORY_URL),
  new URL('questbot-slot-3.db', BACKUP_DIRECTORY_URL),
  new URL('questbot-slot-4.db', BACKUP_DIRECTORY_URL),
  new URL('questbot-slot-5.db', BACKUP_DIRECTORY_URL),
  new URL('questbot-slot-6.db', BACKUP_DIRECTORY_URL),
  new URL('questbot-slot-7.db', BACKUP_DIRECTORY_URL),
]);

export const DATABASE_BACKUP_SLOT_COUNT = BACKUP_SLOT_URLS.length;
let legacyMigrationBackupPath = null;

function tableExists(name) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
}

function backupSlotUrl(slotIndex) {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= BACKUP_SLOT_URLS.length) {
    throw new RangeError(`Database backup slot is out of range: ${slotIndex}`);
  }
  return BACKUP_SLOT_URLS[slotIndex];
}

export async function backupDatabase(destination) {
  const absoluteDestination = path.resolve(destination);
  const backupDir = path.dirname(absoluteDestination);
  const safeDestination = resolveContainedPath(backupDir, path.basename(absoluteDestination));
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  await db.backup(safeDestination);
  return safeDestination;
}

export async function backupDatabaseSlot(slotIndex) {
  fs.mkdirSync(BACKUP_DIRECTORY_URL, { recursive: true });
  const destination = fileURLToPath(backupSlotUrl(slotIndex));
  await db.backup(destination);
  return destination;
}

export async function clearInactiveDatabaseBackupSlots(retention) {
  const keep = Math.max(1, Math.min(DATABASE_BACKUP_SLOT_COUNT, retention));
  await Promise.all(
    BACKUP_SLOT_URLS.slice(keep).map((slotUrl) => fs.promises.rm(slotUrl, { force: true })),
  );
}

export async function clearAllDatabaseBackupSlots() {
  await Promise.all(
    BACKUP_SLOT_URLS.map((slotUrl) => fs.promises.rm(slotUrl, { force: true })),
  );
}

async function createLegacyMigrationBackup() {
  if (dbPath === ':memory:') return null;
  const destination = appendSafeSuffix(dbPath, LEGACY_BACKUP_SUFFIX);
  return backupDatabase(destination);
}

async function migrateLegacyTracker() {
  const existing = LEGACY_TABLES.filter(tableExists);
  if (!existing.length) return;

  legacyMigrationBackupPath = await createLegacyMigrationBackup();
  db.transaction(() => {
    for (const table of existing) db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.pragma('user_version = 2');
  })();

  console.log(
    `🧹 Removed legacy Quest Tracker tables: ${existing.join(', ')}`
      + (legacyMigrationBackupPath ? ` · backup: ${legacyMigrationBackupPath}` : ''),
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
