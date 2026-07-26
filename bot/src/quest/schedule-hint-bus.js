const listeners = new Map();
const latestHints = new Map();

export function publishScheduleHint(accountKey, hint) {
  if (!accountKey || !hint?.nextActionAt) return false;
  const previous = latestHints.get(accountKey);
  if (previous && previous.nextActionAt === hint.nextActionAt && previous.reason === hint.reason) {
    return false;
  }
  latestHints.set(accountKey, { ...hint });
  for (const listener of listeners.get(accountKey) ?? []) {
    try { listener({ ...hint }); } catch {}
  }
  return true;
}

export function subscribeScheduleHints(accountKey, listener) {
  if (!listeners.has(accountKey)) listeners.set(accountKey, new Set());
  listeners.get(accountKey).add(listener);
  const latest = latestHints.get(accountKey);
  if (latest) queueMicrotask(() => listener({ ...latest }));
  return () => {
    const accountListeners = listeners.get(accountKey);
    accountListeners?.delete(listener);
    if (accountListeners?.size === 0) listeners.delete(accountKey);
  };
}

export function getLatestScheduleHint(accountKey) {
  const hint = latestHints.get(accountKey);
  return hint ? { ...hint } : null;
}

export function clearScheduleHintsForTests() {
  listeners.clear();
  latestHints.clear();
}
