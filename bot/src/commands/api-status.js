import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { db } from '../db.js';
import { getQuestEngineStatus, listJobs } from '../discord-runner.js';
import { listStoppingAccounts } from '../runner-control.js';
import { listScheduledRunners } from '../scheduled-runner-store.js';

export const data = new SlashCommandBuilder()
  .setName('api-status')
  .setDescription('เช็กสถานะระบบ ฐานข้อมูล และผลตรวจ Quest API ล่าสุด');

function discordTime(iso) {
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? `<t:${Math.floor(timestamp / 1000)}:R>` : 'ยังไม่มี';
}

export async function execute(interaction) {
  await interaction.deferReply({ flags: 64 });

  const start = Date.now();
  let dbOk = false;
  let dbError = null;
  try {
    db.prepare('SELECT 1').get();
    dbOk = true;
  } catch (error) {
    dbError = error.message;
  }

  const latency = Date.now() - start;
  const memory = process.memoryUsage();
  const toMB = (value) => (value / 1024 / 1024).toFixed(1);
  const quest = getQuestEngineStatus();
  const jobs = listJobs();
  const persisted = listScheduledRunners();
  const stopping = listStoppingAccounts(interaction.user.id).length;

  const stateLabels = {
    unknown: '⚪ ยังไม่มีการตรวจ',
    compatible: '🟢 ใช้งานร่วมกันได้',
    degraded: '🟡 พบ schema/event ใหม่',
    incompatible: '🔴 รูปแบบ API ไม่รองรับ',
    error: '🔴 ติดต่อ API ไม่สำเร็จ',
  };

  const questDetails = [
    '**ข้อมูลนี้คือผลตรวจล่าสุดรวมจาก Runner ทุกบัญชี ไม่ใช่ของบัญชีใดบัญชีหนึ่ง**',
    `สถานะ: ${stateLabels[quest.state] ?? quest.state}`,
    `พยายามตรวจล่าสุด: ${discordTime(quest.lastCheckAt)}`,
    `สำเร็จล่าสุด: ${discordTime(quest.lastSuccessfulCheckAt)}`,
    `พบ ${quest.questCount} Quest / พร้อมทำ ${quest.supportedCount} / excluded ${quest.excludedCount ?? 0}`,
    `Endpoint: \`${quest.questListPath ?? 'ยังไม่มี'}\``,
  ];
  if (quest.enrollmentBlockedUntil) {
    questDetails.push(`รับ Quest ใหม่ได้: ${discordTime(quest.enrollmentBlockedUntil)}`);
  }
  if (quest.unknownEvents.length) {
    questDetails.push(`Event ใหม่: \`${quest.unknownEvents.join(', ').slice(0, 500)}\``);
  }
  if (quest.schemaIssues.length) {
    questDetails.push(`Schema: \`${quest.schemaIssues.join('; ').slice(0, 500)}\``);
  }

  const statusColor = !dbOk || ['error', 'incompatible'].includes(quest.state)
    ? 0xed4245
    : quest.state === 'degraded' ? 0xfee75c : 0x57f287;

  const embed = new EmbedBuilder()
    .setTitle('🔌 NeverDie System Status')
    .setColor(statusColor)
    .addFields(
      { name: 'Database', value: dbOk ? '🟢 OK' : '🔴 Error', inline: true },
      { name: 'Query Latency', value: `${latency}ms`, inline: true },
      { name: 'Bot Ping', value: `${interaction.client.ws.ping}ms`, inline: true },
      { name: 'RAM (RSS)', value: `${toMB(memory.rss)} MB`, inline: true },
      { name: 'Heap ที่ใช้', value: `${toMB(memory.heapUsed)} MB`, inline: true },
      { name: 'Heap ทั้งหมด', value: `${toMB(memory.heapTotal)} MB`, inline: true },
      {
        name: 'Runner',
        value: [
          `One-shot: **${jobs.filter((job) => job.mode === 'oneshot').length}**`,
          `Auto Daily ในหน่วยความจำ: **${jobs.filter((job) => job.mode === 'scheduled').length}**`,
          `Auto Daily ที่บันทึก: **${persisted.length}**`,
          `กำลังหยุดของคุณ: **${stopping}**`,
        ].join('\n'),
        inline: false,
      },
      { name: 'Discord Quest API — ล่าสุดรวมทุก Runner', value: questDetails.join('\n').slice(0, 1024) },
      {
        name: 'หลักฐานจาก Discord',
        value: [
          `ยืนยัน progress: ${discordTime(quest.lastVerifiedProgressAt)}`,
          `ยืนยัน completed_at: ${discordTime(quest.lastVerifiedCompletionAt)}`,
          `ยืนยัน claimed_at: ${discordTime(quest.lastVerifiedClaimAt)}`,
        ].join('\n'),
      },
    )
    .setTimestamp();

  if (dbError) embed.addFields({ name: '❌ Database Error', value: `\`${dbError}\`` });
  if (quest.lastError) embed.addFields({ name: '❌ Quest API Error', value: `\`${quest.lastError.slice(0, 900)}\`` });
  return interaction.editReply({ embeds: [embed] });
}
