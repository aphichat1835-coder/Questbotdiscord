import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { backupDatabase } from './db.js';
import { reportCriticalError } from './error-reporter.js';
import { nextDailyTime, zonedDateKey } from './runner-schedule.js';
import { getAllQuests, getStats } from './storage.js';

let client        = null;
let checkInterval = null;
let summaryTimeout = null;
let backupTimeout = null;
let workerStopping = false;
const activeTasks = new Set();

function trackTask(promise) {
  activeTasks.add(promise);
  void promise.then(
    () => activeTasks.delete(promise),
    () => activeTasks.delete(promise),
  );
  return promise;
}

export function startWorker(discordClient) {
  client = discordClient;
  workerStopping = false;
  console.log('⏰ Worker เริ่มแล้ว — เช็ก deadline ทุก 1 ชั่วโมง');

  checkInterval = setInterval(() => {
    trackTask(checkDeadlines());
  }, 60 * 60 * 1000);
  trackTask(checkDeadlines());

  scheduleDailySummary();
  if (config.databaseBackupDir) scheduleDatabaseBackup();
}

export async function stopWorker(timeoutMs = 5000) {
  workerStopping = true;
  if (checkInterval)  { clearInterval(checkInterval);  checkInterval  = null; }
  if (summaryTimeout) { clearTimeout(summaryTimeout);  summaryTimeout = null; }
  if (backupTimeout)  { clearTimeout(backupTimeout);   backupTimeout = null; }
  let timeout;
  await Promise.race([
    Promise.allSettled([...activeTasks]),
    new Promise((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timeout);
  console.log('⏰ Worker หยุดแล้ว');
}

function scheduleDailySummary() {
  if (workerStopping) return;
  const tz       = config.timezone ?? 'Asia/Bangkok';
  const msUntil  = nextDailyTime(8, new Date(), tz).getTime() - Date.now();

  const hrs = Math.floor(msUntil / 3600000);
  const min = Math.floor((msUntil % 3600000) / 60000);
  console.log(`📅 Daily summary จะส่งในอีก ${hrs}h ${min}m`);

  summaryTimeout = setTimeout(() => {
    trackTask((async () => {
      await sendDailySummary();
      // Re-schedule daily at 8am instead of drifting with a fixed 24h interval
      scheduleDailySummary();
    })());
  }, msUntil);
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
    const today = zonedDateKey(new Date(), tz);
    const tomorrowStr = zonedDateKey(new Date(), tz, 1);

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
    await reportCriticalError('Deadline worker', err);
  }
}

function scheduleDatabaseBackup() {
  if (workerStopping) return;
  const next = nextDailyTime(3, new Date(), config.timezone);
  const delay = next.getTime() - Date.now();
  console.log(`💾 Database backup จะทำในอีก ${Math.floor(delay / 3600000)}h ${Math.floor((delay % 3600000) / 60000)}m`);

  backupTimeout = setTimeout(() => {
    trackTask((async () => {
      try {
        await runDatabaseBackup();
      } catch (err) {
        await reportCriticalError('Database backup', err);
      } finally {
        scheduleDatabaseBackup();
      }
    })());
  }, delay);
  backupTimeout.unref?.();
}

export async function runDatabaseBackup(now = new Date()) {
  if (!config.databaseBackupDir) return null;

  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const filename = `questbot-${timestamp}.db`;
  const destination = path.join(config.databaseBackupDir, filename);
  await backupDatabase(destination);

  const files = (await fs.readdir(config.databaseBackupDir))
    .filter((name) => /^questbot-.*\.db$/.test(name))
    .sort()
    .reverse();
  await Promise.all(
    files.slice(config.databaseBackupRetention)
      .map((name) => fs.unlink(path.join(config.databaseBackupDir, name))),
  );
  console.log(`💾 Database backup สำเร็จ → ${destination}`);
  return destination;
}

export async function sendDailySummary() {
  if (!config.logChannelId) return;
  const tz    = config.timezone ?? 'Asia/Bangkok';
  const today = zonedDateKey(new Date(), tz);

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
    await reportCriticalError('Daily summary worker', err);
  }
}
