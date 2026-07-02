import 'dotenv/config';

const DISCORD_API = 'https://discord.com/api/v9';

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

async function _fetchBuildNumber() {
  // Discord-Datamining commits — message format: "2 July 2026 - Build 572700 (...)"
  const res = await fetch(
    'https://api.github.com/repos/Discord-Datamining/Discord-Datamining/commits?per_page=1',
    { headers: { 'User-Agent': 'NeverDieQuestBot/1.0' }, signal: AbortSignal.timeout(8000) },
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
    { headers: { 'User-Agent': 'NeverDieQuestBot/1.0' }, signal: AbortSignal.timeout(8000) },
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
  const res = await fetch(`${DISCORD_API}${path}`, { headers: userHeaders(token), ...options });
  if (res.status === 204) return { ok: true, status: 204 };
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const err = new Error(`Discord API ${res.status}: ${JSON.stringify(data)}`);
    err.status = res.status;
    throw err;
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

export async function fetchMe(token) {
  return discordFetch(token, '/users/@me');
}

export async function fetchQuests(token) {
  let raw;
  try {
    raw = await discordFetch(token, '/users/@me/quests');
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeQuest);
}

async function enrollQuest(token, questId) {
  // location: 1 = quest bar; required by API
  return discordFetch(token, `/quests/${questId}/enroll`, {
    method: 'POST',
    body: JSON.stringify({ location: 1 }),
  });
}

async function claimQuest(token, questId) {
  return discordFetch(token, `/quests/${questId}/claim`, {
    method: 'POST',
    body: JSON.stringify({ location: 1, platform: 'windows' }),
  });
}

async function sendVideoProgress(token, questId, timestamp) {
  const ts = Math.round(timestamp + Math.random() * 0.5);
  return discordFetch(token, `/quests/${questId}/video-progress`, {
    method: 'POST', body: JSON.stringify({ timestamp: ts }),
  });
}

async function sendHeartbeat(token, questId) {
  return discordFetch(token, `/quests/${questId}/heartbeat`, {
    method: 'POST', body: JSON.stringify({}),
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
// key = `${ownerId}_${index}` for multi-token support
const jobs = new Map();

export function getJob(key)   { return jobs.get(key) ?? null; }
export function listJobs()    { return [...jobs.entries()].map(([key, j]) => ({ key, ...j.summary() })); }
export function getUserJobs(ownerId) {
  return [...jobs.entries()].filter(([k]) => k.startsWith(ownerId + '_')).map(([k, j]) => ({ key: k, ...j.summary() }));
}
export function stopAllForUser(ownerId) {
  let count = 0;
  for (const [key, job] of jobs) {
    if (key.startsWith(ownerId + '_')) { job.controller.abort(); jobs.delete(key); count++; }
  }
  return count;
}
export function stopRunner(ownerId) { return stopAllForUser(ownerId) > 0; }

// ── Runner ────────────────────────────────────────────────────────────────────

export async function startRunner({ jobKey, ownerId, userToken, channelId, client, speedMultiplier = 5, heartbeatInterval = 30 }) {
  if (jobs.has(jobKey)) throw new Error(`Job ${jobKey} กำลังทำงานอยู่`);

  const controller = new AbortController();
  const { signal } = controller;

  let liveMsg      = null;
  let username     = '...';
  let lastRenderAt = 0;
  let pendingTimer = null;
  const RENDER_THROTTLE_MS = 2000; // Discord allows ~5 edits/5s; stay safe at 1/2s
  const logLines = [];

  function addLog(line) {
    logLines.push(line);
    if (logLines.length > 25) logLines.shift();
  }

  async function flush() {
    lastRenderAt = Date.now();
    const content = '```\n' + logLines.join('\n') + '\n```';
    try {
      if (!liveMsg) {
        const ch = await client.channels.fetch(channelId);
        if (!ch?.isTextBased?.()) return;
        liveMsg = await ch.send({ content });
      } else {
        await liveMsg.edit({ content });
      }
    } catch {}
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
      }
      return;
    }
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    await flush();
  }

  jobs.set(jobKey, {
    controller,
    summary: () => ({ username, status: logLines.at(-1) ?? '' }),
  });

  (async () => {
    try {
      // Login
      const me = await fetchMe(userToken);
      username = me.username ?? 'unknown';
      addLog(`✅ LOGIN : ${username}`);
      await render();

      let round = 0;
      while (!signal.aborted) {
        round++;
        const allQuests = await fetchQuests(userToken);
        const active    = allQuests.filter((q) => !q.completed);

        // Quests that are done but not yet claimed — claim them first
        const unclaimed = allQuests.filter((q) => q.completed && !q.claimed);
        for (const quest of unclaimed) {
          if (signal.aborted) break;
          try {
            await claimQuest(userToken, quest.id);
            addLog(`🎁 ${username}: CLAIMED ${quest.name}`);
          } catch (e) {
            addLog(`⚠️ ${username}: claim failed — ${quest.name} — ${e.message}`);
          }
          await render();
        }

        if (active.length === 0) {
          // Don't stop — Discord adds new quests regularly; keep polling every 15 min
          addLog(`📭 ${username}: ไม่มีเควสตอนนี้ — รอเช็คใหม่ใน 15 นาที`);
          await render();
          await sleep(15 * 60 * 1000, signal);
          continue;
        }

        addLog(`🎯 ${username}: ${active.length} QUESTS`);
        await render();

        for (const quest of active) {
          if (signal.aborted) break;

          // Skip quest types that can't be completed via API
          // — known unskippable types AND any unknown/future event names
          if (!VIDEO_EVENTS.has(quest.eventName) && !STREAM_EVENTS.has(quest.eventName)) {
            const reason = SKIP_EVENTS.has(quest.eventName) ? 'ต้องเล่นจริง' : 'unknown type';
            addLog(`⏭️ ${username}: ข้าม ${quest.name} (${quest.eventName} — ${reason})`);
            await render();
            continue;
          }

          if (!quest.enrolled) {
            addLog(`🚀 ${username}: JOIN ${quest.name}`);
            await render();
            await enrollQuest(userToken, quest.id).catch(() => {});
          }

          addLog(`▶️ ${username}: ${quest.name} [${quest.eventName}]`);
          await render();

          const onProgress = async (pct) => {
            const lastLine = logLines.at(-1) ?? '';
            const newLine  = `⌛ ${username}: ${quest.name} ${pct}%`;
            if (lastLine.startsWith('⌛')) {
              logLines[logLines.length - 1] = newLine;
            } else {
              addLog(newLine);
            }
            await render();
          };

          const runner = VIDEO_EVENTS.has(quest.eventName) ? runVideoQuest : runStreamQuest;
          let runnerError = null;
          await runner(userToken, quest, signal, onProgress, speedMultiplier, heartbeatInterval).catch((e) => {
            runnerError = e;
            if (e.message !== 'aborted') addLog(`⚠️ ${username}: ERROR ${e.message}`);
          });

          if (!signal.aborted && !runnerError) {
            // Re-fetch from Discord to confirm server-side completion before claiming
            const freshQuests = await fetchQuests(userToken).catch(() => []);
            const fresh = freshQuests.find((q) => q.id === quest.id);
            if (!fresh?.completed) {
              addLog(`⚠️ ${username}: ${quest.name} — Discord ยังไม่ยืนยันว่าเสร็จ`);
              await render();
              continue;
            }
            addLog(`✅ ${username}: ${quest.name} DONE`);
            await render();
            try {
              await claimQuest(userToken, quest.id);
              addLog(`🎁 ${username}: CLAIMED ${quest.name}`);
            } catch (e) {
              addLog(`⚠️ ${username}: claim error — ${e.message}`);
            }
            await render();
          }
        }

        if (!signal.aborted) {
          addLog(`🔄 ${username}: ROUND ${round} DONE — RECHECKING...`);
          await render();
          await sleep(3000, signal);
        }
      }

      if (signal.aborted) {
        addLog(`🛑 ${username}: STOPPED`);
        await render();
      }
    } catch (err) {
      if (err.message !== 'aborted') {
        addLog(`❌ ${username}: ${err.message}`);
        await render();
      }
    } finally {
      jobs.delete(jobKey);
    }
  })();
}

// ── Quest Runners ─────────────────────────────────────────────────────────────

async function runVideoQuest(token, quest, signal, onProgress, speedMultiplier, heartbeatSecs) {
  let current  = quest.progressSecs;
  const target = quest.secondsNeeded;
  while (current < target) {
    if (signal.aborted) throw new Error('aborted');
    await sendVideoProgress(token, quest.id, current).catch(() => null);
    current = Math.min(current + speedMultiplier * heartbeatSecs, target);
    await onProgress(Math.floor((current / target) * 100));
    if (current >= target) break;
    await sleep(heartbeatSecs * 1000, signal);
  }
  await sendVideoProgress(token, quest.id, target).catch(() => {});
  await onProgress(100);
}

async function runStreamQuest(token, quest, signal, onProgress, _speedMultiplier, heartbeatSecs) {
  const total     = quest.secondsNeeded;
  const ticks     = Math.ceil(total / heartbeatSecs);
  const startTick = Math.floor((quest.progressSecs / total) * ticks);
  for (let i = startTick; i < ticks; i++) {
    if (signal.aborted) throw new Error('aborted');
    await sendHeartbeat(token, quest.id).catch(() => {});
    await onProgress(Math.round(((i + 1) / ticks) * 100));
    await sleep(heartbeatSecs * 1000, signal);
  }
  await onProgress(100);
}
