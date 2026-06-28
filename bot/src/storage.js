import { config } from './config.js';

const base = config.apiUrl?.replace(/\/$/, '');

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (config.apiSecret) h['x-api-secret'] = config.apiSecret;
  return h;
}

async function call(path, options = {}) {
  const res = await fetch(`${base}${path}`, { headers: headers(), ...options });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `API error ${res.status}`);
  return data;
}

export function getAllQuests() {
  return call('/quests');
}

export function addQuest({ name, deadline, note }) {
  return call('/quests', {
    method: 'POST',
    body: JSON.stringify({ name, deadline, note }),
  });
}

export function markDone(id) {
  return call(`/quests/${id}/done`, { method: 'PATCH' });
}

export function removeQuest(id) {
  return call(`/quests/${id}`, { method: 'DELETE' });
}

export function getStats() {
  return call('/quests/stats');
}
