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
const FATAL_FORBIDDEN_PATHS = new Set(['/users/@me', '/users/@me/quests']);

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

function userHeaders(token) {
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
    'Referer': 'https://discord.com/channels/@me',
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
    headers: { ...userHeaders(token), ...headers },
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
const STREAM_EVENTS = new Set(['STREAM_ON_DESKTOP', 'PLAY_ON_DESKTOP', 'PLAY_ON_DESKTOP_V2']);
const SKIP_EVENTS   = new Set(['ACHIEVEMENT_IN_GAME', 'ACHIEVEMENT_IN_ACTIVITY', 'PLAY_ACTIVITY',
                                'PLAY_ON_XBOX', 'PLAY_ON_PLAYSTATION', 'progress']);

export async function fetchMe(token, signal) {
  return discordFetch(token, '/users/@me', { signal });
}

export async function fetchQuests(token, signal) {
  let raw;
  try {
    raw = await discordFetch(token, '/users/@me/quests', { signal });
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeQuest);
}

async function enrollQuest(token, questId, signal) {
  // location: 1 = quest bar; required by API
  return discordFetch(token, `/quests/${questId}/enroll`, {
    method: 'POST',
    body: JSON.stringify({ location: 1 }),
    signal,
  });
}

async function claimQuest(token, questId, signal) {
  return discordFetch(token, `/quests/${questId}/claim`, {
    method: 'POST',
    body: JSON.stringify({ location: 1, platform: 'windows' }),
    signal,
  });
}

async function sendVideoProgress(token, questId, timestamp, signal) {
  const ts = Math.round(timestamp + Math.random() * 0.5);
  return discordFetch(token, `/quests/${questId}/video-progress`, {
    method: 'POST', body: JSON.stringify({ timestamp: ts }), signal,
  });
}

async function sendHeartbeat(token, questId, signal) {
  return discordFetch(token, `/quests/${questId}/heartbeat`, {
    method: 'POST', body: JSON.stringify({}), signal,
  });
}

function normalizeQuest(raw) {
  const cfg        = raw.config ?? {};
  const userStatus = raw.user_status ?? {};

  // Support task_config (current) and task_config_v2 (alternate schema)
  const tasks      = cfg.task_config?.tasks ?? cfg.task_config_v2?.tasks ?? {};
  const taskEntries = Object.entries(tasks);
  const [eventName, taskDef] = taskEntries[0] ?? ['WATCH_VIDEO', { target: 0 }];
  const secondsNeeded = Number(taskDef?.target ?? 0);

  // New API: user_status.progress is map[eventName → { value: seconds, heartbeat: timestamp }]
  // Old API (config v1): user_status.progress was a string percentage ("0"–"100")
  let progressSecs = 0;
  const rawProgress = userStatus.progress;
  if (rawProgress && typeof rawProgress === 'object' && !Array.isArray(rawProgress)) {
    // New format — value is seconds completed
    progressSecs = Number(rawProgress[eventName]?.value ?? 0);
  } else if (typeof rawProgress === 'string' || typeof rawProgress === 'number') {
    // Old format — value is 0–100 percentage
    progressSecs = (parseFloat(rawProgress) / 100) * secondsNeeded;
  }

  const progress = secondsNeeded > 0 ? Math.min(100, (progressSecs / secondsNeeded) * 100) : 0;

  return {
    id:            raw.id,
    name:          cfg.messages?.quest_name ?? raw.id,
    eventName,                                    // WATCH_VIDEO / STREAM_ON_DESKTOP / etc.
    progress,                                     // 0–100 %
    secondsNeeded,                                // total seconds needed
    progressSecs,                                 // seconds already done
    enrolled:  !!userStatus.enrolled_at,
    completed: !!userStatus.completed_at,
    claimed:   !!userStatus.claimed_at,
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
  let username     = initialUsername ?? '...';
  let accountId    = initialAccountId;
  let lastRenderAt = 0;
  let pendingTimer = null;
  let flushPromise = Promise.resolve();
  let nextCheckAt  = initialNextCheckAt;
  const RENDER_THROTTLE_MS = 2000; // Discord allows ~5 edits/5s; stay safe at 1/2s
  const logLines = [];

  function addLog(line) {
    logLines.push(line);
    if (logLines.length > 25) logLines.shift();
  }

  async function flush() {
    // Serialize flushes so concurrent renders cannot create duplicate live
    // messages before the first send has assigned liveMsg.
    const task = flushPromise.then(async () => {
      lastRenderAt = Date.now();
      const content = '```\n' + logLines.join('\n') + '\n```';
      try {
        if (!liveMsg) {
          let ch = await client.channels.fetch(channelId).catch(() => null);
          if (!ch?.isTextBased?.() && config.logChannelId && config.logChannelId !== channelId) {
            ch = await client.channels.fetch(config.logChannelId).catch(() => null);
          }
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
      (quest) => VIDEO_EVENTS.has(quest.eventName) || STREAM_EVENTS.has(quest.eventName),
    );
    let attempted = false;
    let progressed = false;

    const unclaimed = allQuests.filter((quest) => quest.completed && !quest.claimed);
    for (const quest of unclaimed) {
      if (signal.aborted) break;
      try {
        await claimQuest(userToken, quest.id, signal);
        progressed = true;
        addLog(`🎁 ${username}: CLAIMED ${quest.name}`);
      } catch (err) {
        rethrowFatalAuth(err);
        addLog(`⚠️ ${username}: claim failed — ${quest.name} — ${err.message}`);
      }
      await render();
    }

    for (const quest of active.filter((item) => !supported.includes(item))) {
      const reason = SKIP_EVENTS.has(quest.eventName) ? 'ต้องเล่นจริง' : 'unknown type';
      addLog(`⏭️ ${username}: ข้าม ${quest.name} (${quest.eventName} — ${reason})`);
      await render();
    }

    if (supported.length === 0) {
      addLog(active.length
        ? `📭 ${username}: ไม่พบ Quest ที่ระบบรองรับ`
        : `📭 ${username}: ไม่พบ Quest`);
      await render();
      return { attempted, progressed, supportedCount: 0 };
    }

    addLog(`🎯 ${username}: ${supported.length} QUESTS`);
    await render();

    for (const [idx, quest] of supported.entries()) {
      if (signal.aborted) break;
      attempted = true;

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
      }

      addLog(`▶️ ${username}: [${idx + 1}/${supported.length}] ${quest.name} [${quest.eventName}]`);
      await render();

      let lastReportedPct = -1;
      const onProgress = async (pct) => {
        const bucket = Math.min(100, Math.floor(pct / 25) * 25);
        if (bucket === lastReportedPct) return;
        lastReportedPct = bucket;
        const lastLine = logLines.at(-1) ?? '';
        const newLine = `⌛ ${username}: [${idx + 1}/${supported.length}] ${quest.name} ${bucket}%`;
        if (lastLine.startsWith('⌛')) {
          logLines[logLines.length - 1] = newLine;
        } else {
          addLog(newLine);
        }
        await render();
      };

      const runner = VIDEO_EVENTS.has(quest.eventName) ? runVideoQuest : runStreamQuest;
      let runnerError = null;
      await runner(
        userToken,
        quest,
        signal,
        onProgress,
        speedMultiplier,
        heartbeatInterval,
      ).catch((err) => {
        rethrowFatalAuth(err);
        runnerError = err;
        if (err.message !== 'aborted') addLog(`⚠️ ${username}: ERROR ${err.message}`);
      });

      if (signal.aborted || runnerError) continue;

      let freshQuests;
      try {
        freshQuests = await fetchQuests(userToken, signal);
      } catch (err) {
        rethrowFatalAuth(err);
        addLog(`⚠️ ${username}: verify failed — ${err.message}`);
        await render();
        continue;
      }
      const fresh = freshQuests.find((item) => item.id === quest.id);
      if (!fresh?.completed) {
        addLog(`⚠️ ${username}: ${quest.name} — Discord ยังไม่ยืนยันว่าเสร็จ`);
        await render();
        continue;
      }

      progressed = true;
      addLog(`✅ ${username}: ${quest.name} DONE`);
      await render();
      try {
        await claimQuest(userToken, quest.id, signal);
        addLog(`🎁 ${username}: CLAIMED ${quest.name}`);
      } catch (err) {
        rethrowFatalAuth(err);
        addLog(`⚠️ ${username}: claim error — ${err.message}`);
      }
      await render();
    }

    return { attempted, progressed, supportedCount: supported.length };
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
          outcome = { attempted: false, progressed: false, supportedCount: 0 };
        }

        if (mode === 'oneshot') {
          if (outcome.supportedCount === 0) {
            addLog(`🔒 ${username}: RUNNER STOPPED — NO ACTIVE QUESTS`);
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

async function runVideoQuest(token, quest, signal, onProgress, speedMultiplier, heartbeatSecs) {
  let current  = quest.progressSecs;
  const target = quest.secondsNeeded;
  while (current < target) {
    if (signal.aborted) throw new Error('aborted');
    await sendVideoProgress(token, quest.id, current, signal);
    current = Math.min(current + speedMultiplier * heartbeatSecs, target);
    await onProgress(Math.floor((current / target) * 100));
    if (current >= target) break;
    await sleep(heartbeatSecs * 1000, signal);
  }
  await sendVideoProgress(token, quest.id, target, signal);
  await onProgress(100);
}

async function runStreamQuest(token, quest, signal, onProgress, _speedMultiplier, heartbeatSecs) {
  const total     = quest.secondsNeeded;
  const ticks     = Math.ceil(total / heartbeatSecs);
  const startTick = Math.floor((quest.progressSecs / total) * ticks);
  for (let i = startTick; i < ticks; i++) {
    if (signal.aborted) throw new Error('aborted');
    await sendHeartbeat(token, quest.id, signal);
    await onProgress(Math.round(((i + 1) / ticks) * 100));
    await sleep(heartbeatSecs * 1000, signal);
  }
  await onProgress(100);
}
