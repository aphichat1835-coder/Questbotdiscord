import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

const dbPath = process.env.DATABASE_PATH ?? './data/quests.db';
const dir    = path.dirname(dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS quests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    deadline    TEXT,
    note        TEXT,
    guild_id    TEXT,
    user_id     TEXT,
    done        INTEGER NOT NULL DEFAULT 0,
    done_at     TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id          TEXT PRIMARY KEY,
    log_channel_id    TEXT,
    panel_channel_id  TEXT,
    manager_role_id   TEXT,
    timezone          TEXT NOT NULL DEFAULT 'Asia/Bangkok',
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS quest_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    quest_id    INTEGER,
    guild_id    TEXT,
    user_id     TEXT,
    action      TEXT    NOT NULL,
    details     TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_quests_guild    ON quests(guild_id);
  CREATE INDEX IF NOT EXISTS idx_quests_done     ON quests(done);
  CREATE INDEX IF NOT EXISTS idx_quest_logs_guild ON quest_logs(guild_id, created_at DESC);
`);

for (const col of ['guild_id TEXT', 'user_id TEXT']) {
  try { db.exec(`ALTER TABLE quests ADD COLUMN ${col}`); } catch {}
}

function todayBangkok() {
  const tz = process.env.TIMEZONE ?? 'Asia/Bangkok';
  return new Date().toLocaleDateString('sv-SE', { timeZone: tz });
}

export function getAll(filters = {}) {
  const conditions = [];
  const vals       = [];
  if (filters.guild_id !== undefined) { conditions.push('guild_id = ?'); vals.push(filters.guild_id); }
  if (filters.done     !== undefined) { conditions.push('done = ?');     vals.push(filters.done ? 1 : 0); }
  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
  return db.prepare(`SELECT * FROM quests${where} ORDER BY id ASC`).all(...vals).map(normalize);
}

export function getById(id) {
  const row = db.prepare('SELECT * FROM quests WHERE id = ?').get(id);
  return row ? normalize(row) : null;
}

export function insert({ name, deadline, note, guild_id, user_id }) {
  const info = db
    .prepare('INSERT INTO quests (name, deadline, note, guild_id, user_id) VALUES (?, ?, ?, ?, ?)')
    .run(name, deadline ?? null, note ?? null, guild_id ?? null, user_id ?? null);
  return getById(info.lastInsertRowid);
}

export function markDone(id) {
  const changed = db.prepare(`UPDATE quests SET done = 1, done_at = datetime('now') WHERE id = ? AND done = 0`).run(id);
  if (changed.changes === 0) return getById(id);
  return getById(id);
}

export function update(id, { name, deadline, note, done }) {
  const fields = [];
  const vals   = [];
  if (name     !== undefined) { fields.push('name = ?');     vals.push(name); }
  if (deadline !== undefined) { fields.push('deadline = ?'); vals.push(deadline); }
  if (note     !== undefined) { fields.push('note = ?');     vals.push(note); }
  if (done     !== undefined) {
    fields.push('done = ?');
    vals.push(done ? 1 : 0);
    fields.push(done ? `done_at = datetime('now')` : 'done_at = NULL');
  }
  if (!fields.length) return getById(id);
  vals.push(id);
  db.prepare(`UPDATE quests SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  return getById(id);
}

export function remove(id) {
  const quest = getById(id);
  if (!quest) return null;
  db.prepare('DELETE FROM quests WHERE id = ?').run(id);
  return quest;
}

export function stats(guild_id) {
  const today   = todayBangkok();
  const cond    = guild_id != null ? ' AND guild_id = ?' : '';
  const args    = guild_id != null ? [guild_id]          : [];

  const total   = db.prepare(`SELECT COUNT(*) as n FROM quests${guild_id != null ? ' WHERE guild_id = ?' : ''}`).get(...args).n;
  const done    = db.prepare(`SELECT COUNT(*) as n FROM quests WHERE done = 1${cond}`).get(...args).n;
  const pending = total - done;
  const overdue = db.prepare(
    `SELECT COUNT(*) as n FROM quests WHERE done = 0 AND deadline IS NOT NULL AND deadline < ?${cond}`
  ).get(today, ...args).n;

  return { total, done, pending, overdue };
}

export function getGuildSettings(guildId) {
  return db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId) ?? null;
}

export function upsertGuildSettings(guildId, { log_channel_id, panel_channel_id, manager_role_id, timezone } = {}) {
  const existing = getGuildSettings(guildId);
  if (existing) {
    const fields = [`updated_at = datetime('now')`];
    const vals   = [];
    if (log_channel_id   !== undefined) { fields.push('log_channel_id = ?');   vals.push(log_channel_id); }
    if (panel_channel_id !== undefined) { fields.push('panel_channel_id = ?'); vals.push(panel_channel_id); }
    if (manager_role_id  !== undefined) { fields.push('manager_role_id = ?');  vals.push(manager_role_id); }
    if (timezone         !== undefined) { fields.push('timezone = ?');          vals.push(timezone); }
    vals.push(guildId);
    db.prepare(`UPDATE guild_settings SET ${fields.join(', ')} WHERE guild_id = ?`).run(...vals);
  } else {
    db.prepare(`
      INSERT INTO guild_settings (guild_id, log_channel_id, panel_channel_id, manager_role_id, timezone)
      VALUES (?, ?, ?, ?, ?)
    `).run(guildId, log_channel_id ?? null, panel_channel_id ?? null, manager_role_id ?? null, timezone ?? 'Asia/Bangkok');
  }
  return getGuildSettings(guildId);
}

export function addQuestLog({ quest_id, guild_id, user_id, action, details }) {
  return db.prepare(
    'INSERT INTO quest_logs (quest_id, guild_id, user_id, action, details) VALUES (?, ?, ?, ?, ?)'
  ).run(quest_id ?? null, guild_id ?? null, user_id ?? null, action, details ?? null);
}

export function getQuestLogs(guild_id, limit = 50) {
  return db.prepare(
    'SELECT * FROM quest_logs WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(guild_id, limit);
}

function normalize(row) {
  return {
    id:        row.id,
    name:      row.name,
    deadline:  row.deadline  ?? null,
    note:      row.note      ?? null,
    guildId:   row.guild_id  ?? null,
    userId:    row.user_id   ?? null,
    done:      row.done === 1,
    doneAt:    row.done_at   ?? null,
    createdAt: row.created_at,
  };
}
