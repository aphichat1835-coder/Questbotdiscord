import Database from 'better-sqlite3';
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
let legacyMigrationBackupPath = null;

function tableExists(name) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
}

function migrateLegacyTracker() {
  const existing = LEGACY_TABLES.filter(tableExists);
  if (!existing.length) return;

  db.pragma('wal_checkpoint(TRUNCATE)');
  if (dbPath !== ':memory:' && fs.existsSync(dbPath)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    legacyMigrationBackupPath = `${dbPath}.pre-tracker-removal-${timestamp}.bak`;
    fs.copyFileSync(dbPath, legacyMigrationBackupPath);
  }

  db.transaction(() => {
    for (const table of existing) db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.pragma('user_version = 2');
  })();

  console.log(
    `🧹 Removed legacy Quest Tracker tables: ${existing.join(', ')}`
      + (legacyMigrationBackupPath ? ` · backup: ${legacyMigrationBackupPath}` : ''),
  );
}

migrateLegacyTracker();

export async function backupDatabase(destination) {
  const backupDir = path.dirname(destination);
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  await db.backup(destination);
  return destination;
}

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
