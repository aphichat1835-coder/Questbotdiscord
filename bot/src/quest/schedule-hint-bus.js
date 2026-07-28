const listeners = new Map();
const hintsByAccount = new Map();
const effectiveHints = new Map();
const URGENT_WINDOW_MS = 30 * 60 * 1000;

function notifyListener(listener, hint) {
  try {
    listener(hint ? { ...hint } : null);
  } catch (error) {
    console.warn(`[QuestScheduler] schedule hint listener failed: ${error?.message ?? 'unknown error'}`);
  }
}

function timestamp(value) {
  const time = value == null ? Number.NaN : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function sourceForHint(hint) {
  if (hint?.source) return String(hint.source);
  const prefix = String(hint?.reason ?? 'runner').split(':', 1)[0];
  return prefix || 'runner';
}

function sameHint(left, right) {
  return Boolean(
    left
    && right
    && left.nextActionAt === right.nextActionAt
    && left.reason === right.reason
    && Number(left.priority ?? 0) === Number(right.priority ?? 0)
    && (left.expiresAt ?? null) === (right.expiresAt ?? null)
    && left.source === right.source,
  );
}

function validHints(accountKey, now = Date.now()) {
  const hints = hintsByAccount.get(accountKey);
  if (!hints) return [];
  for (const [source, hint] of hints) {
    const expiresAt = timestamp(hint.expiresAt);
    if (expiresAt != null && expiresAt <= now) hints.delete(source);
  }
  if (hints.size === 0) hintsByAccount.delete(accountKey);
  return [...hints.values()].filter((hint) => timestamp(hint.nextActionAt) != null);
}

function compareUrgentHints(left, right) {
  return Number(right.priority ?? 0) - Number(left.priority ?? 0)
    || timestamp(left.nextActionAt) - timestamp(right.nextActionAt)
    || Number(right.publishedAtMs ?? 0) - Number(left.publishedAtMs ?? 0);
}

function compareNextHints(left, right) {
  return timestamp(left.nextActionAt) - timestamp(right.nextActionAt)
    || Number(right.priority ?? 0) - Number(left.priority ?? 0)
    || Number(right.publishedAtMs ?? 0) - Number(left.publishedAtMs ?? 0);
}

export function selectEffectiveScheduleHint(accountKey, now = Date.now()) {
  const hints = validHints(accountKey, now);
  if (!hints.length) return null;
  const urgent = hints
    .filter((hint) => timestamp(hint.nextActionAt) <= now + URGENT_WINDOW_MS)
    .toSorted(compareUrgentHints);
  const selected = urgent[0] ?? hints.toSorted(compareNextHints)[0];
  return selected ? { ...selected } : null;
}

function publishEffectiveChange(accountKey, previous) {
  const selected = selectEffectiveScheduleHint(accountKey);
  if (sameHint(previous, selected)) return false;
  if (selected) effectiveHints.set(accountKey, selected);
  else effectiveHints.delete(accountKey);
  for (const listener of listeners.get(accountKey) ?? []) notifyListener(listener, selected);
  return true;
}

export function publishScheduleHint(accountKey, hint) {
  if (!accountKey || !hint?.nextActionAt || timestamp(hint.nextActionAt) == null) return false;
  const source = sourceForHint(hint);
  const normalized = {
    ...hint,
    source,
    priority: Number.isFinite(Number(hint.priority)) ? Number(hint.priority) : 0,
    publishedAtMs: Date.now(),
  };
  const previousEffective = effectiveHints.get(accountKey) ?? selectEffectiveScheduleHint(accountKey);
  if (!hintsByAccount.has(accountKey)) hintsByAccount.set(accountKey, new Map());
  const hints = hintsByAccount.get(accountKey);
  const previousSource = hints.get(source);
  if (sameHint(previousSource, normalized)) return false;
  hints.set(source, normalized);
  publishEffectiveChange(accountKey, previousEffective);
  return true;
}

export function clearScheduleHint(accountKey, source) {
  const hints = hintsByAccount.get(accountKey);
  if (!hints?.has(source)) return false;
  const previousEffective = effectiveHints.get(accountKey) ?? selectEffectiveScheduleHint(accountKey);
  hints.delete(source);
  if (hints.size === 0) hintsByAccount.delete(accountKey);
  publishEffectiveChange(accountKey, previousEffective);
  return true;
}

export function subscribeScheduleHints(accountKey, listener) {
  if (!listeners.has(accountKey)) listeners.set(accountKey, new Set());
  listeners.get(accountKey).add(listener);
  queueMicrotask(() => {
    if (!listeners.get(accountKey)?.has(listener)) return;
    const latest = selectEffectiveScheduleHint(accountKey);
    if (latest) notifyListener(listener, latest);
  });
  return () => {
    const accountListeners = listeners.get(accountKey);
    accountListeners?.delete(listener);
    if (accountListeners?.size === 0) listeners.delete(accountKey);
  };
}

export function getLatestScheduleHint(accountKey) {
  const hint = selectEffectiveScheduleHint(accountKey);
  return hint ? { ...hint } : null;
}

export function listScheduleHints(accountKey) {
  return validHints(accountKey).map((hint) => ({ ...hint }));
}

export function clearScheduleHintsForTests() {
  listeners.clear();
  hintsByAccount.clear();
  effectiveHints.clear();
}
