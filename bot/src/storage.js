import * as db from './db.js';

export function getAllQuests() {
  return db.getAll();
}

export function addQuest({ name, deadline, note }) {
  return db.insert({ name, deadline, note });
}

export function editQuest(id, { name, deadline, note }) {
  return db.update(id, { name, deadline, note });
}

export function markDone(id) {
  const quest = db.getById(id);
  if (!quest) return null;
  return db.markDone(id);
}

export function removeQuest(id) {
  return db.remove(id);
}

export function getStats() {
  return db.stats();
}

export function getGuildSettings(guildId) {
  return db.getGuildSettings(guildId) ?? { guild_id: guildId };
}

export function updateGuildSettings(guildId, settings) {
  return db.upsertGuildSettings(guildId, settings);
}

export function getGuildLogs(guildId, limit = 50) {
  return db.getQuestLogs(guildId, limit);
}
