import { config } from './config.js';
import { getAllQuests, getStats } from './storage.js';

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
  const tz       = config.timezone ?? 'Asia/Bangkok';
  const msUntil  = msUntilNext8am(tz);

  const hrs = Math.floor(msUntil / 3600000);
  const min = Math.floor((msUntil % 3600000) / 60000);
  console.log(`📅 Daily summary จะส่งในอีก ${hrs}h ${min}m`);

  summaryTimeout = setTimeout(async () => {
    await sendDailySummary();
    // Re-schedule daily at 8am instead of drifting with a fixed 24h interval
    scheduleDailySummary();
  }, msUntil);
}

/**
 * Returns milliseconds until the next 08:00 in the given IANA timezone.
 * Uses Intl.DateTimeFormat to reliably determine the current date in that tz.
 */
function msUntilNext8am(tz) {
  const now     = new Date();
  // e.g. "2026-07-02" — the current date in target tz
  const dateStr = now.toLocaleDateString('sv-SE', { timeZone: tz });
  // Offset in ms: (target tz time) - (UTC time)
  const utcStr  = now.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr   = now.toLocaleString('en-US', { timeZone: tz });
  const offset  = new Date(tzStr).getTime() - new Date(utcStr).getTime();
  // UTC timestamp of today's midnight in target tz
  const midnightUtc = new Date(dateStr + 'T00:00:00Z').getTime() - offset;
  // UTC timestamp of 8am today in target tz
  let next8amUtc = midnightUtc + 8 * 3600000;
  // If 8am already passed today, aim for tomorrow
  if (next8amUtc <= now.getTime()) next8amUtc += 24 * 3600000;
  return next8amUtc - now.getTime();
}

async function fetchQuests() {
  return getAllQuests();
}

async function fetchStats() {
  return getStats();
}

async function sendToLogChannel(content) {
  if (!config.logChannelId) return;
  const channel = await client.channels.fetch(config.logChannelId).catch((err) => {
    console.error('[Worker] ไม่พบ log channel:', err.message);
    return null;
  });
  if (!channel?.isTextBased?.()) return;
  await channel.send({ content }).catch((err) => {
    console.error('[Worker] ส่งข้อความ log channel ไม่ได้:', err.message);
  });
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
