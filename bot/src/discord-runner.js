import 'dotenv/config';

const DISCORD_API         = 'https://discord.com/api/v9';
const CLIENT_VERSION      = '1.0.9243';
const CHROME_VERSION      = '138.0.7204.251';
const ELECTRON_VERSION    = '37.6.0';
const CLIENT_BUILD_NUMBER = 569817;
const NATIVE_BUILD_NUMBER = 84934;

const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/${CLIENT_VERSION} Chrome/${CHROME_VERSION} Electron/${ELECTRON_VERSION} Safari/537.36`;

function buildSuperProperties() {
  return Buffer.from(JSON.stringify({
    os: 'Windows', browser: 'Discord Client', release_channel: 'stable',
    client_version: CLIENT_VERSION, os_version: '10.0.19045', os_arch: 'x64',
    app_arch: 'x64', system_locale: 'en-US', browser_user_agent: USER_AGENT,
    browser_version: CHROME_VERSION, client_build_number: CLIENT_BUILD_NUMBER,
    native_build_number: NATIVE_BUILD_NUMBER, client_event_source: null,
  })).toString('base64');
}

function userHeaders(token) {
  return {
    Authorization: token,
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    'X-Super-Properties': buildSuperProperties(),
    'X-Debug-Options': 'bugReporterEnabled',
    Accept: '*/*',
    Referer: 'https://discord.com/quest-home',
  };
}

async function discordFetch(token, path, options = {}) {
  const res = await fetch(`${DISCORD_API}${path}`, { headers: userHeaders(token), ...options });
  if (res.status === 204) return { ok: true, status: 204 };
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`Discord API ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

export async function fetchMe(token) {
  return discordFetch(token, '/users/@me');
}

export async function fetchQuests(token) {
  let raw;
  try {
    raw = await discordFetch(token, '/users/@me/quests');
  } catch (err) {
    if (err.message.includes('404')) return [];
    throw err;
  }
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeQuest);
}

async function enrollQuest(token, questId) {
  return discordFetch(token, `/quests/${questId}/enroll`, { method: 'POST', body: '{}' });
}

async function sendVideoProgress(token, questId, timestamp) {
  const ts = Math.round(timestamp + Math.random() * 0.5);
  return discordFetch(token, `/quests/${questId}/video-progress`, {
    method: 'POST', body: JSON.stringify({ timestamp: ts }),
  });
}

async function sendStreamHeartbeat(token, questId) {
  return discordFetch(token, `/quests/${questId}/heartbeat`, {
    method: 'POST', body: JSON.stringify({ stream_key: `${questId}:stream` }),
  });
}

function normalizeQuest(raw) {
  const cfg        = raw.config ?? {};
  const userStatus = raw.user_status ?? {};
  const secondsNeeded =
    cfg.stream_duration_requirement ??
    cfg.video_stream_duration_requirement ??
    (cfg.minutes_requirement != null ? cfg.minutes_requirement * 60 : 0);
  const progress     = parseFloat(userStatus.progress ?? '0');
  const progressSecs = (progress / 100) * secondsNeeded;
  return {
    id: raw.id,
    name: cfg.messages?.quest_name ?? raw.id,
    description: cfg.messages?.task_incomplete?.[0] ?? '',
    progress, secondsNeeded,
    taskType: cfg.task_config?.type ?? 'video',
    enrolled: !!userStatus.enrolled_at,
    completed: !!userStatus.completed_at,
    progressSecs,
  };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
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

  let liveMsg   = null;
  let username  = '...';
  const logLines = [];

  function addLog(line) {
    logLines.push(line);
    if (logLines.length > 25) logLines.shift();
  }

  async function render() {
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

        if (active.length === 0) {
          addLog(`📭 ${username}: ไม่มี Quest ให้ทำในตอนนี้`);
          await render();
          break;
        }

        addLog(`🎯 ${username}: ${active.length} QUESTS`);
        await render();

        for (const quest of active) {
          if (signal.aborted) break;

          if (!quest.enrolled) {
            addLog(`🚀 ${username}: JOIN ${quest.name}`);
            await render();
            await enrollQuest(userToken, quest.id).catch(() => {});
          }

          addLog(`🚀 ${username}: ${quest.name}`);
          await render();

          const isStream = quest.taskType.includes('stream');
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

          const runner = isStream ? runStreamQuest : runVideoQuest;
          await runner(userToken, quest, signal, onProgress, speedMultiplier, heartbeatInterval).catch((e) => {
            if (e.message !== 'aborted') addLog(`⚠️ ${username}: ERROR ${e.message}`);
          });

          if (!signal.aborted) {
            addLog(`✅ ${username}: ${quest.name} DONE`);
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
    await sendStreamHeartbeat(token, quest.id).catch(() => {});
    await onProgress(Math.round(((i + 1) / ticks) * 100));
    await sleep(heartbeatSecs * 1000, signal);
  }
  await onProgress(100);
}
