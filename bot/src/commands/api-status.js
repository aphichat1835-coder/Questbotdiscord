import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { db } from '../db.js';
import {
  getQuestEngineStatus,
  listJobs,
  listQuestEngineStatuses,
} from '../discord-runner.js';
import { listStoppingAccounts } from '../runner-control.js';
import { listScheduledRunners } from '../scheduled-runner-store.js';

export const data = new SlashCommandBuilder()
  .setName('api-status')
  .setDescription('เช็กสถานะระบบ ฐานข้อมูล และผลตรวจ Quest API แยกตามบัญชี');

function discordTime(iso) {
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? `<t:${Math.floor(timestamp / 1000)}:R>` : 'ยังไม่มี';
}

const stateLabels = {
  unknown: '⚪ ยังไม่มีการตรวจ',
  compatible: '🟢 ใช้งานร่วมกันได้',
  degraded: '🟡 พบ schema/event ใหม่',
  incompatible: '🔴 รูปแบบ API ไม่รองรับ',
  error: '🔴 ติดต่อ API ไม่สำเร็จ',
};

function accountStatusLine(status) {
  const identity = status.username ?? status.accountId ?? status.jobKey ?? status.key;
  return [
    `**${String(identity).slice(0, 80)}** · ${stateLabels[status.state] ?? status.state}`,
    `Quest ${status.questCount} / พร้อมทำ ${status.supportedCount} · ${status.lifecycle}`,
    `ตรวจล่าสุด ${discordTime(status.lastCheckAt)}`,
  ].join('\n');
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
  const aggregate = getQuestEngineStatus();
  const accountStatuses = listQuestEngineStatuses({ ownerId: interaction.user.id });
  const jobs = listJobs();
  const persisted = listScheduledRunners();
  const stopping = listStoppingAccounts(interaction.user.id).length;

  const questDetails = [
    '**สรุปรวมจากสถานะแยกของทุก Job/Account**',
    `สถานะ: ${stateLabels[aggregate.state] ?? aggregate.state}`,
    `บัญชีที่มีสถานะ: **${aggregate.accountCount ?? 0}**`,
    `พยายามตรวจล่าสุด: ${discordTime(aggregate.lastCheckAt)}`,
    `สำเร็จล่าสุด: ${discordTime(aggregate.lastSuccessfulCheckAt)}`,
    `พบ ${aggregate.questCount} Quest / พร้อมทำ ${aggregate.supportedCount} / excluded ${aggregate.excludedCount ?? 0}`,
    `Endpoint: \`${aggregate.questListPath ?? 'ยังไม่มี'}\``,
  ];
  if (aggregate.enrollmentBlockedUntil) {
    questDetails.push(`รับ Quest ใหม่ได้: ${discordTime(aggregate.enrollmentBlockedUntil)}`);
  }
  if (aggregate.unknownEvents.length) {
    questDetails.push(`Event ใหม่: \`${aggregate.unknownEvents.join(', ').slice(0, 500)}\``);
  }
  if (aggregate.schemaIssues.length) {
    questDetails.push(`Schema: \`${aggregate.schemaIssues.join('; ').slice(0, 500)}\``);
  }

  const accountDetails = accountStatuses.length
    ? accountStatuses.slice(0, 8).map(accountStatusLine).join('\n\n')
    : 'ยังไม่มีผลตรวจ Quest API ของบัญชีคุณ';

  const statusColor = !dbOk || ['error', 'incompatible'].includes(aggregate.state)
    ? 0xed4245
    : aggregate.state === 'degraded' ? 0xfee75c : 0x57f287;

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
      { name: 'Discord Quest API — สรุปรวม', value: questDetails.join('\n').slice(0, 1024) },
      { name: 'สถานะบัญชีของคุณ', value: accountDetails.slice(0, 1024) },
      {
        name: 'หลักฐานจาก Discord — รวม',
        value: [
          `ยืนยัน progress: ${discordTime(aggregate.lastVerifiedProgressAt)}`,
          `ยืนยัน completed_at: ${discordTime(aggregate.lastVerifiedCompletionAt)}`,
          `ยืนยัน claimed_at: ${discordTime(aggregate.lastVerifiedClaimAt)}`,
        ].join('\n'),
      },
    )
    .setTimestamp();

  if (dbError) embed.addFields({ name: '❌ Database Error', value: `\`${dbError}\`` });
  if (aggregate.lastError) {
    embed.addFields({ name: '❌ Quest API Error ล่าสุด', value: `\`${aggregate.lastError.slice(0, 900)}\`` });
  }
  return interaction.editReply({ embeds: [embed] });
}
