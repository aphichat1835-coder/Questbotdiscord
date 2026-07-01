import 'dotenv/config';
import { EmbedBuilder } from 'discord.js';

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

function progressBar(pct) {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function statusColor(status) {
  if (status === 'error') return 0xed4245;
  if (status === 'done' || status === 'stopped') return 0x99aaab;
  return 0x5865f2;
}

export async function startRunner({
  userId,
  userToken,
  channelId,
  client,
  speedMultiplier   = 5,
  heartbeatInterval = 30,
}) {
  if (jobs.has(userId)) {
    throw new Error('มี job ที่กำลังรันอยู่แล้ว ใช้ /stop ก่อน');
  }

  const controller = new AbortController();
  const { signal } = controller;

  const state = {
    status: 'starting',
    round: 0,
    totalFound: 0,
    currentIndex: 0,
    currentQuestName: '',
    currentPct: 0,
    remaining: 0,
    lastEvent: 'กำลังเริ่มต้น...',
    startedAt: Date.now(),
  };

  let liveMessage = null;

  function buildEmbed() {
    const elapsedMin = Math.floor((Date.now() - state.startedAt) / 60000);
    return new EmbedBuilder()
      .setColor(statusColor(state.status))
      .setTitle('⚡ NeverDie Quest Runner')
      .addFields(
        { name: '📋 เควสที่พบ', value: `${state.totalFound} รายการ`, inline: true },
        { name: '🎯 กำลังทำ', value: state.currentQuestName ? `${state.currentQuestName} (${state.currentIndex}/${state.totalFound})` : '—', inline: true },
        { name: '⏳ เหลืออีก', value: `${state.remaining} รายการ`, inline: true },
        { name: '📈 ความคืบหน้าเควสปัจจุบัน', value: `${progressBar(state.currentPct)} ${state.currentPct}%` },
        { name: 'อัปเดตล่าสุด', value: state.lastEvent },
      )
      .setFooter({ text: `รอบที่ ${state.round} · ทำงานมาแล้ว ${elapsedMin} นาที · ใช้ /stop เพื่อหยุด` })
      .setTimestamp();
  }

  async function render(eventText) {
    if (eventText) state.lastEvent = eventText;
    if (!client || !channelId) return;
    try {
      if (!liveMessage) {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased?.()) return;
        liveMessage = await channel.send({ embeds: [buildEmbed()] });
      } else {
        await liveMessage.edit({ embeds: [buildEmbed()] });
      }
    } catch {}
  }

  jobs.set(userId, { controller, summary: () => ({ ...state }) });

  (async () => {
    try {
      state.status = 'running';

      while (!signal.aborted) {
        state.round++;
        await render(`🔍 กำลังเช็ค quest (รอบที่ ${state.round})...`);

        const allQuests = await fetchQuests(userToken);
        const active     = allQuests.filter((q) => !q.completed);

        state.totalFound   = active.length;
        state.currentIndex = 0;
        state.remaining    = active.length;

        if (active.length === 0) {
          state.status = 'done';
          await render('✅ ทุก quest เสร็จหมดแล้ว! 🎉');
          break;
        }

        for (let i = 0; i < active.length; i++) {
          if (signal.aborted) break;
          const quest = active[i];

          state.currentIndex     = i + 1;
          state.remaining        = active.length - (i + 1);
          state.currentQuestName = quest.name;
          state.currentPct       = Math.floor(quest.progress);

          if (!quest.enrolled) {
            await render(`📥 กำลัง enroll **${quest.name}**...`);
            await enrollQuest(userToken, quest.id).catch((e) => render(`⚠️ Enroll ล้มเหลว: ${e.message}`));
          }

          const isStream = quest.taskType.includes('stream');
          await render(`${isStream ? '🎮' : '▶️'} กำลังทำ **${quest.name}** (${isStream ? 'stream' : 'video'})...`);

          const onProgress = (pct) => {
            state.currentPct = pct;
            render();
          };

          const runner = isStream ? runStreamQuest : runVideoQuest;
          await runner(userToken, quest, signal, onProgress, speedMultiplier, heartbeatInterval).catch((e) => {
            if (e.message !== 'aborted') render(`⚠️ **${quest.name}** error: ${e.message}`);
          });

          if (!signal.aborted) await render(`✅ **${quest.name}** เสร็จแล้ว!`);
        }

        if (signal.aborted) break;
        await render(`✔️ รอบที่ ${state.round} เสร็จ — เช็ครอบใหม่ในอีก 3 วินาที...`);
        await sleep(3000, signal);
      }

      if (signal.aborted) {
        state.status = 'stopped';
        await render('🛑 Quest Runner ถูกหยุดแล้ว');
      }
    } catch (err) {
      if (err.message !== 'aborted') {
        state.status = 'error';
        await render(`❌ เกิดข้อผิดพลาด: ${err.message}`);
      }
    } finally {
      jobs.delete(userId);
    }
  })();
}

async function runVideoQuest(token, quest, signal, onProgress, speedMultiplier, heartbeatSecs) {
  let current  = quest.progressSecs;
  const target = quest.secondsNeeded;

  while (current < target) {
    if (signal.aborted) throw new Error('aborted');

    const res = await sendVideoProgress(token, quest.id, current).catch(() => null);
    if (res === null) throw new Error('Video progress API ไม่ตอบสนอง');

    current = Math.min(current + speedMultiplier * heartbeatSecs, target);
    onProgress(Math.floor((current / target) * 100));

    if (current >= target) break;
    await sleep(heartbeatSecs * 1000, signal);
  }

  await sendVideoProgress(token, quest.id, target).catch(() => {});
  onProgress(100);
}

async function runStreamQuest(token, quest, signal, onProgress, _speedMultiplier, heartbeatSecs) {
  const total     = quest.secondsNeeded;
  const ticks     = Math.ceil(total / heartbeatSecs);
  const startTick = Math.floor((quest.progressSecs / total) * ticks);

  for (let i = startTick; i < ticks; i++) {
    if (signal.aborted) throw new Error('aborted');

    await sendStreamHeartbeat(token, quest.id).catch(() => {});
    onProgress(Math.round(((i + 1) / ticks) * 100));
    await sleep(heartbeatSecs * 1000, signal);
  }

  onProgress(100);
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
