import 'dotenv/config';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config.js';
import {
  addScheduleJitter,
  nextRecheckState,
  nextScheduledCheck,
  RECHECK_INTERVAL_MS,
  transientRetryDelayMs,
} from './runner-schedule.js';
import { fetchWithRetry } from './http-retry.js';
import { executeVerifiedMutation } from './mutation-retry.js';
import { settleWithTimeout } from './async-settle.js';
import {
  clearQuestStatuses as clearStoredQuestStatuses,
  getQuestStatus as getStoredQuestStatus,
  listQuestStatuses as listStoredQuestStatuses,
  recordQuestAttempt,
  recordQuestFailure,
  recordQuestSuccess,
  recordQuestVerification,
  setQuestStatusLifecycle,
} from './quest-status-store.js';
import { reportCriticalError } from './error-reporter.js';
import {
  decryptRunnerToken,
  deleteScheduledRunner,
  listScheduledRunners,
  updateScheduledRunner,
} from './scheduled-runner-store.js';
import {
  completeOneShotQuest,
  createOneShotQuestSession,
  failOneShotQuest,
  getNextPendingOneShotQuest,
  getOneShotSessionSummary,
  isOneShotSessionComplete,
  markOneShotProgressMutationSent,
  markOneShotQuestRunning,
  ONE_SHOT_QUEST_STATUS,
  recordOneShotVerifiedProgress,
} from './one-shot-quest-session.js';

const DISCORD_API = 'https://discord.com/api/v9';
const QUEST_LIST_PATHS = ['/quests/@me', '/users/@me/quests'];
const FATAL_FORBIDDEN_PATHS = new Set(['/users/@me', ...QUEST_LIST_PATHS]);

export class DiscordApiError extends Error {
  constructor(status, path, data) {
    super(`Discord API ${status} at ${path}`);
    this.name = 'DiscordApiError';
    this.status = status;
    this.path = path;
    this.data = data;
    this.fatalAuth = status === 401 || (status === 403 && FATAL_FORBIDDEN_PATHS.has(path));
  }
}

export function isFatalAuthError(error) {
  return error?.fatalAuth === true;
}

// ── Build info — hardcoded fallbacks, overwritten by refreshBuildInfo() ────────
const FALLBACK = Object.freeze({
  clientVersion:   '1.0.9267',
  chromeVersion:   '138.0.7204.251',
  electronVersion: '37.6.0',
  buildNumber:     572700,
  nativeBuildNumber: 47491,
});

let live = {
  clientVersion: process.env.DISCORD_CLIENT_VERSION?.trim() || FALLBACK.clientVersion,
  chromeVersion: process.env.DISCORD_CHROME_VERSION?.trim() || FALLBACK.chromeVersion,
  electronVersion: process.env.DISCORD_ELECTRON_VERSION?.trim() || FALLBACK.electronVersion,
  buildNumber: Number.parseInt(process.env.DISCORD_BUILD_NUMBER ?? '', 10) || FALLBACK.buildNumber,
  nativeBuildNumber: Number.parseInt(process.env.DISCORD_NATIVE_BUILD_NUMBER ?? '', 10) || FALLBACK.nativeBuildNumber,
};
const clientLocale = process.env.DISCORD_LOCALE?.trim() || 'en-US';
const clientTimezone = process.env.DISCORD_TIMEZONE?.trim() || config.timezone;

// ── Auto-fetch helpers ─────────────────────────────────────────────────────────

/**
 * Keep one coherent client profile for the whole process. Override all related
 * values together through Environment Variables after verifying a Discord update.
 */
export async function refreshBuildInfo() {
  console.log(
    `🔄 Client profile — Client: ${live.clientVersion} | Build: ${live.buildNumber} | Chrome: ${live.chromeVersion} | Electron: ${live.electronVersion}`,
  );
  return { ...live, locale: clientLocale, timezone: clientTimezone };
}

// ── Dynamic header builders (always read from `live`) ─────────────────────────

function _userAgent() {
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/${live.clientVersion} Chrome/${live.chromeVersion} Electron/${live.electronVersion} Safari/537.36`;
}

function buildSuperProperties() {
  const ua = _userAgent();
  return Buffer.from(JSON.stringify({
    os: 'Windows',
    browser: 'Discord Client',
    release_channel: 'stable',
    client_version: live.clientVersion,
    os_version: '10.0.22631',
    os_arch: 'x64',
    app_arch: 'x64',
    system_locale: clientLocale,
    browser_user_agent: ua,
    browser_version: live.chromeVersion,
    client_build_number: live.buildNumber,
    native_build_number: live.nativeBuildNumber,
    client_event_source: null,
    design_id: 0,
  })).toString('base64');
}

function userHeaders(token, path = '') {
  const ua          = _userAgent();
  const chromeMajor = live.chromeVersion.split('.')[0];
  return {
    Authorization: token,
    'Content-Type': 'application/json',
    'User-Agent': ua,
    'X-Super-Properties': buildSuperProperties(),
    'X-Debug-Options': 'bugReporterEnabled',
    'X-Discord-Locale': clientLocale,
    'X-Discord-Timezone': clientTimezone,
    'Accept': '*/*',
    'Accept-Language': `${clientLocale},en;q=0.9`,
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Referer': path.startsWith('/quests/')
      ? 'https://discord.com/quest-home'
      : 'https://discord.com/channels/@me',
    'Origin': 'https://discord.com',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'sec-ch-ua': `"Chromium";v="${chromeMajor}", "Not)A;Brand";v="8"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };
}

async function discordFetch(token, path, options = {}, policy = {}) {
  const { headers = {}, ...requestOptions } = options;
  const method = String(requestOptions.method ?? 'GET').toUpperCase();
  const requestPolicy = method === 'POST'
    ? { ...policy, retryRateLimits: false }
    : policy;
  const res = await fetchWithRetry(`${DISCORD_API}${path}`, {
    ...requestOptions,
    headers: { ...userHeaders(token, path), ...headers },
  }, requestPolicy);
  if (res.status === 204) return { ok: true, status: 204 };
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    throw new DiscordApiError(res.status, path, data);
  }
  return data;
}

// Quest event names → which API to use
// VIDEO  → POST /quests/{id}/video-progress
// STREAM → POST /quests/{id}/heartbeat
// SKIP   → cannot complete via API (requires real game/console/activity)
const VIDEO_EVENTS  = new Set(['WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE']);
const GAME_EVENTS   = new Set(['PLAY_ON_DESKTOP', 'PLAY_ON_DESKTOP_V2']);
const STREAM_EVENTS = new Set(['STREAM_ON_DESKTOP']);
const SKIP_EVENTS   = new Set(['ACHIEVEMENT_IN_GAME', 'ACHIEVEMENT_IN_ACTIVITY', 'PLAY_ACTIVITY',
                                'PLAY_ON_XBOX', 'PLAY_ON_PLAYSTATION', 'progress',
                                ...STREAM_EVENTS]);

function isVideoEvent(eventName) {
  return VIDEO_EVENTS.has(eventName) || /^WATCH_VIDEO(?:_|$)/.test(eventName);
}

function isGameEvent(eventName) {
  return GAME_EVENTS.has(eventName) || /^PLAY_ON_DESKTOP(?:_V\d+)?$/.test(eventName);
}

function isSupportedEvent(eventName) {
  return isVideoEvent(eventName) || isGameEvent(eventName);
}

function questUnavailableReason(quest, now = Date.now()) {
  if (quest.autoSupported === false) return 'ต้องทำหลาย task พร้อมกัน';
  const enrollmentBlockedUntil = Date.parse(quest.enrollmentBlockedUntil);
  if (!quest.enrolled && Number.isFinite(enrollmentBlockedUntil) && enrollmentBlockedUntil > now) {
    return 'Discord ยังไม่เปิดให้รับ Quest';
  }
  const startsAt = Date.parse(quest.startsAt);
  if (Number.isFinite(startsAt) && startsAt > now) return 'ยังไม่เริ่ม';
  const expiresAt = Date.parse(quest.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt <= now) return 'หมดเวลาแล้ว';
  return null;
}

function isRunnableQuest(quest) {
  return isSupportedEvent(quest.eventName) && !questUnavailableReason(quest);
}

function oneShotFreshQuestFailureReason(error) {
  if (error instanceof QuestCompatibilityError && /disappeared from Quest API/.test(error.message)) {
    return 'ไม่พบ Quest ในรายการล่าสุดจาก Discord';
  }
  return 'ตรวจสอบสถานะ Quest ล่าสุดไม่สำเร็จ';
}

function oneShotUnavailableReason(quest) {
  const reason = questUnavailableReason(quest);
  if (reason === 'หมดเวลาแล้ว') return 'Quest หมดเวลาก่อนดำเนินการเสร็จ';
  if (reason === 'Discord ยังไม่เปิดให้รับ Quest') {
    return 'Discord ยังไม่เปิดให้ดำเนินการ Quest';
  }
  return reason || 'Quest ไม่พร้อมให้ดำเนินการ';
}

export function selectQuestClaimPlatform(quest) {
  const platforms = Array.isArray(quest?.rewardPlatforms)
    ? quest.rewardPlatforms.filter(Number.isInteger)
    : [];
  if (platforms.length === 0) return 0;
  if (platforms.includes(4)) return 4;
  if (platforms.includes(0)) return 0;
  if (platforms.length === 1) return platforms[0];
  return null;
}

function isAbortFailure(error, signal) {
  return signal?.aborted
    || error?.name === 'AbortError'
    || error?.message === 'aborted';
}

function abortFailure() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function isCaptchaChallenge(error) {
  const data = error?.data;
  return Boolean(
    data?.captcha_sitekey
    || data?.captcha_service
    || data?.captcha_rqtoken
    || data?.captcha_rqdata
    || data?.captcha_key,
  );
}

const questStatusStorage = new AsyncLocalStorage();

function normalizeStatusContext(context = {}) {
  if (typeof context === 'string') return { key: context };
  return {
    key: context.key || context.jobKey || 'system',
    ownerId: context.ownerId ?? null,
    accountId: context.accountId ?? null,
    username: context.username ?? null,
    jobKey: context.jobKey ?? null,
    mode: context.mode ?? null,
    lifecycle: context.lifecycle ?? 'running',
  };
}

function currentQuestStatusContext() {
  return questStatusStorage.getStore() ?? normalizeStatusContext();
}

export class QuestCompatibilityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuestCompatibilityError';
  }
}

export function getQuestEngineStatus(statusKey = null) {
  return getStoredQuestStatus(statusKey);
}

export function listQuestEngineStatuses(options = {}) {
  return listStoredQuestStatuses(options);
}

export function clearQuestEngineStatuses() {
  clearStoredQuestStatuses();
}

function recordQuestError(error) {
  const context = currentQuestStatusContext();
  recordQuestFailure(
    context.key,
    error,
    error instanceof QuestCompatibilityError,
    context,
  );
}

export async function fetchMe(token, signal) {
  return discordFetch(token, '/users/@me', { signal });
}

function extractQuestArray(candidate) {
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
      `Quest API schema changed at ${path}: expected an array or { quests: [] }`,
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
      `Quest API endpoints unavailable: ${lastError?.message ?? 'unknown error'}`,
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
      : new QuestCompatibilityError(`Quest payload could not be parsed: ${error.message}`);
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
    summary.unknownEvents.length ? `unknown events: ${summary.unknownEvents.join(', ')}` : '',
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

async function readFreshQuestForMutation(token, questId, signal) {
  return (await fetchQuests(token, signal)).find((quest) => quest.id === questId) ?? null;
}

async function verifiedQuestMutation({ token, questId, signal, perform, predicate }) {
  return executeVerifiedMutation({
    perform,
    signal,
    verify: async () => {
      const fresh = await readFreshQuestForMutation(token, questId, signal);
      return Boolean(fresh && predicate(fresh));
    },
  });
}

async function enrollQuest(token, questId, signal) {
  return verifiedQuestMutation({
    token,
    questId,
    signal,
    predicate: (fresh) => fresh.enrolled,
    perform: () => discordFetch(token, `/quests/${questId}/enroll`, {
      method: 'POST',
      body: JSON.stringify({
        location: 11,
        is_targeted: false,
        metadata_raw: null,
      }),
      signal,
    }),
  });
}

async function claimQuest(token, questId, platform, signal) {
  const perform = async () => {
    try {
      return await discordFetch(token, `/quests/${questId}/claim-reward`, {
        method: 'POST',
        body: JSON.stringify({ location: 11, platform }),
        signal,
      });
    } catch (error) {
      if (error?.status !== 404) throw error;
      return discordFetch(token, `/quests/${questId}/claim`, {
        method: 'POST',
        body: JSON.stringify({ location: 1, platform }),
        signal,
      });
    }
  };
  return verifiedQuestMutation({
    token,
    questId,
    signal,
    perform,
    predicate: (fresh) => fresh.claimed,
  });
}

async function sendVideoProgress(token, questId, timestamp, signal) {
  const ts = Math.round(timestamp + Math.random() * 0.5);
  return verifiedQuestMutation({
    token,
    questId,
    signal,
    predicate: (fresh) => fresh.completed || fresh.progressSecs >= Math.floor(timestamp),
    perform: () => discordFetch(token, `/quests/${questId}/video-progress`, {
      method: 'POST',
      body: JSON.stringify({ timestamp: ts }),
      signal,
    }),
  });
}

async function sendGameHeartbeat(token, quest, terminal, signal) {
  const baseline = quest.progressSecs;
  const perform = async () => {
    try {
      return await discordFetch(token, `/quests/${quest.id}/heartbeat`, {
        method: 'POST',
        body: JSON.stringify({ stream_key: `call:${quest.id}:1`, terminal }),
        signal,
      });
    } catch (error) {
      if (error?.status !== 400 || !quest.applicationId) throw error;
      return discordFetch(token, `/quests/${quest.id}/heartbeat`, {
        method: 'POST',
        body: JSON.stringify({ application_id: quest.applicationId, terminal }),
        signal,
      });
    }
  };
  return verifiedQuestMutation({
    token,
    questId: quest.id,
    signal,
    perform,
    predicate: (fresh) => fresh.completed || fresh.progressSecs > baseline,
  });
}

async function sendApplicationHeartbeat(token, quest, terminal, signal) {
  if (!quest.applicationId) {
    throw new QuestCompatibilityError(`Quest ${quest.id} is missing config.application.id`);
  }
  const baseline = quest.progressSecs;
  return verifiedQuestMutation({
    token,
    questId: quest.id,
    signal,
    predicate: (fresh) => fresh.completed || fresh.progressSecs > baseline,
    perform: () => discordFetch(token, `/quests/${quest.id}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({ application_id: quest.applicationId, terminal }),
      signal,
    }),
  });
}

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
  if (!entries.length) schemaIssues.push(`quest ${rawId}: missing task definitions`);
  const secondsNeeded = Number(selectedTask.definition?.target ?? 0);
  const autoSupported = !(
    (taskConfig?.join_operator ?? 'or') === 'and' && entries.length > 1
  );
  if (!autoSupported) {
    schemaIssues.push(`quest ${rawId}: multi-task join_operator=and requires every task`);
  }
  if (!Number.isFinite(secondsNeeded) || secondsNeeded <= 0) {
    schemaIssues.push(`quest ${rawId}: invalid target for ${selectedTask.type}`);
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

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    let t;
    const onAbort = () => { clearTimeout(t); reject(new Error('aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    t = setTimeout(() => {
      // Remove listener so it doesn't accumulate across many sleep() calls
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
  });
}

async function waitForQuestState(token, questId, predicate, signal, {
  attempts = 3,
  delayMs = 1500,
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const fresh = (await fetchQuests(token, signal)).find((quest) => quest.id === questId);
    if (fresh && predicate(fresh)) return fresh;
    if (attempt < attempts) await sleep(delayMs, signal);
  }
  return null;
}

// ── Job Store ─────────────────────────────────────────────────────────────────
const jobs = new Map();
const activeRunPromises = new Set();

export function getJob(key)   { return jobs.get(key) ?? null; }
export function listJobs()    { return [...jobs.entries()].map(([key, j]) => ({ key, ...j.summary() })); }
export function getUserJobs(ownerId, { mode = null, includeStopping = false } = {}) {
  return [...jobs.entries()]
    .filter(([, job]) => (
      job.ownerId === ownerId
      && (!mode || job.mode === mode)
      && (includeStopping || job.lifecycle !== 'stopping')
    ))
    .map(([key, job]) => ({ key, ...job.summary() }));
}

export function findUserJobByAccount(ownerId, accountId) {
  for (const [key, job] of jobs) {
    if (job.ownerId === ownerId && job.accountId === accountId) {
      return { key, ...job.summary() };
    }
  }
  return null;
}

export function findAnyJobByAccount(accountId) {
  for (const [key, job] of jobs) {
    if (job.accountId === accountId) return { key, ...job.summary() };
  }
  return null;
}

export function stopJob(ownerId, key, { removeSchedule = true } = {}) {
  const job = jobs.get(key);
  if (!job || job.ownerId !== ownerId) return false;
  if (job.lifecycle !== 'stopping') {
    job.lifecycle = 'stopping';
    job.controller.abort();
  }
  if (removeSchedule && job.scheduleId != null) {
    deleteScheduledRunner(job.scheduleId, ownerId);
  }
  return true;
}

export function stopScheduledJob(ownerId, scheduleId) {
  const key = `scheduled:${scheduleId}`;
  const stopped = stopJob(ownerId, key);
  const removed = deleteScheduledRunner(scheduleId, ownerId);
  return stopped || removed;
}

export function stopAllForUser(ownerId, { mode = null } = {}) {
  let count = 0;
  for (const [key, job] of jobs) {
    if (job.ownerId !== ownerId || (mode && job.mode !== mode)) continue;
    if (stopJob(ownerId, key)) count++;
  }
  return count;
}
export function stopRunner(ownerId, options = {}) {
  return stopAllForUser(ownerId, options) > 0;
}

export async function shutdownRunners(timeoutMs = null) {
  const activeJobs = [...jobs.values()];
  for (const job of activeJobs) job.controller.abort();

  await settleWithTimeout(activeRunPromises, timeoutMs, {
    pendingCount: () => activeRunPromises.size,
    timeoutMessage: (count) => `Runner shutdown timed out with ${count} task(s) pending`,
  });
  return activeJobs.length;
}

// ── Runner ────────────────────────────────────────────────────────────────────

function nextOneShotState(noProgressRounds, outcome) {
  if (outcome.supportedCount === 0) return { stop: true, noProgressRounds };
  const nextRounds = outcome.progressed ? 0 : noProgressRounds + 1;
  return { stop: nextRounds >= 3, noProgressRounds: nextRounds };
}

export async function startRunner({
  jobKey,
  ownerId,
  userToken,
  channelId,
  client,
  mode = 'oneshot',
  scheduleId = null,
  accountId: initialAccountId = null,
  username: initialUsername = null,
  initialNextCheckAt = null,
  speedMultiplier = 5,
  heartbeatInterval = 30,
}) {
  if (jobs.has(jobKey)) throw new Error(`Job ${jobKey} กำลังทำงานอยู่`);
  if (!['oneshot', 'scheduled'].includes(mode)) throw new Error(`Unknown runner mode: ${mode}`);

  const controller = new AbortController();
  const { signal } = controller;

  let liveMsg      = null;
  let outputChannel = null;
  let username     = initialUsername ?? '...';
  let accountId    = initialAccountId;
  let lastRenderAt = 0;
  let pendingTimer = null;
  let flushPromise = Promise.resolve();
  let nextCheckAt  = initialNextCheckAt;
  let logoutReported = false;
  let countAlreadyReported = false;
  let oneShotSession = null;
  let oneShotSummaryReported = false;
  const claimRetryAt = new Map();
  const RENDER_THROTTLE_MS = 2000; // Discord allows ~5 edits/5s; stay safe at 1/2s
  const CLAIM_RETRY_DELAY_MS = 15 * 60 * 1000;
  const CLAIM_LONG_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;
  const logLines = [];

  function addLog(line) {
    logLines.push(String(line).slice(0, 180));
    if (logLines.length > 25) logLines.shift();
  }

  async function resolveOutputChannel() {
    if (outputChannel?.isTextBased?.()) return outputChannel;
    let channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.() && config.logChannelId && config.logChannelId !== channelId) {
      channel = await client.channels.fetch(config.logChannelId).catch(() => null);
    }
    if (channel?.isTextBased?.()) outputChannel = channel;
    return outputChannel;
  }

  async function flush() {
    // Serialize flushes so concurrent renders cannot create duplicate live
    // messages before the first send has assigned liveMsg.
    const task = flushPromise.then(async () => {
      lastRenderAt = Date.now();
      const visibleLines = [...logLines];
      let content = '```\n' + visibleLines.join('\n') + '\n```';
      while (content.length > 1950 && visibleLines.length > 1) {
        visibleLines.shift();
        content = '```\n' + visibleLines.join('\n') + '\n```';
      }
      const editingExisting = Boolean(liveMsg);
      try {
        if (!liveMsg) {
          const ch = await resolveOutputChannel();
          if (!ch?.isTextBased?.()) return;
          liveMsg = await ch.send({ content });
        } else {
          await liveMsg.edit({ content });
        }
      } catch (err) {
        if (editingExisting) liveMsg = null;
        console.warn(`[Runner:${jobKey}] status message failed — ${err.message}`);
      }
    });

    // Keep the queue usable even if an unexpected error escapes a flush.
    flushPromise = task.catch(() => {});
    await task;
  }

  // Throttled — but never silently drops an update. If called too soon after the
  // last send, schedules a trailing flush so the latest log line always gets out.
  async function render() {
    const now = Date.now();
    if (liveMsg && now - lastRenderAt < RENDER_THROTTLE_MS) {
      if (!pendingTimer) {
        const wait = RENDER_THROTTLE_MS - (now - lastRenderAt);
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          flush();
        }, wait);
        pendingTimer.unref?.();
      }
      return;
    }
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    await flush();
  }

  const runnerStatusContext = normalizeStatusContext({
    key: `job:${jobKey}`,
    ownerId,
    accountId,
    username,
    jobKey,
    mode,
    lifecycle: 'running',
  });
  setQuestStatusLifecycle(runnerStatusContext.key, 'running', runnerStatusContext);

  const jobRecord = {
    ownerId,
    accountId,
    mode,
    scheduleId,
    controller,
    lifecycle: 'running',
    done: null,
    summary: () => ({
      username,
      accountId,
      mode,
      scheduleId,
      questStatusKey: runnerStatusContext.key,
      lifecycle: jobRecord.lifecycle,
      nextCheckAt,
      status: logLines.at(-1) ?? '',
    }),
  };
  jobs.set(jobKey, jobRecord);

  const clearPendingRender = () => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  };
  signal.addEventListener('abort', clearPendingRender, { once: true });

  function persistSchedule(values = {}) {
    if (mode === 'scheduled' && scheduleId != null) {
      updateScheduledRunner(scheduleId, values);
    }
  }

  function rethrowFatalAuth(error) {
    if (isFatalAuthError(error)) throw error;
  }

  async function claimSilently(quest) {
    if ((claimRetryAt.get(quest.id) ?? 0) > Date.now()) return false;
    const platform = selectQuestClaimPlatform(quest);
    if (platform == null) {
      claimRetryAt.set(quest.id, Date.now() + CLAIM_LONG_RETRY_DELAY_MS);
      return false;
    }

    try {
      await claimQuest(userToken, quest.id, platform, signal);
      const claimed = await waitForQuestState(
        userToken,
        quest.id,
        (fresh) => fresh.claimed,
        signal,
      );
      if (claimed) {
        claimRetryAt.delete(quest.id);
        recordQuestVerification(currentQuestStatusContext().key, 'claim', currentQuestStatusContext());
      } else {
        claimRetryAt.set(quest.id, Date.now() + CLAIM_RETRY_DELAY_MS);
      }
      return Boolean(claimed);
    } catch (error) {
      if (isAbortFailure(error, signal)) throw abortFailure();
      rethrowFatalAuth(error);
      const retryDelay = isCaptchaChallenge(error) || error?.status === 400
        ? CLAIM_LONG_RETRY_DELAY_MS
        : CLAIM_RETRY_DELAY_MS;
      claimRetryAt.set(
        quest.id,
        Date.now() + retryDelay,
      );
      return false;
    }
  }

  async function reportOneShotLogout() {
    if (mode !== 'oneshot' || logoutReported) return;
    logoutReported = true;
    addLog(`🔒 LOGOUT : ${username}`);
    await flush();
  }

  async function reportRunnableCount(count) {
    addLog(`🔎 ${username}: พบ ${count} QUESTS`);
    await render();
  }

  function questActivityLine(icon, content) {
    return mode === 'oneshot'
      ? `${icon} ${content}`
      : `${icon} ${username}: ${content}`;
  }

  function oneShotSummary() {
    return getOneShotSessionSummary(oneShotSession);
  }

  async function reportOneShotInitialState() {
    const summary = oneShotSummary();
    addLog(`🔎 ${username}: พบ ${summary.totalSupportedQuests} QUESTS`);
    addLog(`🎉 ${username}: ทำสำเร็จ ${summary.completedByBotCount} QUESTS`);
    await flush();
  }

  async function reportOneShotTerminalState() {
    const summary = oneShotSummary();
    addLog(`🔎 ${username}: พบ ${summary.totalSupportedQuests} QUESTS`);
    addLog(`🎉 ${username}: ทำสำเร็จ ${summary.completedByBotCount} QUESTS`);
    addLog('🧹 QUEST ACTIVITY CLEARED');
    await flush();
    return summary;
  }

  function oneShotOutcome() {
    const summary = oneShotSummary();
    return {
      attempted: true,
      progressed: true,
      supportedCount: summary.pendingCount,
    };
  }

  async function reportOneShotFailure(quest, reason) {
    if (mode !== 'oneshot') return null;
    failOneShotQuest(oneShotSession, quest.id, reason);
    await reportOneShotTerminalState();
    return oneShotOutcome();
  }

  async function reportOneShotExternalCompletion(quest) {
    if (mode !== 'oneshot') return null;
    completeOneShotQuest(oneShotSession, quest.id);
    await reportOneShotTerminalState();
    return oneShotOutcome();
  }

  async function reportOneShotBotCompletion(quest) {
    if (mode !== 'oneshot') return null;
    const status = completeOneShotQuest(oneShotSession, quest.id);
    if (status !== ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT) {
      return reportOneShotExternalCompletion(quest);
    }
    await reportOneShotTerminalState();
    return oneShotOutcome();
  }

  async function reportOneShotSummary() {
    if (mode !== 'oneshot' || oneShotSummaryReported) return;
    oneShotSummaryReported = true;
    const summary = oneShotSummary();
    addLog(`🔎 ${username}: พบ ${summary.totalSupportedQuests} QUESTS`);
    addLog(`🎉 ${username}: ทำสำเร็จ ${summary.completedByBotCount} QUESTS`);
    addLog('🧹 QUEST ACTIVITY CLEARED');

    if (summary.totalSupportedQuests === 0) {
      addLog('ℹ️ ไม่พบ Quest ที่บอทสามารถทำได้ในขณะนี้');
      await flush();
      return;
    }

    if (summary.issues.length === 0
        && summary.completedByBotCount === summary.totalSupportedQuests) {
      addLog('🎉 บอทได้เข้าไปทำ Quest ทั้งหมดเสร็จสิ้นทั้งหมดแล้ว');
      await flush();
      return;
    }

    addLog(summary.completedByBotCount === 0
      ? '❌ บอทไม่สามารถดำเนินการ Quest ให้สำเร็จได้'
      : '⚠️ มีบาง Quest ที่บอทดำเนินการไม่สำเร็จ');
    summary.issues.forEach((issue, index) => {
      addLog(`${index + 1}. ${issue.name}`);
      addLog(`   └ ${issue.reason}`);
    });
    await flush();
  }

  function idleQuestOutcome(supportedCount = 0) {
    return { attempted: false, progressed: false, supportedCount };
  }

  function attemptedQuestOutcome(supportedCount) {
    return { attempted: true, progressed: false, supportedCount };
  }

  async function prepareOneShotRound(allQuests) {
    if (!oneShotSession) {
      const initialRunnable = allQuests.filter(
        (quest) => !quest.completed && isRunnableQuest(quest),
      );
      oneShotSession = createOneShotQuestSession(initialRunnable);
      await reportOneShotInitialState();
    }
    if (isOneShotSessionComplete(oneShotSession)) {
      return { outcome: idleQuestOutcome() };
    }

    const initialQuest = getNextPendingOneShotQuest(oneShotSession);
    if (!initialQuest) return { outcome: idleQuestOutcome() };
    return { runnable: [initialQuest], initialQuest };
  }

  async function claimScheduledCompletions(allQuests) {
    const completed = allQuests.filter((quest) => quest.completed && !quest.claimed);
    for (const quest of completed) {
      if (signal.aborted) throw new Error('aborted');
      await claimSilently(quest);
    }
  }

  async function prepareScheduledRound(allQuests) {
    await claimScheduledCompletions(allQuests);
    const runnable = allQuests.filter((quest) => !quest.completed && isRunnableQuest(quest));
    if (!countAlreadyReported) await reportRunnableCount(runnable.length);
    countAlreadyReported = false;
    if (runnable.length === 0) return { outcome: idleQuestOutcome() };
    return { runnable, initialQuest: runnable[0] };
  }

  function prepareQuestRound(allQuests) {
    return mode === 'oneshot'
      ? prepareOneShotRound(allQuests)
      : prepareScheduledRound(allQuests);
  }

  async function refreshRoundQuest(selection) {
    try {
      return {
        quest: await fetchFreshQuest(userToken, selection.initialQuest.id, signal),
      };
    } catch (error) {
      rethrowFatalAuth(error);
      if (mode === 'oneshot') {
        return {
          outcome: await reportOneShotFailure(
            selection.initialQuest,
            oneShotFreshQuestFailureReason(error),
          ),
        };
      }
      addLog(`⚠️ ${username}: refresh failed — ${selection.initialQuest.name} — ${error.message}`);
      await render();
      return { outcome: attemptedQuestOutcome(selection.runnable.length) };
    }
  }

  async function resolveQuestAvailability(quest, selection) {
    if (!quest.completed && isRunnableQuest(quest)) return null;
    if (quest.completed) {
      if (mode === 'oneshot') {
        await claimSilently(quest);
        return reportOneShotExternalCompletion(quest);
      }
      return idleQuestOutcome(selection.runnable.length);
    }
    if (mode === 'oneshot') {
      return reportOneShotFailure(quest, oneShotUnavailableReason(quest));
    }
    return idleQuestOutcome(selection.runnable.length);
  }

  async function announceQuestPreparation(quest) {
    if (mode === 'oneshot') {
      markOneShotQuestRunning(oneShotSession, quest.id, quest.progressSecs);
    }
    addLog(questActivityLine('⏭️', `กำลังเตรียมทำ ${quest.name}`));
    await render();
  }

  async function enrollmentFailureOutcome(quest, selection, reason, scheduledMessage) {
    if (mode === 'oneshot') return reportOneShotFailure(quest, reason);
    addLog(scheduledMessage);
    await render();
    return attemptedQuestOutcome(selection.runnable.length);
  }

  async function ensureQuestEnrollment(quest, selection) {
    if (quest.enrolled) return { quest };
    try {
      await enrollQuest(userToken, quest.id, signal);
      const enrolled = await waitForQuestState(
        userToken,
        quest.id,
        (fresh) => fresh.enrolled,
        signal,
      );
      if (enrolled) return { quest: enrolled };
      return {
        outcome: await enrollmentFailureOutcome(
          quest,
          selection,
          'Discord ยังไม่ยืนยันการรับ Quest',
          `⚠️ ${username}: ${quest.name} — Discord ยังไม่ยืนยันการรับ Quest`,
        ),
      };
    } catch (error) {
      rethrowFatalAuth(error);
      return {
        outcome: await enrollmentFailureOutcome(
          quest,
          selection,
          'รับ Quest ไม่สำเร็จ',
          `⚠️ ${username}: enroll failed — ${quest.name} — ${error.message}`,
        ),
      };
    }
  }

  async function announceQuestProgress(quest) {
    addLog(questActivityLine('▶️', `กำลังทำ ${quest.name}`));
    const initialPercent = Math.min(100, Math.max(0, Math.floor(quest.progress)));
    addLog(questActivityLine('⌛', `${quest.name} ${initialPercent}%`));
    await render();
    return initialPercent;
  }

  function createQuestProgressHooks(quest, initialPercent) {
    let nextCheckpoint = Math.max(25, (Math.floor(initialPercent / 25) + 1) * 25);
    let lastReportedPercent = initialPercent;
    let lastVerifiedProgressSecs = quest.progressSecs;
    let completionSeen = quest.completed;

    const onServerProgress = async (fresh) => {
      const percent = fresh.completed ? 100 : Math.min(100, Math.floor(fresh.progress));
      if (fresh.progressSecs > lastVerifiedProgressSecs || (fresh.completed && !completionSeen)) {
        recordQuestVerification(
          currentQuestStatusContext().key,
          'progress',
          currentQuestStatusContext(),
        );
      }
      if (mode === 'oneshot') {
        recordOneShotVerifiedProgress(
          oneShotSession,
          quest.id,
          fresh.progressSecs,
          { completed: fresh.completed },
        );
      }
      lastVerifiedProgressSecs = Math.max(lastVerifiedProgressSecs, fresh.progressSecs);
      completionSeen ||= fresh.completed;
      while (nextCheckpoint <= 100 && percent >= nextCheckpoint) {
        if (nextCheckpoint > lastReportedPercent) {
          addLog(questActivityLine('⌛', `${quest.name} ${nextCheckpoint}%`));
          lastReportedPercent = nextCheckpoint;
        }
        nextCheckpoint += 25;
      }
      await render();
    };

    const onMutationAccepted = () => {
      if (mode === 'oneshot') {
        markOneShotProgressMutationSent(oneShotSession, quest.id);
      }
    };

    return { onServerProgress, onMutationAccepted };
  }

  async function executeQuestProgress(quest, selection, hooks) {
    const runner = isVideoEvent(quest.eventName) ? runVideoQuest : runGameQuest;
    try {
      await runner(
        userToken,
        quest,
        signal,
        hooks.onServerProgress,
        speedMultiplier,
        heartbeatInterval,
        hooks.onMutationAccepted,
      );
      if (signal.aborted) throw new Error('aborted');
      return null;
    } catch (error) {
      rethrowFatalAuth(error);
      if (signal.aborted) throw new Error('aborted');
      if (mode === 'oneshot') {
        return reportOneShotFailure(quest, 'การส่งความคืบหน้าไม่สำเร็จ');
      }
      if (error.message !== 'aborted') {
        addLog(`⚠️ ${username}: ERROR ${error.message}`);
      }
      await render();
      return attemptedQuestOutcome(selection.runnable.length);
    }
  }

  async function verificationFailureOutcome(quest, selection, reason, scheduledMessage) {
    if (mode === 'oneshot') return reportOneShotFailure(quest, reason);
    addLog(scheduledMessage);
    await render();
    return attemptedQuestOutcome(selection.runnable.length);
  }

  async function verifyQuestCompletion(quest, selection) {
    try {
      const fresh = await waitForQuestState(
        userToken,
        quest.id,
        (item) => item.completed,
        signal,
      );
      if (fresh) return { fresh };
      return {
        outcome: await verificationFailureOutcome(
          quest,
          selection,
          'Discord ยังไม่ยืนยันสถานะเสร็จ',
          `⚠️ ${username}: ${quest.name} — Discord ยังไม่ส่ง completed_at หลังตรวจ 3 ครั้ง`,
        ),
      };
    } catch (error) {
      rethrowFatalAuth(error);
      return {
        outcome: await verificationFailureOutcome(
          quest,
          selection,
          'ตรวจสอบผลลัพธ์กับ Discord ไม่สำเร็จ',
          `⚠️ ${username}: verify failed — ${error.message}`,
        ),
      };
    }
  }

  async function finalizeQuestCompletion(fresh, hooks) {
    await hooks.onServerProgress(fresh);
    recordQuestVerification(
      currentQuestStatusContext().key,
      'completion',
      currentQuestStatusContext(),
    );

    if (mode === 'oneshot') {
      const status = completeOneShotQuest(oneShotSession, fresh.id);
      await claimSilently(fresh);
      return status === ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT
        ? reportOneShotBotCompletion(fresh)
        : reportOneShotExternalCompletion(fresh);
    }

    await claimSilently(fresh);
    const latestQuests = await fetchQuests(userToken, signal);
    const supportedRemaining = latestQuests.filter(
      (item) => !item.completed && isRunnableQuest(item),
    ).length;
    await reportRunnableCount(supportedRemaining);
    countAlreadyReported = true;
    return { attempted: true, progressed: true, supportedCount: supportedRemaining };
  }

  async function runQuestRound() {
    const selection = await prepareQuestRound(await fetchQuests(userToken, signal));
    if (selection.outcome) return selection.outcome;

    const refreshed = await refreshRoundQuest(selection);
    if (refreshed.outcome) return refreshed.outcome;

    const availabilityOutcome = await resolveQuestAvailability(refreshed.quest, selection);
    if (availabilityOutcome) return availabilityOutcome;

    await announceQuestPreparation(refreshed.quest);
    const enrollment = await ensureQuestEnrollment(refreshed.quest, selection);
    if (enrollment.outcome) return enrollment.outcome;

    const initialPercent = await announceQuestProgress(enrollment.quest);
    const hooks = createQuestProgressHooks(enrollment.quest, initialPercent);
    const progressOutcome = await executeQuestProgress(enrollment.quest, selection, hooks);
    if (progressOutcome) return progressOutcome;

    const verification = await verifyQuestCompletion(enrollment.quest, selection);
    if (verification.outcome) return verification.outcome;
    return finalizeQuestCompletion(verification.fresh, hooks);
  }

  async function initializeRunnerSession() {
    if (!accountId || !initialUsername) {
      const me = await fetchMe(userToken, signal);
      username = me.username ?? 'unknown';
      accountId = me.id ?? accountId;
    }
    const job = jobs.get(jobKey);
    if (job) job.accountId = accountId;
    Object.assign(runnerStatusContext, { accountId, username });
    setQuestStatusLifecycle(runnerStatusContext.key, 'running', runnerStatusContext);
    addLog(`✅ LOGIN : ${username}`);
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
    addLog(`⏰ ${username}: NEXT CHECK ${formatScheduleTime(restoredAt)}`);
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
      addLog(`⚠️ ${username}: CHECK ERROR — ${error.message}`);
      await render();
      persistSchedule({
        lastCheckAt: new Date().toISOString(),
        lastError: error.message,
      });
      return {
      attempted: false,
      progressed: false,
      supportedCount: 0,
      transientError: true,
    };
    }
  }

  async function waitForTransientErrorRetry(attempt) {
    const delayMs = transientRetryDelayMs(attempt);
    nextCheckAt = new Date(Date.now() + delayMs).toISOString();
    persistSchedule({ nextCheckAt });
    addLog(`🌐 ${username}: NETWORK RETRY — อีก ${Math.round(delayMs / 60_000)} นาที`);
    await render();
    countAlreadyReported = false;
    await sleep(delayMs, signal);
    return attempt + 1;
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
    addLog(`🔁 ${username}: VERIFY ${checkNumber}/3 — อีก 5 นาที`);
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
    addLog(`💤 ${username}: AUTO DAILY ACTIVE`);
    addLog(`⏰ ${username}: NEXT CHECK ${formatScheduleTime(scheduledAt)}`);
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
    let transientErrorAttempts = 0;

    while (!signal.aborted) {
      const outcome = await runRoundSafely();
      if (mode === 'oneshot') {
        const oneShotState = nextOneShotState(noProgressRounds, outcome);
        noProgressRounds = oneShotState.noProgressRounds;
        if (oneShotState.stop) break;
        continue;
      }
      if (outcome.transientError) {
        transientErrorAttempts = await waitForTransientErrorRetry(transientErrorAttempts);
        continue;
      }
      transientErrorAttempts = 0;
      if (outcome.progressed && outcome.supportedCount > 0) continue;
      scheduleState = await handleScheduledIdle(scheduleState, outcome);
    }
  }

  async function handleRunnerFailure(error) {
    if (error.message === 'aborted') {
      if (mode === 'scheduled') {
        addLog(`🛑 ${username}: STOPPED BY USER`);
        await render();
      }
      return;
    }
    if (isFatalAuthError(error)) {
      addLog(`🔐 ${username}: TOKEN INVALID — RUNNER DISABLED (${error.status})`);
      await render();
      if (scheduleId != null) deleteScheduledRunner(scheduleId, ownerId);
      await reportCriticalError(
        'Runner authentication',
        new Error(`${username}: Discord API ${error.status}; runner disabled`),
      );
      return;
    }
    addLog(`❌ ${username}: ${error.message}`);
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
      await reportOneShotSummary();
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

  const currentJob = jobs.get(jobKey);
  if (currentJob) currentJob.done = runPromise;
  activeRunPromises.add(runPromise);
  void runPromise.then(
    () => activeRunPromises.delete(runPromise),
    () => activeRunPromises.delete(runPromise),
  );

  return { jobKey, mode, scheduleId };
}

function formatScheduleTime(date) {
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: config.timezone,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

export async function restoreScheduledRunners(client) {
  const rows = listScheduledRunners();
  if (!rows.length) return { restored: 0, failed: 0 };

  if (!config.runnerTokenSecret || config.runnerTokenSecret.length < 16) {
    console.warn('⚠️ Scheduled Runner restore skipped — RUNNER_TOKEN_SECRET missing/too short');
    return { restored: 0, failed: rows.length };
  }

  let restored = 0;
  let failed = 0;
  const restoredByOwner = new Map();
  const restoredAccounts = new Set();

  for (const row of rows) {
    const ownerCount = restoredByOwner.get(row.owner_id) ?? 0;
    if (ownerCount >= 10) {
      failed++;
      updateScheduledRunner(row.id, {
        lastError: 'Restore skipped: owner runner limit exceeded',
      });
      continue;
    }
    if (restoredAccounts.has(row.account_id)) {
      failed++;
      updateScheduledRunner(row.id, {
        lastError: 'Restore skipped: Discord account already restored',
      });
      continue;
    }

    try {
      const token = decryptRunnerToken(row, config.runnerTokenSecret);
      await startRunner({
        jobKey: `scheduled:${row.id}`,
        ownerId: row.owner_id,
        userToken: token,
        channelId: row.channel_id,
        client,
        mode: 'scheduled',
        scheduleId: row.id,
        accountId: row.account_id,
        username: row.username,
        initialNextCheckAt: row.next_check_at,
      });
      restored++;
      restoredByOwner.set(row.owner_id, ownerCount + 1);
      restoredAccounts.add(row.account_id);
    } catch (err) {
      failed++;
      updateScheduledRunner(row.id, { lastError: `Restore failed: ${err.message}` });
      await reportCriticalError(`Restore Scheduled Runner #${row.id}`, err);
    }
  }

  console.log(`♻️ Scheduled Runners restored: ${restored}, failed: ${failed}`);
  return { restored, failed };
}

// ── Quest Runners ─────────────────────────────────────────────────────────────

async function fetchFreshQuest(token, questId, signal) {
  const fresh = (await fetchQuests(token, signal)).find((item) => item.id === questId);
  if (!fresh) throw new QuestCompatibilityError(`Quest ${questId} disappeared from Quest API`);
  return fresh;
}

const VIDEO_SUBMISSION_INTERVAL_SECS = 10;
const VIDEO_ALLOWANCE_WAIT_LIMIT = 120;
const VIDEO_UNCHANGED_CHECK_LIMIT = 8;

function nextVideoTimestamp(current, target, enrolledAtMs, now = Date.now()) {
  const maxAllowed = Number.isFinite(enrolledAtMs)
    ? Math.floor((now - enrolledAtMs) / 1000) + VIDEO_SUBMISSION_INTERVAL_SECS
    : current + 1;
  return Math.min(
    target,
    current + VIDEO_SUBMISSION_INTERVAL_SECS,
    maxAllowed,
  );
}

async function waitForVideoTimestampAllowance(waitCount, signal) {
  const nextWaitCount = waitCount + 1;
  if (nextWaitCount >= VIDEO_ALLOWANCE_WAIT_LIMIT) {
    throw new Error('รอ video timestamp allowance จาก Discord เกิน 2 นาที');
  }
  await sleep(1000, signal);
  return nextWaitCount;
}

function nextVideoUnchangedChecks(fresh, current, unchangedChecks) {
  return fresh.progressSecs > current || fresh.completed
    ? 0
    : unchangedChecks + 1;
}

function assertVideoProgress(unchangedChecks) {
  if (unchangedChecks >= VIDEO_UNCHANGED_CHECK_LIMIT) {
    throw new Error('Discord ไม่ยืนยัน video progress หลังตรวจ 8 ครั้ง');
  }
}

async function submitVideoProgressStep(
  token,
  quest,
  timestamp,
  signal,
  onServerProgress,
  onMutationAccepted,
) {
  const mutation = await sendVideoProgress(token, quest.id, timestamp, signal);
  if (!mutation?.verifiedAfterFailure) onMutationAccepted();
  await sleep(1000, signal);
  const fresh = await fetchFreshQuest(token, quest.id, signal);
  await onServerProgress(fresh);
  return fresh;
}

async function runVideoQuest(
  token,
  quest,
  signal,
  onServerProgress,
  _speedMultiplier,
  _heartbeatSecs,
  onMutationAccepted = () => {},
) {
  let fresh = quest;
  let current = fresh.progressSecs;
  const target = fresh.secondsNeeded;
  const enrolledAtMs = Date.parse(fresh.enrolledAt);
  let unchangedChecks = 0;
  let allowanceWaits = 0;

  while (!fresh.completed && current < target) {
    if (signal.aborted) throw new Error('aborted');
    const timestamp = nextVideoTimestamp(current, target, enrolledAtMs);
    if (timestamp <= current) {
      allowanceWaits = await waitForVideoTimestampAllowance(allowanceWaits, signal);
      continue;
    }

    allowanceWaits = 0;
    fresh = await submitVideoProgressStep(
      token,
      quest,
      timestamp,
      signal,
      onServerProgress,
      onMutationAccepted,
    );
    unchangedChecks = nextVideoUnchangedChecks(fresh, current, unchangedChecks);
    assertVideoProgress(unchangedChecks);
    current = Math.max(current, fresh.progressSecs);

    if (!fresh.completed && current < target) {
      await sleep((VIDEO_SUBMISSION_INTERVAL_SECS - 1) * 1000, signal);
    }
  }
  return fresh;
}

async function sendQuestHeartbeat(token, quest, terminal, useApplicationPayload, signal) {
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

async function finishGameQuest(
  token,
  quest,
  signal,
  onServerProgress,
  useApplicationPayload,
  onMutationAccepted,
) {
  const mutation = await sendQuestHeartbeat(token, quest, true, useApplicationPayload, signal);
  if (!mutation?.verifiedAfterFailure) onMutationAccepted();
  await sleep(1000, signal);
  const fresh = await fetchFreshQuest(token, quest.id, signal);
  await onServerProgress(fresh);
  return fresh;
}

async function runGameQuest(token, quest, signal, onServerProgress, _speedMultiplier, heartbeatSecs, onMutationAccepted = () => {}) {
  let fresh = quest;
  let current = fresh.progressSecs;
  const intervalSecs = Math.max(1, Number(heartbeatSecs) || 30);
  let unchangedChecks = 0;
  let forceApplicationPayload = false;

  while (!fresh.completed && current < fresh.secondsNeeded) {
    if (signal.aborted) throw new Error('aborted');
    const mutation = await sendQuestHeartbeat(
      token,
      fresh,
      false,
      forceApplicationPayload,
      signal,
    );
    if (!mutation?.verifiedAfterFailure) onMutationAccepted();
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
    onMutationAccepted,
  );
}
