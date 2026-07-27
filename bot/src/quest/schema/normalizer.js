import { selectQuestExecutor } from '../executors/registry.js';
import {
  assertQuestObject,
  questCompatibilityIssue,
  QuestCompatibilityError,
} from './compatibility.js';

function questTaskEntries(taskConfig) {
  const tasks = taskConfig?.tasks;
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) return [];
  return Object.entries(tasks);
}

function taskEventType(key, definition) {
  if (typeof definition?.event_name === 'string') return definition.event_name;
  if (typeof definition?.type === 'string') return definition.type;
  return key;
}

function normalizeTaskEntries(entries) {
  return entries.map(([key, definition]) => ({
    key,
    definition,
    type: taskEventType(key, definition),
  }));
}

function progressMapFromStatus(userStatus) {
  const progress = userStatus.progress;
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return {};
  return progress;
}

function selectQuestTask(entries, progressMap) {
  const supported = entries.filter(({ type }) => (
    selectQuestExecutor(type).supportsAutomaticProgress
  ));
  const matching = supported.find(({ key, type }) => (
    progressMap[key] != null || progressMap[type] != null
  ));
  if (matching) return matching;
  if (supported.length) return supported[0];
  if (entries.length) return entries[0];
  return { key: 'UNKNOWN_SCHEMA', type: 'UNKNOWN_SCHEMA', definition: { target: 0 } };
}

function validateQuestTask(rawId, taskConfig, entries, selectedTask) {
  const schemaIssues = [];
  if (!entries.length) {
    schemaIssues.push(questCompatibilityIssue(
      'TASK_DEFINITIONS_MISSING',
      `quest ${rawId}: missing task definitions`,
    ));
  }
  const secondsNeeded = Number(selectedTask.definition?.target ?? 0);
  const autoSupported = !(
    (taskConfig?.join_operator ?? 'or') === 'and' && entries.length > 1
  );
  if (!autoSupported) {
    schemaIssues.push(questCompatibilityIssue(
      'MULTI_TASK_AND',
      `quest ${rawId}: multi-task join_operator=and requires every task`,
    ));
  }
  if (!Number.isFinite(secondsNeeded) || secondsNeeded <= 0) {
    schemaIssues.push(questCompatibilityIssue(
      'TASK_TARGET_INVALID',
      `quest ${rawId}: invalid target for ${selectedTask.type}`,
    ));
  }
  return { autoSupported, schemaIssues, secondsNeeded };
}

function progressSeconds(userStatus, progressKey, eventName, secondsNeeded) {
  const rawProgress = userStatus.progress;
  if (rawProgress && typeof rawProgress === 'object' && !Array.isArray(rawProgress)) {
    const eventProgress = rawProgress[progressKey] ?? rawProgress[eventName];
    if (eventProgress && typeof eventProgress === 'object') {
      return Number(eventProgress.value ?? 0);
    }
    return Number(eventProgress ?? 0);
  }
  if (typeof rawProgress === 'string' || typeof rawProgress === 'number') {
    return (Number.parseFloat(rawProgress) / 100) * secondsNeeded;
  }
  const streamProgress = Number(userStatus.stream_progress_seconds);
  return Number.isFinite(streamProgress) ? streamProgress : 0;
}

function rewardPlatforms(config) {
  const platforms = config.rewards_config?.platforms;
  if (!Array.isArray(platforms)) return [];
  return platforms.map(Number).filter(Number.isInteger);
}

function questProgressPercent(completedSeconds, secondsNeeded) {
  if (secondsNeeded <= 0) return 0;
  return Math.min(100, (completedSeconds / secondsNeeded) * 100);
}

export function normalizeQuest(raw) {
  assertQuestObject(raw);
  const config = raw.config ?? {};
  const userStatus = raw.user_status ?? {};
  const taskConfig = config.task_config_v2 ?? config.task_config;
  const taskEntries = questTaskEntries(taskConfig);
  const normalizedEntries = normalizeTaskEntries(taskEntries);
  const selectedTask = selectQuestTask(normalizedEntries, progressMapFromStatus(userStatus));
  const validation = validateQuestTask(raw.id, taskConfig, taskEntries, selectedTask);
  const completedSeconds = progressSeconds(
    userStatus,
    selectedTask.key,
    selectedTask.type,
    validation.secondsNeeded,
  );

  return {
    id: raw.id,
    name: config.messages?.quest_name ?? raw.id,
    applicationId: config.application?.id ?? null,
    rewardPlatforms: rewardPlatforms(config),
    startsAt: config.starts_at ?? null,
    expiresAt: config.expires_at ?? null,
    eventName: selectedTask.type,
    progress: questProgressPercent(completedSeconds, validation.secondsNeeded),
    secondsNeeded: validation.secondsNeeded,
    progressSecs: completedSeconds,
    progressKey: selectedTask.key,
    autoSupported: validation.autoSupported,
    enrolledAt: userStatus.enrolled_at ?? null,
    enrolled: Boolean(userStatus.enrolled_at),
    completed: Boolean(userStatus.completed_at),
    claimed: Boolean(userStatus.claimed_at) || userStatus.orb_quantity_claimed != null,
    schemaIssues: validation.schemaIssues.map((issue) => issue.message),
    compatibilityIssues: validation.schemaIssues,
  };
}

export function normalizeQuestPayload(payload, enrollmentBlockedUntil = null) {
  if (!Array.isArray(payload)) {
    throw new QuestCompatibilityError('Quest payload must be an array', {
      code: 'QUEST_PAYLOAD_NOT_ARRAY',
    });
  }
  return payload.map((quest) => ({
    ...normalizeQuest(quest),
    enrollmentBlockedUntil,
  }));
}
