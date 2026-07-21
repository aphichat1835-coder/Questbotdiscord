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

const LEGACY_BACKUP_SUFFIX = '.pre-tracker-removal.bak';
const BACKUP_DIRECTORY_PATH = fileURLToPath(new URL('../data/backups/', import.meta.url));
const BACKUP_SLOT_1_PATH = fileURLToPath(new URL('../data/backups/questbot-slot-1.db', import.meta.url));
const BACKUP_SLOT_2_PATH = fileURLToPath(new URL('../data/backups/questbot-slot-2.db', import.meta.url));
const BACKUP_SLOT_3_PATH = fileURLToPath(new URL('../data/backups/questbot-slot-3.db', import.meta.url));
const BACKUP_SLOT_4_PATH = fileURLToPath(new URL('../data/backups/questbot-slot-4.db', import.meta.url));
const BACKUP_SLOT_5_PATH = fileURLToPath(new URL('../data/backups/questbot-slot-5.db', import.meta.url));
const BACKUP_SLOT_6_PATH = fileURLToPath(new URL('../data/backups/questbot-slot-6.db', import.meta.url));
const BACKUP_SLOT_7_PATH = fileURLToPath(new URL('../data/backups/questbot-slot-7.db', import.meta.url));

export const DATABASE_BACKUP_SLOT_COUNT = 7;
let legacyMigrationBackupPath = null;

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

export async function backupDatabase(destination) {
  const absoluteDestination = path.resolve(destination);
  const backupDir = path.dirname(absoluteDestination);
  const safeDestination = resolveContainedPath(backupDir, path.basename(absoluteDestination));
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  await db.backup(safeDestination);
  return safeDestination;
}

export async function backupDatabaseSlot(slotIndex) {
  fs.mkdirSync(BACKUP_DIRECTORY_PATH, { recursive: true });
  switch (slotIndex) {
    case 0:
      await db.backup(BACKUP_SLOT_1_PATH);
      return BACKUP_SLOT_1_PATH;
    case 1:
      await db.backup(BACKUP_SLOT_2_PATH);
      return BACKUP_SLOT_2_PATH;
    case 2:
      await db.backup(BACKUP_SLOT_3_PATH);
      return BACKUP_SLOT_3_PATH;
    case 3:
      await db.backup(BACKUP_SLOT_4_PATH);
      return BACKUP_SLOT_4_PATH;
    case 4:
      await db.backup(BACKUP_SLOT_5_PATH);
      return BACKUP_SLOT_5_PATH;
    case 5:
      await db.backup(BACKUP_SLOT_6_PATH);
      return BACKUP_SLOT_6_PATH;
    case 6:
      await db.backup(BACKUP_SLOT_7_PATH);
      return BACKUP_SLOT_7_PATH;
    default:
      throw new RangeError(`Database backup slot is out of range: ${slotIndex}`);
  }
}

export async function clearInactiveDatabaseBackupSlots(retention) {
  const keep = Math.max(1, Math.min(DATABASE_BACKUP_SLOT_COUNT, retention));
  const removals = [];
  if (keep < 7) removals.push(fs.promises.rm(BACKUP_SLOT_7_PATH, { force: true }));
  if (keep < 6) removals.push(fs.promises.rm(BACKUP_SLOT_6_PATH, { force: true }));
  if (keep < 5) removals.push(fs.promises.rm(BACKUP_SLOT_5_PATH, { force: true }));
  if (keep < 4) removals.push(fs.promises.rm(BACKUP_SLOT_4_PATH, { force: true }));
  if (keep < 3) removals.push(fs.promises.rm(BACKUP_SLOT_3_PATH, { force: true }));
  if (keep < 2) removals.push(fs.promises.rm(BACKUP_SLOT_2_PATH, { force: true }));
  await Promise.all(removals);
}

export async function clearAllDatabaseBackupSlots() {
  await Promise.all([
    fs.promises.rm(BACKUP_SLOT_1_PATH, { force: true }),
    fs.promises.rm(BACKUP_SLOT_2_PATH, { force: true }),
    fs.promises.rm(BACKUP_SLOT_3_PATH, { force: true }),
    fs.promises.rm(BACKUP_SLOT_4_PATH, { force: true }),
    fs.promises.rm(BACKUP_SLOT_5_PATH, { force: true }),
    fs.promises.rm(BACKUP_SLOT_6_PATH, { force: true }),
    fs.promises.rm(BACKUP_SLOT_7_PATH, { force: true }),
  ]);
}

async function createLegacyMigrationBackup() {
  if (dbPath === ':memory:') return null;
  const destination = appendSafeSuffix(dbPath, LEGACY_BACKUP_SUFFIX);
  return backupDatabase(destination);
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
