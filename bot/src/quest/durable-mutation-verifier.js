import {
  clearRunnerMutationCheckpoint,
  getRunnerState,
  markRunnerMutationVerified,
  RUNNER_MUTATION_KIND,
  RUNNER_STATE,
} from './runner-state-store.js';

function rawUserStatus(quest) {
  return quest?.user_status ?? null;
}

function maxNumericProgress(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return Math.max(0, ...value.map(maxNumericProgress));
  return Math.max(0, ...Object.values(value).map((entry) => (
    entry && typeof entry === 'object' && Object.hasOwn(entry, 'value')
      ? maxNumericProgress(entry.value)
      : maxNumericProgress(entry)
  )));
}

export function questServerProgressSeconds(quest) {
  if (Number.isFinite(Number(quest?.progressSecs))) return Number(quest.progressSecs);
  const status = rawUserStatus(quest) ?? {};
  return Math.max(
    maxNumericProgress(status.progress),
    Number(status.stream_progress_seconds) || 0,
  );
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

export function isRunnerMutationVerifiedByQuest(state, quest) {
  if (!state?.mutation_kind || !quest) return false;
  if (state.mutation_kind === RUNNER_MUTATION_KIND.ENROLL) return questEnrolled(quest);
  if (state.mutation_kind === RUNNER_MUTATION_KIND.CLAIM) return questClaimed(quest);
  if (questCompleted(quest)) return true;

  const progress = questServerProgressSeconds(quest);
  if (state.mutation_kind === RUNNER_MUTATION_KIND.VIDEO_PROGRESS) {
    const target = Number(state.mutation_payload?.timestamp);
    return Number.isFinite(target) && progress >= Math.floor(target);
  }
  if (state.mutation_kind === RUNNER_MUTATION_KIND.HEARTBEAT) {
    return progress > Number(state.server_progress_seconds ?? 0);
  }
  return false;
}

export function verifyRunnerMutationFromQuests(jobKey, quests, {
  verifiedState = RUNNER_STATE.RUNNING,
  absentState = RUNNER_STATE.RUNNING,
} = {}) {
  const state = getRunnerState(jobKey);
  if (!state?.quest_id || !state.mutation_kind) {
    return { checked: false, verified: false, state };
  }
  const quest = (quests ?? []).find((item) => String(item?.id) === String(state.quest_id));
  const verified = isRunnerMutationVerifiedByQuest(state, quest);
  if (verified) {
    const updated = markRunnerMutationVerified(jobKey, {
      serverProgressSeconds: questServerProgressSeconds(quest),
      progress: Number.isFinite(Number(quest?.progress)) ? Number(quest.progress) : undefined,
      state: questCompleted(quest) ? RUNNER_STATE.VERIFYING_COMPLETION : verifiedState,
    });
    return { checked: true, verified: true, quest, state: updated };
  }

  const updated = clearRunnerMutationCheckpoint(jobKey, absentState);
  return { checked: true, verified: false, quest: quest ?? null, state: updated };
}
