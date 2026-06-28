import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

const dbPath = process.env.DATABASE_PATH ?? './data/quests.db';
const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS quests (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT    NOT NULL,
    deadline  TEXT,
    note      TEXT,
    done      INTEGER NOT NULL DEFAULT 0,
    done_at   TEXT,
    created_at TEXT   NOT NULL DEFAULT (datetime('now'))
  );
`);

export function getAll() {
  return db.prepare('SELECT * FROM quests ORDER BY id ASC').all().map(normalize);
}

export function getById(id) {
  const row = db.prepare('SELECT * FROM quests WHERE id = ?').get(id);
  return row ? normalize(row) : null;
}

export function insert({ name, deadline, note }) {
  const info = db
    .prepare('INSERT INTO quests (name, deadline, note) VALUES (?, ?, ?)')
    .run(name, deadline ?? null, note ?? null);
  return getById(info.lastInsertRowid);
}

export function markDone(id) {
  db.prepare(`UPDATE quests SET done = 1, done_at = datetime('now') WHERE id = ?`).run(id);
  return getById(id);
}

export function update(id, { name, deadline, note, done }) {
  const fields = [];
  const vals = [];
  if (name !== undefined)     { fields.push('name = ?');     vals.push(name); }
  if (deadline !== undefined) { fields.push('deadline = ?'); vals.push(deadline); }
  if (note !== undefined)     { fields.push('note = ?');     vals.push(note); }
  if (done !== undefined)     {
    fields.push('done = ?');
    vals.push(done ? 1 : 0);
    if (done) { fields.push(`done_at = datetime('now')`); }
    else      { fields.push('done_at = NULL'); }
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

export function stats() {
  const total   = db.prepare('SELECT COUNT(*) as n FROM quests').get().n;
  const done    = db.prepare('SELECT COUNT(*) as n FROM quests WHERE done = 1').get().n;
  const pending = total - done;
  const overdue = db.prepare(
    `SELECT COUNT(*) as n FROM quests WHERE done = 0 AND deadline IS NOT NULL AND deadline < date('now')`
  ).get().n;
  return { total, done, pending, overdue };
}

function normalize(row) {
  return {
    id:        row.id,
    name:      row.name,
    deadline:  row.deadline ?? null,
    note:      row.note ?? null,
    done:      row.done === 1,
    doneAt:    row.done_at ?? null,
    createdAt: row.created_at,
  };
}
