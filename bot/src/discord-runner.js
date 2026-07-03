import 'dotenv/config';
import { config } from './config.js';
import {
  addScheduleJitter,
  nextRecheckState,
  nextScheduledCheck,
  RECHECK_INTERVAL_MS,
} from './runner-schedule.js';
import { fetchWithRetry } from './http-retry.js';
import { reportCriticalError } from './error-reporter.js';
import {
  decryptRunnerToken,
  deleteScheduledRunner,
  listScheduledRunners,
  updateScheduledRunner,
} from './scheduled-runner-store.js';

const DISCORD_API = 'https://discord.com/api/v9';
const QUEST_LIST_PATHS = ['/quests/@me', '/users/@me/quests'];
const FATAL_FORBIDDEN_PATHS = new Set(['/users/@me', ...QUEST_LIST_PATHS]);

export class DiscordApiError extends Error {
  constructor(status, path, data) {
    super(`Discord API ${status}: ${JSON.stringify(data)}`);
    this.name = 'DiscordApiError';
    this.status = status;
    this.path = path;
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

let live = { ...FALLBACK };

// ── Auto-fetch helpers ─────────────────────────────────────────────────────────

function _githubHeaders() {
  const token = process.env.GITHUB_TOKEN?.trim();

  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'NeverDieQuestBot/1.0',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function _fetchBuildNumber() {
  // Discord-Datamining commits — message format: "2 July 2026 - Build 572700 (...)"
  const res = await fetch(
    'https://api.github.com/repos/Discord-Datamining/Discord-Datamining/commits?per_page=1',
    { headers: _githubHeaders(), signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const [commit] = await res.json();
  const m = commit?.commit?.message?.match(/Build (\d+)/);
  if (!m) throw new Error('build number not found in commit message');
  return parseInt(m[1], 10);
}

async function _fetchElectronInfo() {
  // Latest stable Electron release — body lists "Chromium `x.x.x.x`"
  const res = await fetch(
    'https://api.github.com/repos/electron/electron/releases/latest',
    { headers: _githubHeaders(), signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const data = await res.json();
  const electronVersion = data.tag_name?.replace(/^v/, '');
  const cm = (data.body ?? '').match(/Chromium\s+`([0-9.]+)`/i);
  const chromeVersion = cm?.[1];
  if (!electronVersion || !chromeVersion) throw new Error('could not parse Electron/Chrome version');
  return { electronVersion, chromeVersion };
}


/**
 * Fetch the latest build number + Electron/Chrome versions.
 * Falls back to hardcoded values if any fetch fails.
 * Safe to call multiple times — just updates the `live` object in-place.
 */
export async function refreshBuildInfo() {
  const [buildResult, electronResult] = await Promise.allSettled([
    _fetchBuildNumber(),
    _fetchElectronInfo(),
  ]);

  const prev = { ...live };

  if (buildResult.status === 'fulfilled') {
    live.buildNumber = buildResult.value;
  } else {
    console.warn(`⚠️  build number fetch failed — ${buildResult.reason?.message} — ใช้ fallback ${live.buildNumber}`);
  }

  if (electronResult.status === 'fulfilled') {
    live.electronVersion = electronResult.value.electronVersion;
    live.chromeVersion   = electronResult.value.chromeVersion;
  } else {
    console.warn(`⚠️  Electron/Chrome fetch failed — ${electronResult.reason?.message} — ใช้ fallback`);
  }

  const buildChanged    = live.buildNumber    !== prev.buildNumber;
  const electronChanged = live.electronVersion !== prev.electronVersion;

  console.log(
    `🔄 Build info — ` +
    `Client: ${live.clientVersion} | ` +
    `Build: ${live.buildNumber}${buildChanged ? ' ✨' : ''} | ` +
    `Chrome: ${live.chromeVersion} | ` +
    `Electron: ${live.electronVersion}${electronChanged ? ' ✨' : ''}`,
  );
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
    system_locale: 'en-US',
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
    'X-Discord-Locale': 'en-US',
    'X-Discord-Timezone': 'Asia/Bangkok',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
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

async function discordFetch(token, path, options = {}) {
  const { headers = {}, ...requestOptions } = options;
  const res = await fetchWithRetry(`${DISCORD_API}${path}`, {
    ...requestOptions,
    headers: { ...userHeaders(token, path), ...headers },
  });
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

const questEngineStatus = {
  lastCheckAt: null,
  lastSuccessfulCheckAt: null,
  state: 'unknown',
  questCount: 0,
  excludedCount: 0,
  enrollmentBlockedUntil: null,
  supportedCount: 0,
  unknownEvents: [],
  schemaIssues: [],
  lastVerifiedProgressAt: null,
  lastVerifiedCompletionAt: null,
  lastVerifiedClaimAt: null,
  questListPath: null,
  lastError: null,
};

export class QuestCompatibilityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuestCompatibilityError';
  }
}

export function getQuestEngineStatus() {
  return {
    ...questEngineStatus,
    unknownEvents: [...questEngineStatus.unknownEvents],
    schemaIssues: [...questEngineStatus.schemaIssues],
  };
}

function recordQuestError(error) {
  questEngineStatus.lastCheckAt = new Date().toISOString();
  questEngineStatus.state = error instanceof QuestCompatibilityError ? 'incompatible' : 'error';
  questEngineStatus.lastError = error.message;
}

export async function fetchMe(token, signal) {
  return discordFetch(token, '/users/@me', { signal });
}

export async function fetchQuests(token, signal) {
  const paths = QUEST_LIST_PATHS;
  let raw;
  let selectedPath;
  let selectedExcludedCount = 0;
  let selectedEnrollmentBlockedUntil = null;
  let lastError;
  let fatalError;
  let emptyCandidate = null;

  for (const path of paths) {
    try {
      const candidate = await discordFetch(token, path, { signal });
      const candidateQuests = Array.isArray(candidate)
        ? candidate
        : candidate && typeof candidate === 'object' && Array.isArray(candidate.quests)
          ? candidate.quests
          : null;
      if (!candidateQuests) {
        lastError = new QuestCompatibilityError(
          `Quest API schema changed at ${path}: expected an array or { quests: [] }`,
        );
        continue;
      }
      if (candidateQuests.length === 0 && paths.length > 1) {
        emptyCandidate ??= {
          path,
          quests: candidateQuests,
          excludedCount: Array.isArray(candidate?.excluded_quests)
            ? candidate.excluded_quests.length
            : 0,
          enrollmentBlockedUntil: candidate?.quest_enrollment_blocked_until ?? null,
        };
        continue;
      }
      raw = candidateQuests;
      selectedExcludedCount = Array.isArray(candidate?.excluded_quests)
        ? candidate.excluded_quests.length
        : 0;
      selectedEnrollmentBlockedUntil = candidate?.quest_enrollment_blocked_until ?? null;
      selectedPath = path;
      break;
    } catch (error) {
      if (isFatalAuthError(error)) {
        fatalError = error;
        if (error.status === 401) {
          recordQuestError(error);
          throw error;
        }
        if (emptyCandidate) {
          lastError = error;
          break;
        }
      }
      lastError = error;
    }
  }

  if (!selectedPath && emptyCandidate) {
    raw = emptyCandidate.quests;
    selectedExcludedCount = emptyCandidate.excludedCount;
    selectedEnrollmentBlockedUntil = emptyCandidate.enrollmentBlockedUntil;
    selectedPath = emptyCandidate.path;
  }

  if (!selectedPath) {
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

  let quests;
  try {
    quests = raw.map((quest) => ({
      ...normalizeQuest(quest),
      enrollmentBlockedUntil: selectedEnrollmentBlockedUntil,
    }));
  } catch (error) {
    const compatibilityError = error instanceof QuestCompatibilityError
      ? error
      : new QuestCompatibilityError(`Quest payload could not be parsed: ${error.message}`);
    recordQuestError(compatibilityError);
    await reportCriticalError('Quest API compatibility', compatibilityError);
    throw compatibilityError;
  }
  const unknownEvents = [...new Set(
    quests
      .filter((quest) => !isSupportedEvent(quest.eventName) && !SKIP_EVENTS.has(quest.eventName))
      .map((quest) => quest.eventName),
  )];
  const schemaIssues = quests.flatMap((quest) => quest.schemaIssues);

  Object.assign(questEngineStatus, {
    lastCheckAt: new Date().toISOString(),
    lastSuccessfulCheckAt: new Date().toISOString(),
    state: schemaIssues.length || unknownEvents.length ? 'degraded' : 'compatible',
    questCount: quests.length,
    excludedCount: selectedExcludedCount,
    enrollmentBlockedUntil: selectedEnrollmentBlockedUntil,
    supportedCount: quests.filter((quest) => !quest.completed && isRunnableQuest(quest)).length,
    unknownEvents,
    schemaIssues,
    questListPath: selectedPath,
    lastError: null,
  });

  if (schemaIssues.length || unknownEvents.length) {
    await reportCriticalError(
      'Quest API compatibility',
      new QuestCompatibilityError(
        [
          ...schemaIssues,
          unknownEvents.length ? `unknown events: ${unknownEvents.join(', ')}` : '',
        ].filter(Boolean).join('; '),
      ),
    );
  }
  return quests;
}

async function enrollQuest(token, questId, signal) {
  return discordFetch(token, `/quests/${questId}/enroll`, {
    method: 'POST',
    body: JSON.stringify({
      location: 11,
      is_targeted: false,
      metadata_raw: null,
    }),
    signal,
  });
}

async function claimQuest(token, questId, signal) {
  try {
    return await discordFetch(token, `/quests/${questId}/claim-reward`, {
      method: 'POST',
      body: JSON.stringify({ location: 11, platform: 'windows' }),
      signal,
    });
  } catch (error) {
    if (error?.status !== 404) throw error;
    return discordFetch(token, `/quests/${questId}/claim`, {
      method: 'POST',
      body: JSON.stringify({ location: 1, platform: 'windows' }),
      signal,
    });
  }
}

async function sendVideoProgress(token, questId, timestamp, signal) {
  const ts = Math.round(timestamp + Math.random() * 0.5);
  return discordFetch(token, `/quests/${questId}/video-progress`, {
    method: 'POST', body: JSON.stringify({ timestamp: ts }), signal,
  });
}

async function sendGameHeartbeat(token, quest, terminal, signal) {
  try {
    return await discordFetch(token, `/quests/${quest.id}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({
        stream_key: `call:${quest.id}:1`,
        terminal,
      }),
      signal,
    });
  } catch (error) {
    if (error?.status !== 400 || !quest.applicationId) throw error;
    return discordFetch(token, `/quests/${quest.id}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({
        application_id: quest.applicationId,
        terminal,
      }),
      signal,
    });
  }
}

async function sendApplicationHeartbeat(token, quest, terminal, signal) {
  if (!quest.applicationId) {
    throw new QuestCompatibilityError(`Quest ${quest.id} is missing config.application.id`);
  }
  return discordFetch(token, `/quests/${quest.id}/heartbeat`, {
    method: 'POST',
    body: JSON.stringify({
      application_id: quest.applicationId,
      terminal,
    }),
    signal,
  });
}

export function normalizeQuest(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) {
    throw new QuestCompatibilityError('Quest item is missing a valid id');
  }

  const cfg        = raw.config ?? {};
  const userStatus = raw.user_status ?? {};
  const schemaIssues = [];

  // Support task_config (current) and task_config_v2 (alternate schema)
  const taskConfig = cfg.task_config_v2 ?? cfg.task_config;
  const tasks = taskConfig?.tasks;
  const taskEntries = tasks && typeof tasks === 'object' && !Array.isArray(tasks)
    ? Object.entries(tasks)
    : [];
  if (!taskEntries.length) schemaIssues.push(`quest ${raw.id}: missing task definitions`);

  // Some Quest payloads contain several platform alternatives. Do not miss a
  // supported task merely because an unsupported platform happens to be first.
  const progressMap = userStatus.progress && typeof userStatus.progress === 'object'
    ? userStatus.progress
    : {};
  const normalizedEntries = taskEntries.map(([key, definition]) => ({
    key,
    definition,
    type: typeof definition?.event_name === 'string'
      ? definition.event_name
      : typeof definition?.type === 'string' ? definition.type : key,
  }));
  const supportedEntries = normalizedEntries.filter(({ type }) => isSupportedEvent(type));
  const selectedTask = (
    supportedEntries.find(({ key, type }) => progressMap[key] != null || progressMap[type] != null)
    ?? supportedEntries[0]
    ?? normalizedEntries[0]
    ?? { key: 'UNKNOWN_SCHEMA', type: 'UNKNOWN_SCHEMA', definition: { target: 0 } }
  );
  const progressKey = selectedTask.key;
  const eventName = selectedTask.type;
  const taskDef = selectedTask.definition;
  const secondsNeeded = Number(taskDef?.target ?? 0);
  const joinOperator = taskConfig?.join_operator ?? 'or';
  const autoSupported = !(joinOperator === 'and' && taskEntries.length > 1);
  if (!autoSupported) {
    schemaIssues.push(`quest ${raw.id}: multi-task join_operator=and requires every task`);
  }
  if (!Number.isFinite(secondsNeeded) || secondsNeeded <= 0) {
    schemaIssues.push(`quest ${raw.id}: invalid target for ${eventName}`);
  }

  // New API: user_status.progress is map[eventName → { value: seconds, heartbeat: timestamp }]
  // Old API (config v1): user_status.progress was a string percentage ("0"–"100")
  let progressSecs = 0;
  const rawProgress = userStatus.progress;
  if (rawProgress && typeof rawProgress === 'object' && !Array.isArray(rawProgress)) {
    // New format — value is seconds completed
    const eventProgress = rawProgress[progressKey] ?? rawProgress[eventName];
    progressSecs = Number(
      eventProgress && typeof eventProgress === 'object'
        ? eventProgress.value ?? 0
        : eventProgress ?? 0,
    );
  } else if (typeof rawProgress === 'string' || typeof rawProgress === 'number') {
    // Old format — value is 0–100 percentage
    progressSecs = (parseFloat(rawProgress) / 100) * secondsNeeded;
  } else if (Number.isFinite(Number(userStatus.stream_progress_seconds))) {
    progressSecs = Number(userStatus.stream_progress_seconds);
  }

  const progress = secondsNeeded > 0 ? Math.min(100, (progressSecs / secondsNeeded) * 100) : 0;

  return {
    id:            raw.id,
    name:          cfg.messages?.quest_name ?? raw.id,
    eventName,                                    // WATCH_VIDEO / STREAM_ON_DESKTOP / etc.
    progress,                                     // 0–100 %
    secondsNeeded,                                // total seconds needed
    progressSecs,                                 // seconds already done
    progressKey,
    applicationId: cfg.application?.id ?? null,
    autoSupported,
    startsAt: cfg.starts_at ?? null,
    expiresAt: cfg.expires_at ?? null,
    enrolledAt: userStatus.enrolled_at ?? null,
    enrolled:  !!userStatus.enrolled_at,
    completed: !!userStatus.completed_at,
    claimed:   !!userStatus.claimed_at || userStatus.orb_quantity_claimed != null,
    schemaIssues,
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
export function getUserJobs(ownerId, { mode = null } = {}) {
  return [...jobs.entries()]
    .filter(([, job]) => job.ownerId === ownerId && (!mode || job.mode === mode))
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

export function stopJob(ownerId, key, { removeSchedule = true } = {}) {
  const job = jobs.get(key);
  if (!job || job.ownerId !== ownerId) return false;
  job.controller.abort();
  jobs.delete(key);
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

export async function shutdownRunners(timeoutMs = 10_000) {
  const activeJobs = [...jobs.values()];
  for (const job of activeJobs) job.controller.abort();

  let timeout;
  try {
    await Promise.race([
      Promise.allSettled([...activeRunPromises]),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  return activeJobs.length;
}

// ── Runner ────────────────────────────────────────────────────────────────────

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
  let lastInventoryFingerprint = null;
  const RENDER_THROTTLE_MS = 2000; // Discord allows ~5 edits/5s; stay safe at 1/2s
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

  async function sendStandaloneLines(header, lines) {
    try {
      const channel = await resolveOutputChannel();
      if (!channel) return;
      const chunks = [];
      let current = header;
      for (const rawLine of lines) {
        const line = String(rawLine).slice(0, 180);
        if (`${current}\n${line}`.length > 1850) {
          chunks.push(current);
          current = line;
        } else {
          current += `\n${line}`;
        }
      }
      if (current) chunks.push(current);
      for (const chunk of chunks) {
        await channel.send({ content: `\`\`\`\n${chunk}\n\`\`\`` });
      }
    } catch (error) {
      console.warn(`[Runner:${jobKey}] inventory message failed — ${error.message}`);
    }
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
      try {
        if (!liveMsg) {
          const ch = await resolveOutputChannel();
          if (!ch?.isTextBased?.()) return;
          liveMsg = await ch.send({ content });
        } else {
          await liveMsg.edit({ content });
        }
      } catch (err) {
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

  jobs.set(jobKey, {
    ownerId,
    accountId,
    mode,
    scheduleId,
    controller,
    summary: () => ({
      username,
      accountId,
      mode,
      scheduleId,
      nextCheckAt,
      status: logLines.at(-1) ?? '',
    }),
  });

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

  async function runQuestRound() {
    const allQuests = await fetchQuests(userToken, signal);
    const active = allQuests.filter((quest) => !quest.completed);
    const supported = active.filter(
      (quest) => isRunnableQuest(quest),
    );
    let attempted = false;
    let progressed = false;

    const inventoryFingerprint = active
      .map((quest) => `${quest.id}:${quest.eventName}`)
      .sort()
      .join('|');
    if (inventoryFingerprint !== lastInventoryFingerprint) {
      lastInventoryFingerprint = inventoryFingerprint;
      addLog(`📋 ${username}: เควสที่ยังไม่เสร็จทั้งหมด ${active.length} เควส`);
      const inventoryLines = active.map((quest, index) => {
        const unavailableReason = questUnavailableReason(quest);
        const supportedLabel = isRunnableQuest(quest)
          ? 'พร้อมทำ'
          : unavailableReason ?? 'ต้องทำจริง';
        return `  ${index + 1}. ${quest.name} [${quest.eventName}] `
          + `${Math.floor(quest.progress)}% — ${supportedLabel}`;
      });
      await render();
      await sendStandaloneLines(
        `📋 ${username}: เควสที่ยังไม่เสร็จทั้งหมด ${active.length} เควส`,
        inventoryLines,
      );
    }

    const unclaimed = allQuests.filter((quest) => quest.completed && !quest.claimed);
    for (const quest of unclaimed) {
      if (signal.aborted) break;
      try {
        await claimQuest(userToken, quest.id, signal);
        const claimed = await waitForQuestState(
          userToken,
          quest.id,
          (fresh) => fresh.claimed,
          signal,
        );
        if (claimed) {
          progressed = true;
          questEngineStatus.lastVerifiedClaimAt = new Date().toISOString();
          addLog(`🎁 ${username}: Discord ยืนยัน CLAIMED — ${quest.name}`);
        } else {
          addLog(`⚠️ ${username}: ${quest.name} — ส่ง Claim แล้วแต่ยังไม่พบ claimed_at`);
        }
      } catch (err) {
        rethrowFatalAuth(err);
        addLog(`⚠️ ${username}: claim failed — ${quest.name} — ${err.message}`);
      }
      await render();
    }

    for (const quest of active.filter((item) => !supported.includes(item))) {
      const reason = STREAM_EVENTS.has(quest.eventName)
        ? 'ต้องสตรีมจริงและมี stream session'
        : questUnavailableReason(quest)
          ?? (SKIP_EVENTS.has(quest.eventName) ? 'ต้องเล่นจริง' : 'unknown type');
      addLog(`⏭️ ${username}: ข้าม ${quest.name} (${quest.eventName} — ${reason})`);
      await render();
    }

    if (supported.length === 0) {
      addLog(active.length
        ? `📭 ${username}: ไม่พบ Quest ที่ระบบรองรับ`
        : `📭 ${username}: ไม่พบ Quest`);
      await render();
      return { attempted, progressed, supportedCount: 0, activeCount: active.length };
    }

    addLog(`🎯 ${username}: ${supported.length} QUESTS`);
    await render();

    for (const [idx, initialQuest] of supported.entries()) {
      if (signal.aborted) break;
      attempted = true;
      let quest;
      try {
        quest = await fetchFreshQuest(userToken, initialQuest.id, signal);
      } catch (err) {
        rethrowFatalAuth(err);
        addLog(`⚠️ ${username}: refresh failed — ${initialQuest.name} — ${err.message}`);
        await render();
        continue;
      }
      if (quest.completed) {
        addLog(`↪️ ${username}: ${quest.name} เสร็จแล้วระหว่างรอ — ข้าม`);
        await render();
        continue;
      }
      if (!isRunnableQuest(quest)) {
        addLog(
          `↪️ ${username}: ${quest.name} ไม่พร้อมทำ `
          + `(${questUnavailableReason(quest) ?? quest.eventName}) — ข้าม`,
        );
        await render();
        continue;
      }

      if (!quest.enrolled) {
        addLog(`🚀 ${username}: JOIN ${quest.name}`);
        await render();
        try {
          await enrollQuest(userToken, quest.id, signal);
        } catch (err) {
          rethrowFatalAuth(err);
          addLog(`⚠️ ${username}: enroll failed — ${quest.name} — ${err.message}`);
          await render();
          continue;
        }
        try {
          const enrolled = await waitForQuestState(
            userToken,
            quest.id,
            (fresh) => fresh.enrolled,
            signal,
          );
          if (!enrolled) {
            addLog(`⚠️ ${username}: ${quest.name} — Discord ยังไม่ยืนยันการ JOIN`);
            await render();
            continue;
          }
          quest = enrolled;
        } catch (err) {
          rethrowFatalAuth(err);
          addLog(`⚠️ ${username}: enroll verify failed — ${quest.name} — ${err.message}`);
          await render();
          continue;
        }
      }

      addLog(`▶️ ${username}: [${idx + 1}/${supported.length}] ${quest.name} [${quest.eventName}]`);
      await render();

      let nextCheckpoint = Math.max(25, (Math.floor(quest.progress / 25) + 1) * 25);
      const onServerProgress = async (fresh) => {
        const pct = fresh.completed ? 100 : Math.min(100, Math.floor(fresh.progress));
        const confirmedSeconds = fresh.completed ? fresh.secondsNeeded : fresh.progressSecs;
        if (fresh.progressSecs > 0 || fresh.completed) {
          questEngineStatus.lastVerifiedProgressAt = new Date().toISOString();
        }
        while (nextCheckpoint <= 100 && pct >= nextCheckpoint) {
          addLog(
            `⌛ Discord ${nextCheckpoint}% — ${quest.name} `
            + `${formatQuestDuration(confirmedSeconds)}/${formatQuestDuration(fresh.secondsNeeded)}`,
          );
          nextCheckpoint += 25;
        }
        await render();
      };

      const runner = isVideoEvent(quest.eventName) ? runVideoQuest : runGameQuest;
      let runnerError = null;
      await runner(
        userToken,
        quest,
        signal,
        onServerProgress,
        speedMultiplier,
        heartbeatInterval,
      ).catch((err) => {
        rethrowFatalAuth(err);
        runnerError = err;
        if (err.message !== 'aborted') addLog(`⚠️ ${username}: ERROR ${err.message}`);
      });

      if (signal.aborted || runnerError) continue;

      let fresh;
      try {
        fresh = await waitForQuestState(
          userToken,
          quest.id,
          (item) => item.completed,
          signal,
        );
      } catch (err) {
        rethrowFatalAuth(err);
        addLog(`⚠️ ${username}: verify failed — ${err.message}`);
        await render();
        continue;
      }
      if (!fresh) {
        addLog(`⚠️ ${username}: ${quest.name} — Discord ยังไม่ส่ง completed_at หลังตรวจ 3 ครั้ง`);
        await render();
        continue;
      }

      progressed = true;
      questEngineStatus.lastVerifiedCompletionAt = new Date().toISOString();
      addLog(`✅ ${username}: Discord ยืนยัน DONE — ${quest.name}`);
      await render();
      try {
        await claimQuest(userToken, quest.id, signal);
        const claimed = await waitForQuestState(
          userToken,
          quest.id,
          (item) => item.claimed,
          signal,
        );
        if (claimed) {
          questEngineStatus.lastVerifiedClaimAt = new Date().toISOString();
          addLog(`🎁 ${username}: Discord ยืนยัน CLAIMED — ${quest.name}`);
        } else {
          addLog(`⚠️ ${username}: ${quest.name} — ส่ง Claim แล้วแต่ยังไม่พบ claimed_at`);
        }
      } catch (err) {
        rethrowFatalAuth(err);
        addLog(`⚠️ ${username}: claim error — ${err.message}`);
      }
      await render();
    }

    const latestQuests = await fetchQuests(userToken, signal);
    const supportedRemaining = latestQuests.filter(
      (quest) => !quest.completed && isRunnableQuest(quest),
    ).length;
    const activeCount = latestQuests.filter((quest) => !quest.completed).length;
    return { attempted, progressed, supportedCount: supportedRemaining, activeCount };
  }

  const runPromise = (async () => {
    try {
      if (!accountId || !initialUsername) {
        const me = await fetchMe(userToken, signal);
        username = me.username ?? 'unknown';
        accountId = me.id ?? accountId;
      }
      const job = jobs.get(jobKey);
      if (job) job.accountId = accountId;

      addLog(`✅ LOGIN : ${username}`);
      if (mode === 'scheduled') {
        addLog(`🤖 AUTO DAILY ENABLED — CHECK 00:00 / 08:00 / 16:00`);
      }
      await render();

      if (mode === 'scheduled' && initialNextCheckAt) {
        const restoredAt = new Date(initialNextCheckAt);
        if (Number.isFinite(restoredAt.getTime()) && restoredAt.getTime() > Date.now()) {
          nextCheckAt = restoredAt.toISOString();
          addLog(`⏰ ${username}: NEXT CHECK ${formatScheduleTime(restoredAt)}`);
          await render();
          await sleep(restoredAt.getTime() - Date.now(), signal);
        }
      }

      let round = 0;
      let noProgressRounds = 0;
      let isRecheck = false;
      let rechecksRemaining = 0;

      while (!signal.aborted) {
        round++;
        let outcome;
        try {
          outcome = await runQuestRound();
          persistSchedule({
            lastCheckAt: new Date().toISOString(),
            lastError: null,
          });
        } catch (err) {
          if (err.message === 'aborted') throw err;
          if (isFatalAuthError(err)) throw err;
          if (mode === 'oneshot') throw err;
          addLog(`⚠️ ${username}: CHECK ERROR — ${err.message}`);
          await render();
          persistSchedule({
            lastCheckAt: new Date().toISOString(),
            lastError: err.message,
          });
          outcome = { attempted: false, progressed: false, supportedCount: 0, activeCount: 0 };
        }

        if (mode === 'oneshot') {
          if (outcome.supportedCount === 0) {
            addLog(outcome.activeCount > 0
              ? `🔒 ${username}: RUNNER STOPPED — NO SUPPORTED QUESTS`
              : `🔒 ${username}: RUNNER STOPPED — NO ACTIVE QUESTS`);
            await render();
            break;
          }
          noProgressRounds = outcome.progressed ? 0 : noProgressRounds + 1;
          if (noProgressRounds >= 3) {
            addLog(`🛑 ${username}: RUNNER STOPPED — NO PROGRESS AFTER 3 RETRIES`);
            await render();
            break;
          }
          addLog(`🔄 ${username}: ROUND ${round} DONE — RECHECKING...`);
          await render();
          await sleep(3000, signal);
          continue;
        }

        if (outcome.progressed && outcome.supportedCount > 0) {
          addLog(`🔄 ${username}: พบ Quest ที่ยังเหลือ — ตรวจและทำต่อทันที`);
          await render();
          await sleep(3000, signal);
          continue;
        }

        const recheck = nextRecheckState({
          isRecheck,
          rechecksRemaining,
          attempted: outcome.attempted,
          progressed: outcome.progressed,
        });
        rechecksRemaining = recheck.rechecksRemaining;

        if (recheck.shouldRecheck) {
          const checkNumber = 4 - rechecksRemaining;
          nextCheckAt = new Date(Date.now() + RECHECK_INTERVAL_MS).toISOString();
          persistSchedule({ nextCheckAt });
          addLog(`🔁 ${username}: VERIFY ${checkNumber}/3 — อีก 5 นาที`);
          await render();
          await sleep(RECHECK_INTERVAL_MS, signal);
          isRecheck = true;
          continue;
        }

        isRecheck = false;
        rechecksRemaining = 0;
        const scheduledAt = addScheduleJitter(
          nextScheduledCheck(new Date(), config.timezone),
        );
        nextCheckAt = scheduledAt.toISOString();
        persistSchedule({ nextCheckAt });
        addLog(`💤 ${username}: AUTO DAILY ACTIVE`);
        addLog(`⏰ ${username}: NEXT CHECK ${formatScheduleTime(scheduledAt)}`);
        await render();
        await sleep(scheduledAt.getTime() - Date.now(), signal);
      }
    } catch (err) {
      if (err.message === 'aborted') {
        addLog(`🛑 ${username}: STOPPED BY USER`);
        await render();
      } else if (isFatalAuthError(err)) {
        addLog(`🔐 ${username}: TOKEN INVALID — RUNNER DISABLED (${err.status})`);
        await render();
        if (scheduleId != null) deleteScheduledRunner(scheduleId, ownerId);
        await reportCriticalError(
          'Runner authentication',
          new Error(`${username}: Discord API ${err.status}; runner disabled`),
        );
      } else {
        addLog(`❌ ${username}: ${err.message}`);
        await render();
        persistSchedule({ lastError: err.message });
      }
    } finally {
      signal.removeEventListener('abort', clearPendingRender);
      const hadPendingRender = Boolean(pendingTimer);
      clearPendingRender();
      await flushPromise;
      if (hadPendingRender) {
        // Deliver the latest queued status before tearing the job down.
        await flush();
      }
      jobs.delete(jobKey);
    }
  })();

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

function formatQuestDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const remaining = total % 60;
  return minutes > 0 ? `${minutes}m${remaining ? ` ${remaining}s` : ''}` : `${remaining}s`;
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
  for (const row of rows) {
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

async function runVideoQuest(token, quest, signal, onServerProgress, _speedMultiplier) {
  let fresh = quest;
  let current = fresh.progressSecs;
  const target = fresh.secondsNeeded;
  const submissionIntervalSecs = 10;
  const step = submissionIntervalSecs;
  const enrolledAtMs = Date.parse(fresh.enrolledAt);
  let unchangedChecks = 0;
  let allowanceWaits = 0;

  while (!fresh.completed && current < target) {
    if (signal.aborted) throw new Error('aborted');

    // Discord limits video timestamps to roughly the elapsed enrollment time.
    // Never report an arbitrarily accelerated local value as accepted progress.
    const maxAllowed = Number.isFinite(enrolledAtMs)
      ? Math.floor((Date.now() - enrolledAtMs) / 1000) + 10
      : current + 1;
    const nextTimestamp = Math.min(target, current + step, maxAllowed);
    if (nextTimestamp <= current) {
      allowanceWaits++;
      if (allowanceWaits >= 120) {
        throw new Error('รอ video timestamp allowance จาก Discord เกิน 2 นาที');
      }
      await sleep(1000, signal);
      continue;
    }
    allowanceWaits = 0;

    await sendVideoProgress(token, quest.id, nextTimestamp, signal);
    await sleep(1000, signal);
    fresh = await fetchFreshQuest(token, quest.id, signal);
    await onServerProgress(fresh);

    if (fresh.progressSecs > current || fresh.completed) {
      unchangedChecks = 0;
    } else {
      unchangedChecks++;
    }
    if (unchangedChecks >= 8) {
      throw new Error('Discord ไม่ยืนยัน video progress หลังตรวจ 8 ครั้ง');
    }
    current = Math.max(current, fresh.progressSecs);
    if (!fresh.completed && current < target) {
      await sleep((submissionIntervalSecs - 1) * 1000, signal);
    }
  }

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

    if (forceApplicationPayload) {
      await sendApplicationHeartbeat(token, fresh, false, signal);
    } else {
      await sendGameHeartbeat(token, fresh, false, signal);
    }
    await sleep(1000, signal);
    fresh = await fetchFreshQuest(token, quest.id, signal);
    await onServerProgress(fresh);

    if (fresh.progressSecs > current || fresh.completed) {
      unchangedChecks = 0;
    } else {
      unchangedChecks++;
      if (fresh.applicationId) forceApplicationPayload = true;
    }
    if (unchangedChecks >= 5) {
      throw new Error('Discord ไม่ยืนยัน game progress หลัง heartbeat 5 ครั้ง');
    }
    current = Math.max(current, fresh.progressSecs);
    if (!fresh.completed && current < fresh.secondsNeeded) {
      await sleep(Math.max(0, intervalSecs - 1) * 1000, signal);
    }
  }

  if (!fresh.completed) {
    if (forceApplicationPayload) {
      await sendApplicationHeartbeat(token, fresh, true, signal);
    } else {
      await sendGameHeartbeat(token, fresh, true, signal);
    }
    await sleep(1000, signal);
    fresh = await fetchFreshQuest(token, quest.id, signal);
    await onServerProgress(fresh);
  }
  return fresh;
}
