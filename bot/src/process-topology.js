import { db } from './db.js';

const LEASE_NAMES = Object.freeze({
  all: 'bot-runtime',
  control: 'bot-control',
  worker: 'quest-worker',
});

function conflictingLeaseNames(role) {
  if (role === 'all') return Object.values(LEASE_NAMES);
  if (role === 'control') return [LEASE_NAMES.all, LEASE_NAMES.control];
  if (role === 'worker') return [LEASE_NAMES.all, LEASE_NAMES.worker];
  throw new Error(`Unknown process role: ${role}`);
}

const acquireTopologyLease = db.transaction((role, holder, ttlMs, now) => {
  const leaseName = LEASE_NAMES[role];
  if (!leaseName) throw new Error(`Unknown process role: ${role}`);
  db.prepare('DELETE FROM runtime_leases WHERE expires_at <= ?').run(now);

  const conflicts = conflictingLeaseNames(role);
  const placeholders = conflicts.map(() => '?').join(', ');
  const active = db.prepare(`
    SELECT name, holder FROM runtime_leases
    WHERE name IN (${placeholders})
  `).all(...conflicts);
  if (active.some((lease) => lease.name !== leaseName || lease.holder !== holder)) {
    return false;
  }

  db.prepare(`
    INSERT INTO runtime_leases (name, holder, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      holder = excluded.holder,
      expires_at = excluded.expires_at
  `).run(leaseName, holder, now + ttlMs);
  return true;
});

export function processLeaseName(role) {
  const name = LEASE_NAMES[role];
  if (!name) throw new Error(`Unknown process role: ${role}`);
  return name;
}

export function acquireProcessRoleLease(role, holder, ttlMs = 90_000) {
  if (!holder) throw new TypeError('Process role lease holder is required');
  return acquireTopologyLease(role, holder, ttlMs, Date.now());
}

export function renewProcessRoleLease(role, holder, ttlMs = 90_000) {
  return db.prepare(`
    UPDATE runtime_leases
    SET expires_at = ?
    WHERE name = ? AND holder = ?
  `).run(Date.now() + ttlMs, processLeaseName(role), holder).changes > 0;
}

export function releaseProcessRoleLease(role, holder) {
  return db.prepare(
    'DELETE FROM runtime_leases WHERE name = ? AND holder = ?',
  ).run(processLeaseName(role), holder).changes > 0;
}

export function clearProcessRoleLeasesForTests() {
  db.prepare(`
    DELETE FROM runtime_leases
    WHERE name IN (?, ?, ?)
  `).run(LEASE_NAMES.all, LEASE_NAMES.control, LEASE_NAMES.worker);
}
