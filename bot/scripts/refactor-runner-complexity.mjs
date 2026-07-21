import fs from 'node:fs';

const file = new URL('../src/discord-runner.js', import.meta.url);
let source = fs.readFileSync(file, 'utf8');
let changes = 0;

function replaceRange(startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`Missing refactor anchor: ${label}`);
  source = source.slice(0, start) + replacement + source.slice(end);
  changes++;
}

function replaceTail(startMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing refactor anchor: ${label}`);
  source = source.slice(0, start) + replacement;
  changes++;
}

replaceRange(
  'export async function fetchQuests(token, signal, explicitStatusContext = null) {',
  'async function readFreshQuestForMutation',
  `function extractQuestArray(candidate) {
  if (Array.isArray(candidate)) return candidate;
  if (candidate && typeof candidate === 'object' && Array.isArray(candidate.quests)) {
    return candidate.quests;
  }
  return null;
}

function createQuestPayload(candidate, path) {
  const quests = extractQuestArray(candidate);
  if (!quests) {
    throw new QuestCompatibilityError(
      \`Quest API schema changed at \${path}: expected an array or { quests: [] }\`,
    );
  }
  return {
    path,
    quests,
    excludedCount: Array.isArray(candidate?.excluded_quests)
      ? candidate.excluded_quests.length
      : 0,
    enrollmentBlockedUntil: candidate?.quest_enrollment_blocked_until ?? null,
  };
}

function classifyQuestEndpointFailure(error, signal, hasEmptyCandidate) {
  if (isAbortFailure(error, signal)) throw abortFailure();
  if (!isFatalAuthError(error)) {
    return { lastError: error, fatalError: null, stop: false };
  }
  if (error.status === 401) {
    recordQuestError(error);
    throw error;
  }
  return { lastError: error, fatalError: error, stop: hasEmptyCandidate };
}

async function throwQuestEndpointFailure({ signal, fatalError, lastError }) {
  if (signal?.aborted) throw abortFailure();
  if (fatalError) {
    recordQuestError(fatalError);
    throw fatalError;
  }
  const error = lastError instanceof QuestCompatibilityError
    ? lastError
    : new QuestCompatibilityError(
      \`Quest API endpoints unavailable: \${lastError?.message ?? 'unknown error'}\`,
    );
  recordQuestError(error);
  await reportCriticalError('Quest API compatibility', error);
  throw error;
}

async function selectQuestPayload(token, signal) {
  let emptyCandidate = null;
  let lastError = null;
  let fatalError = null;

  for (const path of QUEST_LIST_PATHS) {
    try {
      const candidate = await discordFetch(token, path, { signal });
      const payload = createQuestPayload(candidate, path);
      if (payload.quests.length > 0) return payload;
      emptyCandidate ??= payload;
    } catch (error) {
      const failure = classifyQuestEndpointFailure(error, signal, Boolean(emptyCandidate));
      lastError = failure.lastError;
      fatalError = failure.fatalError ?? fatalError;
      if (failure.stop) break;
    }
  }

  if (emptyCandidate) return emptyCandidate;
  return throwQuestEndpointFailure({ signal, fatalError, lastError });
}

async function normalizeQuestPayload(payload) {
  try {
    return payload.quests.map((quest) => ({
      ...normalizeQuest(quest),
      enrollmentBlockedUntil: payload.enrollmentBlockedUntil,
    }));
  } catch (error) {
    const compatibilityError = error instanceof QuestCompatibilityError
      ? error
      : new QuestCompatibilityError(\`Quest payload could not be parsed: \${error.message}\`);
    recordQuestError(compatibilityError);
    await reportCriticalError('Quest API compatibility', compatibilityError);
    throw compatibilityError;
  }
}

function summarizeQuestCompatibility(quests) {
  const unknownEvents = [...new Set(
    quests
      .filter((quest) => !isSupportedEvent(quest.eventName) && !SKIP_EVENTS.has(quest.eventName))
      .map((quest) => quest.eventName),
  )];
  return {
    unknownEvents,
    schemaIssues: quests.flatMap((quest) => quest.schemaIssues),
  };
}

async function reportQuestCompatibility(summary) {
  if (!summary.schemaIssues.length && !summary.unknownEvents.length) return;
  const details = [
    ...summary.schemaIssues,
    summary.unknownEvents.length ? \`unknown events: \${summary.unknownEvents.join(', ')}\` : '',
  ].filter(Boolean).join('; ');
  await reportCriticalError(
    'Quest API compatibility',
    new QuestCompatibilityError(details),
  );
}

export async function fetchQuests(token, signal, explicitStatusContext = null) {
  if (explicitStatusContext) {
    const context = normalizeStatusContext(explicitStatusContext);
    return questStatusStorage.run(context, () => fetchQuests(token, signal));
  }

  const statusContext = currentQuestStatusContext();
  recordQuestAttempt(statusContext.key, statusContext);
  const payload = await selectQuestPayload(token, signal);
  const quests = await normalizeQuestPayload(payload);
  const summary = summarizeQuestCompatibility(quests);

  recordQuestSuccess(statusContext.key, {
    state: summary.schemaIssues.length || summary.unknownEvents.length ? 'degraded' : 'compatible',
    questCount: quests.length,
    excludedCount: payload.excludedCount,
    enrollmentBlockedUntil: payload.enrollmentBlockedUntil,
    supportedCount: quests.filter((quest) => !quest.completed && isRunnableQuest(quest)).length,
    unknownEvents: summary.unknownEvents,
    schemaIssues: summary.schemaIssues,
    questListPath: payload.path,
  }, statusContext);

  await reportQuestCompatibility(summary);
  return quests;
}

`,
  'fetchQuests',
);

replaceRange(
  'export function normalizeQuest(raw) {',
  'function sleep',
  `function questTaskEntries(taskConfig) {
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
  const supported = entries.filter(({ type }) => isSupportedEvent(type));
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
  if (!entries.length) schemaIssues.push(\`quest \${rawId}: missing task definitions\`);
  const secondsNeeded = Number(selectedTask.definition?.target ?? 0);
  const autoSupported = !(
    (taskConfig?.join_operator ?? 'or') === 'and' && entries.length > 1
  );
  if (!autoSupported) {
    schemaIssues.push(\`quest \${rawId}: multi-task join_operator=and requires every task\`);
  }
  if (!Number.isFinite(secondsNeeded) || secondsNeeded <= 0) {
    schemaIssues.push(\`quest \${rawId}: invalid target for \${selectedTask.type}\`);
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

export function normalizeQuest(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) {
    throw new QuestCompatibilityError('Quest item is missing a valid id');
  }

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
  const progress = validation.secondsNeeded > 0
    ? Math.min(100, (completedSeconds / validation.secondsNeeded) * 100)
    : 0;

  return {
    id: raw.id,
    name: config.messages?.quest_name ?? raw.id,
    eventName: selectedTask.type,
    progress,
    secondsNeeded: validation.secondsNeeded,
    progressSecs: completedSeconds,
    progressKey: selectedTask.key,
    applicationId: config.application?.id ?? null,
    rewardPlatforms: rewardPlatforms(config),
    autoSupported: validation.autoSupported,
    startsAt: config.starts_at ?? null,
    expiresAt: config.expires_at ?? null,
    enrolledAt: userStatus.enrolled_at ?? null,
    enrolled: Boolean(userStatus.enrolled_at),
    completed: Boolean(userStatus.completed_at),
    claimed: Boolean(userStatus.claimed_at) || userStatus.orb_quantity_claimed != null,
    schemaIssues: validation.schemaIssues,
  };
}

`,
  'normalizeQuest',
);

replaceRange(
  '  const runPromise = questStatusStorage.run(runnerStatusContext, async () => {',
  '  const currentJob = jobs.get(jobKey);',
  `  async function initializeRunnerSession() {
    if (!accountId || !initialUsername) {
      const me = await fetchMe(userToken, signal);
      username = me.username ?? 'unknown';
      accountId = me.id ?? accountId;
    }
    const job = jobs.get(jobKey);
    if (job) job.accountId = accountId;
    Object.assign(runnerStatusContext, { accountId, username });
    setQuestStatusLifecycle(runnerStatusContext.key, 'running', runnerStatusContext);
    addLog(\`✅ LOGIN : \${username}\`);
    if (mode === 'scheduled') {
      addLog('🤖 AUTO DAILY ENABLED — CHECK 00:00 / 08:00 / 16:00');
    }
    await render();
  }

  async function restoreInitialSchedule() {
    if (mode !== 'scheduled' || !initialNextCheckAt) return;
    const restoredAt = new Date(initialNextCheckAt);
    if (!Number.isFinite(restoredAt.getTime()) || restoredAt.getTime() <= Date.now()) return;
    nextCheckAt = restoredAt.toISOString();
    addLog(\`⏰ \${username}: NEXT CHECK \${formatScheduleTime(restoredAt)}\`);
    await render();
    await sleep(restoredAt.getTime() - Date.now(), signal);
  }

  async function runRoundSafely() {
    try {
      const outcome = await runQuestRound();
      persistSchedule({ lastCheckAt: new Date().toISOString(), lastError: null });
      return outcome;
    } catch (error) {
      if (error.message === 'aborted' || isFatalAuthError(error) || mode === 'oneshot') {
        throw error;
      }
      addLog(\`⚠️ \${username}: CHECK ERROR — \${error.message}\`);
      await render();
      persistSchedule({
        lastCheckAt: new Date().toISOString(),
        lastError: error.message,
      });
      return { attempted: false, progressed: false, supportedCount: 0 };
    }
  }

  function nextOneShotState(noProgressRounds, outcome) {
    if (outcome.supportedCount === 0) return { stop: true, noProgressRounds };
    const nextRounds = outcome.progressed ? 0 : noProgressRounds + 1;
    return { stop: nextRounds >= 3, noProgressRounds: nextRounds };
  }

  async function waitForVerificationRecheck(state, outcome) {
    const recheck = nextRecheckState({
      isRecheck: state.isRecheck,
      rechecksRemaining: state.rechecksRemaining,
      attempted: outcome.attempted,
      progressed: outcome.progressed,
    });
    if (!recheck.shouldRecheck) return null;

    const checkNumber = 4 - recheck.rechecksRemaining;
    nextCheckAt = new Date(Date.now() + RECHECK_INTERVAL_MS).toISOString();
    persistSchedule({ nextCheckAt });
    addLog(\`🔁 \${username}: VERIFY \${checkNumber}/3 — อีก 5 นาที\`);
    await render();
    countAlreadyReported = false;
    await sleep(RECHECK_INTERVAL_MS, signal);
    return { isRecheck: true, rechecksRemaining: recheck.rechecksRemaining };
  }

  async function waitForNextScheduledCheck() {
    const scheduledAt = addScheduleJitter(
      nextScheduledCheck(new Date(), config.timezone),
    );
    nextCheckAt = scheduledAt.toISOString();
    persistSchedule({ nextCheckAt });
    addLog(\`💤 \${username}: AUTO DAILY ACTIVE\`);
    addLog(\`⏰ \${username}: NEXT CHECK \${formatScheduleTime(scheduledAt)}\`);
    await render();
    countAlreadyReported = false;
    await sleep(scheduledAt.getTime() - Date.now(), signal);
  }

  async function handleScheduledIdle(state, outcome) {
    const recheckState = await waitForVerificationRecheck(state, outcome);
    if (recheckState) return recheckState;
    await waitForNextScheduledCheck();
    return { isRecheck: false, rechecksRemaining: 0 };
  }

  async function runQuestLoop() {
    let noProgressRounds = 0;
    let scheduleState = { isRecheck: false, rechecksRemaining: 0 };

    while (!signal.aborted) {
      const outcome = await runRoundSafely();
      if (mode === 'oneshot') {
        const oneShotState = nextOneShotState(noProgressRounds, outcome);
        noProgressRounds = oneShotState.noProgressRounds;
        if (oneShotState.stop) break;
        continue;
      }
      if (outcome.progressed && outcome.supportedCount > 0) continue;
      scheduleState = await handleScheduledIdle(scheduleState, outcome);
    }
  }

  async function handleRunnerFailure(error) {
    if (error.message === 'aborted') {
      if (mode === 'scheduled') {
        addLog(\`🛑 \${username}: STOPPED BY USER\`);
        await render();
      }
      return;
    }
    if (isFatalAuthError(error)) {
      addLog(\`🔐 \${username}: TOKEN INVALID — RUNNER DISABLED (\${error.status})\`);
      await render();
      if (scheduleId != null) deleteScheduledRunner(scheduleId, ownerId);
      await reportCriticalError(
        'Runner authentication',
        new Error(\`\${username}: Discord API \${error.status}; runner disabled\`),
      );
      return;
    }
    addLog(\`❌ \${username}: \${error.message}\`);
    await render();
    persistSchedule({ lastError: error.message });
  }

  async function cleanupRunnerSession() {
    await reportOneShotLogout();
    signal.removeEventListener('abort', clearPendingRender);
    const hadPendingRender = Boolean(pendingTimer);
    clearPendingRender();
    await flushPromise;
    if (hadPendingRender) await flush();
    setQuestStatusLifecycle(runnerStatusContext.key, 'stopped', {
      ...runnerStatusContext,
      accountId,
      username,
    });
    jobs.delete(jobKey);
  }

  async function executeRunnerLifecycle() {
    try {
      await initializeRunnerSession();
      await restoreInitialSchedule();
      await runQuestLoop();
    } catch (error) {
      await handleRunnerFailure(error);
    } finally {
      await cleanupRunnerSession();
    }
  }

  const runPromise = questStatusStorage.run(
    runnerStatusContext,
    executeRunnerLifecycle,
  );

`,
  'runner lifecycle',
);

replaceTail(
  'async function runGameQuest(token, quest, signal, onServerProgress, _speedMultiplier, heartbeatSecs) {',
  `async function sendQuestHeartbeat(token, quest, terminal, useApplicationPayload, signal) {
  if (useApplicationPayload) {
    return sendApplicationHeartbeat(token, quest, terminal, signal);
  }
  return sendGameHeartbeat(token, quest, terminal, signal);
}

function nextGameProgressState(fresh, current, unchangedChecks, forceApplicationPayload) {
  if (fresh.progressSecs > current || fresh.completed) {
    return { unchangedChecks: 0, forceApplicationPayload };
  }
  return {
    unchangedChecks: unchangedChecks + 1,
    forceApplicationPayload: forceApplicationPayload || Boolean(fresh.applicationId),
  };
}

function assertGameProgress(unchangedChecks) {
  if (unchangedChecks >= 5) {
    throw new Error('Discord ไม่ยืนยัน game progress หลัง heartbeat 5 ครั้ง');
  }
}

async function finishGameQuest(token, quest, signal, onServerProgress, useApplicationPayload) {
  await sendQuestHeartbeat(token, quest, true, useApplicationPayload, signal);
  await sleep(1000, signal);
  const fresh = await fetchFreshQuest(token, quest.id, signal);
  await onServerProgress(fresh);
  return fresh;
}

async function runGameQuest(token, quest, signal, onServerProgress, _speedMultiplier, heartbeatSecs) {
  let fresh = quest;
  let current = fresh.progressSecs;
  const intervalSecs = Math.max(1, Number(heartbeatSecs) || 30);
  let unchangedChecks = 0;
  let forceApplicationPayload = false;

  while (!fresh.completed && current < fresh.secondsNeeded) {
    if (signal.aborted) throw new Error('aborted');
    await sendQuestHeartbeat(token, fresh, false, forceApplicationPayload, signal);
    await sleep(1000, signal);
    fresh = await fetchFreshQuest(token, quest.id, signal);
    await onServerProgress(fresh);

    const progressState = nextGameProgressState(
      fresh,
      current,
      unchangedChecks,
      forceApplicationPayload,
    );
    unchangedChecks = progressState.unchangedChecks;
    forceApplicationPayload = progressState.forceApplicationPayload;
    assertGameProgress(unchangedChecks);
    current = Math.max(current, fresh.progressSecs);

    if (!fresh.completed && current < fresh.secondsNeeded) {
      await sleep(Math.max(0, intervalSecs - 1) * 1000, signal);
    }
  }

  if (fresh.completed) return fresh;
  return finishGameQuest(
    token,
    fresh,
    signal,
    onServerProgress,
    forceApplicationPayload,
  );
}
`,
  'runGameQuest',
);

if (changes !== 4) throw new Error(`Expected 4 refactors, got ${changes}`);
fs.writeFileSync(file, source);
console.log(`Applied ${changes} Runner complexity refactors`);
