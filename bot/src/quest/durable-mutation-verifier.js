import { normalizeQuest } from './schema/normalizer.js';
import {
  clearRunnerMutationCheckpoint,
  getRunnerState,
  markRunnerMutationFailed,
  markRunnerMutationVerified,
  RUNNER_MUTATION_KIND,
  RUNNER_STATE,
} from './runner-state-store.js';

export const RUNNER_MUTATION_EVIDENCE = Object.freeze({
  NO_CHECKPOINT: 'NO_CHECKPOINT',
  VERIFIED: 'VERIFIED',
  NOT_APPLIED: 'NOT_APPLIED',
  QUEST_MISSING: 'QUEST_MISSING',
  QUEST_EXPIRED: 'QUEST_EXPIRED',
  QUEST_INCOMPATIBLE: 'QUEST_INCOMPATIBLE',
  COMPLETED: 'COMPLETED',
  CLAIMED: 'CLAIMED',
});

function rawUserStatus(quest) {
  return quest?.user_status ?? null;
}

function alreadyNormalizedQuest(quest) {
  return Boolean(
    quest
    && typeof quest.eventName === 'string'
    && Number.isFinite(Number(quest.progressSecs)),
  );
}

function normalizedQuestForState(state, quest) {
  if (!quest) return null;
  if (alreadyNormalizedQuest(quest)) return quest;
  try {
    return normalizeQuest(quest, {
      preferredEventName: state?.quest_event ?? null,
      preferredProgressKey: state?.metadata?.progressKey ?? null,
    });
  } catch {
    return null;
  }
}

export function questServerProgressSeconds(quest, state = null) {
  const normalized = normalizedQuestForState(state, quest);
  return Number.isFinite(Number(normalized?.progressSecs))
    ? Number(normalized.progressSecs)
    : 0;
}

function questEnrolled(quest) {
  if (typeof quest?.enrolled === 'boolean') return quest.enrolled;
  return Boolean(rawUserStatus(quest)?.enrolled_at);
}

function questClaimed(quest) {
  if (typeof quest?.claimed === 'boolean') return quest.claimed;
  const status = rawUserStatus(quest) ?? {};
  return Boolean(status.claimed_at) || status.orb_quantity_claimed != null;
}

function questCompleted(quest) {
  if (typeof quest?.completed === 'boolean') return quest.completed;
  return Boolean(rawUserStatus(quest)?.completed_at);
}

function questExpiresAt(quest) {
  return quest?.expiresAt ?? quest?.config?.expires_at ?? null;
}

function questExpired(quest, now) {
  const expiresAt = Date.parse(questExpiresAt(quest));
  return Number.isFinite(expiresAt) && expiresAt <= now.getTime();
}

function questIncompatible(quest, normalizedQuest) {
  if (!normalizedQuest) return true;
  return quest?.autoSupported === false
    || normalizedQuest.autoSupported === false
    || (Array.isArray(quest?.compatibilityIssues) && quest.compatibilityIssues.length > 0)
    || (Array.isArray(quest?.schemaIssues) && quest.schemaIssues.length > 0)
    || (
      Array.isArray(normalizedQuest.compatibilityIssues)
      && normalizedQuest.compatibilityIssues.length > 0
    )
    || (Array.isArray(normalizedQuest.schemaIssues) && normalizedQuest.schemaIssues.length > 0);
}

export function isRunnerMutationVerifiedByQuest(state, quest) {
  if (!state?.mutation_kind || !quest) return false;
  if (state.mutation_kind === RUNNER_MUTATION_KIND.ENROLL) return questEnrolled(quest);
  if (state.mutation_kind === RUNNER_MUTATION_KIND.CLAIM) return questClaimed(quest);
  if (questCompleted(quest)) return true;

  const normalizedQuest = normalizedQuestForState(state, quest);
  const progress = questServerProgressSeconds(normalizedQuest, state);
  if (state.mutation_kind === RUNNER_MUTATION_KIND.VIDEO_PROGRESS) {
    const target = Number(state.mutation_payload?.timestamp);
    return Number.isFinite(target) && progress >= Math.floor(target);
  }
  if (state.mutation_kind === RUNNER_MUTATION_KIND.HEARTBEAT) {
    return progress > Number(state.server_progress_seconds ?? 0);
  }
  return false;
}

export function evaluateRunnerMutationEvidence(state, quests, now = new Date()) {
  if (!state?.quest_id || !state.mutation_kind) {
    return {
      outcome: RUNNER_MUTATION_EVIDENCE.NO_CHECKPOINT,
      quest: null,
      normalizedQuest: null,
    };
  }

  const quest = (quests ?? []).find((item) => String(item?.id) === String(state.quest_id)) ?? null;
  if (!quest) {
    return {
      outcome: RUNNER_MUTATION_EVIDENCE.QUEST_MISSING,
      quest: null,
      normalizedQuest: null,
    };
  }
  const normalizedQuest = normalizedQuestForState(state, quest);

  if (state.mutation_kind === RUNNER_MUTATION_KIND.CLAIM && questClaimed(quest)) {
    return { outcome: RUNNER_MUTATION_EVIDENCE.CLAIMED, quest, normalizedQuest };
  }
  if (state.mutation_kind !== RUNNER_MUTATION_KIND.CLAIM && questCompleted(quest)) {
    return { outcome: RUNNER_MUTATION_EVIDENCE.COMPLETED, quest, normalizedQuest };
  }
  if (isRunnerMutationVerifiedByQuest(state, quest)) {
    return { outcome: RUNNER_MUTATION_EVIDENCE.VERIFIED, quest, normalizedQuest };
  }
  if (questExpired(quest, now)) {
    return { outcome: RUNNER_MUTATION_EVIDENCE.QUEST_EXPIRED, quest, normalizedQuest };
  }
  if (questIncompatible(quest, normalizedQuest)) {
    return { outcome: RUNNER_MUTATION_EVIDENCE.QUEST_INCOMPATIBLE, quest, normalizedQuest };
  }
  return { outcome: RUNNER_MUTATION_EVIDENCE.NOT_APPLIED, quest, normalizedQuest };
}

function evidenceError(outcome, questId) {
  const error = new Error(`Runner mutation recovery stopped: ${outcome} for Quest ${questId}`);
  error.name = outcome === RUNNER_MUTATION_EVIDENCE.QUEST_INCOMPATIBLE
    ? 'QuestCompatibilityError'
    : 'RunnerMutationEvidenceError';
  error.code = outcome;
  if ([
    RUNNER_MUTATION_EVIDENCE.QUEST_MISSING,
    RUNNER_MUTATION_EVIDENCE.QUEST_EXPIRED,
  ].includes(outcome)) {
    error.status = 410;
  }
  return error;
}

function verifiedStateFor(outcome, quest, fallback) {
  if (outcome === RUNNER_MUTATION_EVIDENCE.COMPLETED || questCompleted(quest)) {
    return RUNNER_STATE.VERIFYING_COMPLETION;
  }
  if (outcome === RUNNER_MUTATION_EVIDENCE.CLAIMED) return RUNNER_STATE.RUNNING;
  return fallback;
}

export function verifyRunnerMutationFromQuests(jobKey, quests, {
  verifiedState = RUNNER_STATE.RUNNING,
  absentState = RUNNER_STATE.RUNNING,
  finalizeAbsent = false,
  now = new Date(),
} = {}) {
  const state = getRunnerState(jobKey);
  const evidence = evaluateRunnerMutationEvidence(state, quests, now);
  const { outcome, quest, normalizedQuest } = evidence;

  if (outcome === RUNNER_MUTATION_EVIDENCE.NO_CHECKPOINT) {
    return { checked: false, verified: false, retryAllowed: false, ...evidence, state };
  }

  if ([
    RUNNER_MUTATION_EVIDENCE.VERIFIED,
    RUNNER_MUTATION_EVIDENCE.COMPLETED,
    RUNNER_MUTATION_EVIDENCE.CLAIMED,
  ].includes(outcome)) {
    const updated = markRunnerMutationVerified(jobKey, {
      serverProgressSeconds: questServerProgressSeconds(normalizedQuest, state),
      progress: Number.isFinite(Number(normalizedQuest?.progress))
        ? Number(normalizedQuest.progress)
        : undefined,
      state: verifiedStateFor(outcome, quest, verifiedState),
    });
    return {
      checked: true,
      verified: true,
      retryAllowed: false,
      ...evidence,
      state: updated,
    };
  }

  if (!finalizeAbsent) {
    return {
      checked: true,
      verified: false,
      retryAllowed: false,
      preserved: true,
      ...evidence,
      state,
    };
  }

  if (outcome === RUNNER_MUTATION_EVIDENCE.NOT_APPLIED) {
    const updated = clearRunnerMutationCheckpoint(jobKey, absentState);
    return {
      checked: true,
      verified: false,
      retryAllowed: true,
      ...evidence,
      state: updated,
    };
  }

  const updated = markRunnerMutationFailed(jobKey, evidenceError(outcome, state.quest_id), {
    state: absentState,
    nextActionAt: null,
  });
  return {
    checked: true,
    verified: false,
    retryAllowed: false,
    ...evidence,
    state: updated,
  };
}
