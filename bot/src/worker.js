import { config } from './config.js';

let client        = null;
let checkInterval = null;
let summaryTimeout = null;

export function startWorker(discordClient) {
  client = discordClient;
  console.log('⏰ Worker เริ่มแล้ว — เช็ก deadline ทุก 1 ชั่วโมง');

  checkInterval = setInterval(checkDeadlines, 60 * 60 * 1000);
  checkDeadlines();

  scheduleDailySummary();
}

export function stopWorker() {
  if (checkInterval)  { clearInterval(checkInterval);  checkInterval  = null; }
  if (summaryTimeout) { clearTimeout(summaryTimeout);  summaryTimeout = null; }
  console.log('⏰ Worker หยุดแล้ว');
}

function scheduleDailySummary() {
  const tz        = config.timezone ?? 'Asia/Bangkok';
  const now       = new Date();
  const tomorrow  = new Date(now.toLocaleDateString('sv-SE', { timeZone: tz }) + 'T08:00:00');

  const localOffset = -now.getTimezoneOffset() * 60 * 1000;
  const tzOffset    = getTzOffsetMs(tz);
  const targetUtc   = tomorrow.getTime() - tzOffset + localOffset;
  let msUntil8am    = targetUtc - now.getTime();

  if (msUntil8am <= 0) msUntil8am += 24 * 60 * 60 * 1000;

  summaryTimeout = setTimeout(async () => {
    await sendDailySummary();
    summaryTimeout = setInterval(sendDailySummary, 24 * 60 * 60 * 1000);
  }, msUntil8am);

  const hrs = Math.floor(msUntil8am / 3600000);
  const min = Math.floor((msUntil8am % 3600000) / 60000);
  console.log(`📅 Daily summary จะส่งในอีก ${hrs}h ${min}m`);
}

function getTzOffsetMs(tz) {
  const date = new Date();
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr  = date.toLocaleString('en-US', { timeZone: tz });
  return new Date(tzStr).getTime() - new Date(utcStr).getTime();
}

async function fetchQuests() {
  const res = await fetch(`${config.apiUrl}/quests`, {
    headers: config.apiSecret ? { 'x-api-secret': config.apiSecret } : {},
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function fetchStats() {
  const res = await fetch(`${config.apiUrl}/quests/stats`, {
    headers: config.apiSecret ? { 'x-api-secret': config.apiSecret } : {},
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function sendToLogChannel(content) {
  if (!config.logChannelId) return;
  const channel = await client.channels.fetch(config.logChannelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;
  await channel.send({ content });
}

async function checkDeadlines() {
  if (!config.logChannelId) return;

  try {
    const quests = await fetchQuests();
    const tz     = config.timezone ?? 'Asia/Bangkok';
    const today  = new Date().toLocaleDateString('sv-SE', { timeZone: tz });

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toLocaleDateString('sv-SE', { timeZone: tz });

    const overdue    = quests.filter((q) => !q.done && q.deadline && q.deadline < today);
    const dueToday   = quests.filter((q) => !q.done && q.deadline === today);
    const dueTomorrow = quests.filter((q) => !q.done && q.deadline === tomorrowStr);

    if (!overdue.length && !dueToday.length && !dueTomorrow.length) return;

    const fmt = (q) => `• \`#${q.id}\` **${q.name}**${q.deadline ? ` — ${q.deadline}` : ''}`;
    const parts = [];

    if (overdue.length)    parts.push(`🔴 **เกิน Deadline แล้ว (${overdue.length}):**\n${overdue.map(fmt).join('\n')}`);
    if (dueToday.length)   parts.push(`⚠️ **หมดวันนี้ (${dueToday.length}):**\n${dueToday.map(fmt).join('\n')}`);
    if (dueTomorrow.length) parts.push(`📅 **หมดพรุ่งนี้ (${dueTomorrow.length}):**\n${dueTomorrow.map(fmt).join('\n')}`);

    await sendToLogChannel(`⏰ **Quest Deadline Alert** · ${today}\n\n${parts.join('\n\n')}`);
  } catch (err) {
    console.error('[Worker] checkDeadlines error:', err.message);
  }
}

export async function sendDailySummary() {
  if (!config.logChannelId) return;
  const tz    = config.timezone ?? 'Asia/Bangkok';
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: tz });

  try {
    const { total, done, pending, overdue } = await fetchStats();
    await sendToLogChannel([
      `📊 **Daily Quest Summary** · ${today}`,
      `📦 ทั้งหมด: **${total}**`,
      `✅ เสร็จแล้ว: **${done}**`,
      `🔴 ค้างอยู่: **${pending}**`,
      overdue > 0 ? `⚠️ เกิน deadline: **${overdue}**` : `✅ ไม่มีที่เกิน deadline`,
    ].join('\n'));
  } catch (err) {
    console.error('[Worker] sendDailySummary error:', err.message);
  }
}
