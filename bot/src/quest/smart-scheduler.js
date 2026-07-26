const DEFAULT_IDLE_INTERVAL_MS = 8 * 60 * 60 * 1000;
const MINIMUM_DELAY_MS = 5_000;
const DEADLINE_URGENCY_MS = 30 * 60 * 1000;

function timestamp(value) {
  const time = value == null ? NaN : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function candidate(at, reason, priority) {
  return at == null ? null : { at, reason, priority };
}

function questCandidates(quest, now) {
  const items = [];
  const expiresAt = timestamp(quest.expiresAt);
  const startsAt = timestamp(quest.startsAt);
  const enrollmentBlockedUntil = timestamp(quest.enrollmentBlockedUntil);

  if (quest.completed && !quest.claimed) {
    items.push(candidate(now, `claim:${quest.id}`, 100));
  }
  if (!quest.completed && expiresAt != null && expiresAt - now <= DEADLINE_URGENCY_MS) {
    items.push(candidate(now, `deadline:${quest.id}`, 95));
  }
  if (!quest.completed && startsAt != null && startsAt > now) {
    items.push(candidate(startsAt, `starts:${quest.id}`, 60));
  }
  if (!quest.enrolled && enrollmentBlockedUntil != null && enrollmentBlockedUntil > now) {
    items.push(candidate(enrollmentBlockedUntil, `enrollment:${quest.id}`, 70));
  }
  return items.filter(Boolean);
}

export function chooseNextQuestAction({
  quests = [],
  now = new Date(),
  retryAt = null,
  verificationAt = null,
  fallbackAt = null,
} = {}) {
  const nowMs = now.getTime();
  const candidates = quests.flatMap((quest) => questCandidates(quest, nowMs));
  const retry = timestamp(retryAt);
  const verification = timestamp(verificationAt);
  const fallback = timestamp(fallbackAt) ?? nowMs + DEFAULT_IDLE_INTERVAL_MS;

  if (retry != null) candidates.push(candidate(retry, 'retry', 85));
  if (verification != null) candidates.push(candidate(verification, 'verification', 90));
  candidates.push(candidate(fallback, 'baseline', 10));

  const normalized = candidates
    .filter(Boolean)
    .map((item) => ({
      ...item,
      at: Math.max(nowMs + MINIMUM_DELAY_MS, item.at),
    }))
    .sort((left, right) => (
      right.priority - left.priority || left.at - right.at
    ));

  const urgent = normalized.find((item) => item.at <= nowMs + DEADLINE_URGENCY_MS);
  const selected = urgent ?? normalized.sort((left, right) => left.at - right.at)[0];
  return {
    nextActionAt: new Date(selected.at).toISOString(),
    reason: selected.reason,
    priority: selected.priority,
  };
}

export function stateScheduleReason(state) {
  return {
    WAITING_RATE_LIMIT: 'rate-limit',
    WAITING_ENROLLMENT: 'enrollment',
    WAITING_RETRY: 'retry',
    WAITING_SCHEDULE: 'baseline',
    VERIFYING_PROGRESS: 'verification',
    VERIFYING_COMPLETION: 'verification',
    VERIFYING_CLAIM: 'verification',
  }[state] ?? 'runner';
}
