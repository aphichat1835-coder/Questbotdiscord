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
    os: 'Windows',
    browser: 'Discord Client',
    release_channel: 'stable',
    client_version: CLIENT_VERSION,
    os_version: '10.0.19045',
    os_arch: 'x64',
    app_arch: 'x64',
    system_locale: 'en-US',
    browser_user_agent: USER_AGENT,
    browser_version: CHROME_VERSION,
    client_build_number: CLIENT_BUILD_NUMBER,
    native_build_number: NATIVE_BUILD_NUMBER,
    client_event_source: null,
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
  const res = await fetch(`${DISCORD_API}${path}`, {
    headers: userHeaders(token),
    ...options,
  });
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
  const raw = await discordFetch(token, '/users/@me/quests');
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeQuest);
}

async function enrollQuest(token, questId) {
  return discordFetch(token, `/quests/${questId}/enroll`, { method: 'POST', body: '{}' });
}

async function sendVideoProgress(token, questId, timestamp) {
  const ts = Math.round(timestamp + Math.random() * 0.5);
  return discordFetch(token, `/quests/${questId}/video-progress`, {
    method: 'POST',
    body: JSON.stringify({ timestamp: ts }),
  });
}

async function sendStreamHeartbeat(token, questId) {
  return discordFetch(token, `/quests/${questId}/heartbeat`, {
    method: 'POST',
    body: JSON.stringify({ stream_key: `${questId}:stream` }),
  });
}

function normalizeQuest(raw) {
  const cfg        = raw.config ?? {};
  const userStatus = raw.user_status ?? {};
  const secondsNeeded =
    cfg.stream_duration_requirement ??
    cfg.video_stream_duration_requirement ??
    (cfg.minutes_requirement != null ? cfg.minutes_requirement * 60 : 0);
  const progress    = parseFloat(userStatus.progress ?? '0');
  const progressSecs = (progress / 100) * secondsNeeded;

  return {
    id:           raw.id,
    name:         cfg.messages?.quest_name ?? raw.id,
    description:  cfg.messages?.task_incomplete?.[0] ?? '',
    progress,
    secondsNeeded,
    taskType:     cfg.task_config?.type ?? 'video',
    enrolled:     !!userStatus.enrolled_at,
    completed:    !!userStatus.completed_at,
    progressSecs,
  };
}

const jobs = new Map();

export function getJob(userId)  { return jobs.get(userId) ?? null; }
export function listJobs()      { return [...jobs.entries()].map(([userId, j]) => ({ userId, ...j.summary() })); }

export async function startRunner({
  userId,
  userToken,
  channelId,
  botToken,
  speedMultiplier   = 5,
  heartbeatInterval = 30,
}) {
  if (jobs.has(userId)) {
    throw new Error('มี job ที่กำลังรันอยู่แล้ว ใช้ /stop ก่อน');
  }

  const controller = new AbortController();
  const { signal } = controller;

  let status          = 'starting';
  let currentQuestName = '';
  let questList        = [];
  let startedAt        = Date.now();

  const summary = () => ({
    status,
    currentQuestName,
    questCount: questList.length,
    elapsedMs: Date.now() - startedAt,
  });

  jobs.set(userId, { controller, summary });

  async function notify(content) {
    if (!botToken || !channelId) return;
    try {
      await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content }),
      });
    } catch {}
  }

  (async () => {
    try {
      status = 'running';
      let round = 0;

      while (!signal.aborted) {
        round++;
        await notify(`🔍 กำลังเช็ค quest${round > 1 ? ` (รอบที่ ${round})` : ''}...`);

        const allQuests = await fetchQuests(userToken);
        const active    = allQuests.filter((q) => !q.completed);
        questList       = active;

        if (active.length === 0) {
          await notify('✅ ทุก quest เสร็จหมดแล้ว! 🎉');
          status = 'done';
          break;
        }

        const planLines = active.map((q, i) =>
          `\`${i + 1}.\` **${q.name}** ${q.enrolled ? '' : '_(ยังไม่ได้ enroll)_'} — ${q.progress.toFixed(1)}%`
        ).join('\n');
        await notify(`📋 **แผนรอบที่ ${round}** (${active.length} รายการ)\n${planLines}\n\n⚡ เริ่มทำเลย...`);

        for (const quest of active) {
          if (signal.aborted) break;

          if (!quest.enrolled) {
            await notify(`📥 กำลัง enroll **${quest.name}**...`);
            await enrollQuest(userToken, quest.id).catch((e) => notify(`⚠️ Enroll ล้มเหลว: ${e.message}`));
          }

          currentQuestName = quest.name;
          const isStream = quest.taskType.includes('stream');
          await notify(`${isStream ? '🎮' : '▶️'} กำลังทำ **${quest.name}** (${isStream ? 'stream' : 'video'})...`);

          const runner = isStream ? runStreamQuest : runVideoQuest;
          await runner(userToken, quest, signal, notify, speedMultiplier, heartbeatInterval).catch((e) => {
            if (e.message !== 'aborted') notify(`⚠️ **${quest.name}** error: ${e.message}`);
          });
        }

        if (signal.aborted) break;
        await notify(`✔️ รอบที่ ${round} เสร็จ — เช็ครอบใหม่...`);
        await sleep(3000, signal);
      }

      if (signal.aborted) {
        await notify('🛑 Quest Runner ถูกหยุดแล้ว');
        status = 'stopped';
      }
    } catch (err) {
      if (err.message !== 'aborted') {
        await notify(`❌ เกิดข้อผิดพลาด: ${err.message}`);
      }
      status = 'error';
    } finally {
      jobs.delete(userId);
    }
  })();
}

async function runVideoQuest(token, quest, signal, notify, speedMultiplier, heartbeatSecs) {
  let current       = quest.progressSecs;
  const target      = quest.secondsNeeded;
  let lastNotifyPct = Math.floor((current / target) * 100);

  while (current < target) {
    if (signal.aborted) throw new Error('aborted');

    const res = await sendVideoProgress(token, quest.id, current).catch(() => null);

    if (res === null) {
      throw new Error('Video progress API ไม่ตอบสนอง');
    }

    current = Math.min(current + speedMultiplier * heartbeatSecs, target);
    const pct = Math.floor((current / target) * 100);

    if (pct >= lastNotifyPct + 25 || pct >= 100) {
      await notify(`⏳ **${quest.name}**: ${pct}%`);
      lastNotifyPct = pct;
    }

    if (current >= target) break;
    await sleep(heartbeatSecs * 1000, signal);
  }

  await sendVideoProgress(token, quest.id, target).catch(() => {});
  await notify(`✅ **${quest.name}** เสร็จแล้ว!`);
}

async function runStreamQuest(token, quest, signal, notify, _speedMultiplier, heartbeatSecs) {
  const total    = quest.secondsNeeded;
  const ticks    = Math.ceil(total / heartbeatSecs);
  const startTick = Math.floor((quest.progressSecs / total) * ticks);

  for (let i = startTick; i < ticks; i++) {
    if (signal.aborted) throw new Error('aborted');

    await sendStreamHeartbeat(token, quest.id).catch(() => {});

    const pct = Math.round(((i + 1) / ticks) * 100);
    if (pct % 25 === 0 || pct >= 100) {
      await notify(`⏳ **${quest.name}**: ${pct}%`);
    }
    await sleep(heartbeatSecs * 1000, signal);
  }

  await notify(`✅ **${quest.name}** เสร็จแล้ว!`);
}

export function stopRunner(userId) {
  const job = jobs.get(userId);
  if (!job) return false;
  job.controller.abort();
  jobs.delete(userId);
  return true;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    }, { once: true });
  });
}
