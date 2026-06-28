import fs from 'fs';
import { config } from './config.js';

function load() {
  if (!fs.existsSync(config.databasePath)) {
    const dir = config.databasePath.split('/').slice(0, -1).join('/');
    if (dir) fs.mkdirSync(dir, { recursive: true });
    save({ quests: [], nextId: 1 });
  }
  return JSON.parse(fs.readFileSync(config.databasePath, 'utf-8'));
}

function save(data) {
  fs.writeFileSync(config.databasePath, JSON.stringify(data, null, 2), 'utf-8');
}

export function getAllQuests() {
  return load().quests;
}

export function addQuest({ name, deadline, note }) {
  const db = load();
  const quest = {
    id: db.nextId++,
    name,
    deadline: deadline ?? null,
    note: note ?? null,
    done: false,
    createdAt: new Date().toISOString(),
    doneAt: null,
  };
  db.quests.push(quest);
  save(db);
  return quest;
}

export function markDone(id) {
  const db = load();
  const quest = db.quests.find((q) => q.id === id);
  if (!quest) return null;
  quest.done = true;
  quest.doneAt = new Date().toISOString();
  save(db);
  return quest;
}

export function removeQuest(id) {
  const db = load();
  const index = db.quests.findIndex((q) => q.id === id);
  if (index === -1) return null;
  const [removed] = db.quests.splice(index, 1);
  save(db);
  return removed;
}

export function getStats() {
  const { quests } = load();
  const total = quests.length;
  const done = quests.filter((q) => q.done).length;
  const pending = total - done;
  const overdue = quests.filter((q) => {
    if (q.done || !q.deadline) return false;
    return new Date(q.deadline) < new Date();
  }).length;
  return { total, done, pending, overdue };
}
