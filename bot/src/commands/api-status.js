import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { db } from '../db.js';
import { getQuestEngineStatus } from '../discord-runner.js';

export const data = new SlashCommandBuilder()
  .setName('api-status')
  .setDescription('เช็กสถานะระบบ ฐานข้อมูล และ Discord Quest API');

export async function execute(interaction) {
  await interaction.deferReply({ flags: 64 });

  const start = Date.now();
  let dbOk = false;
  let error = null;

  try {
    db.prepare('SELECT 1').get();
    dbOk = true;
  } catch (err) {
    error = err.message;
  }

  const latency = Date.now() - start;
  const mem     = process.memoryUsage();
  const toMB    = (n) => (n / 1024 / 1024).toFixed(1);
  const quest   = getQuestEngineStatus();
  const stateLabels = {
    unknown: '⚪ ยังไม่มีการตรวจ',
    compatible: '🟢 ใช้งานร่วมกันได้',
    degraded: '🟡 พบ schema/event ใหม่',
    incompatible: '🔴 รูปแบบ API ไม่รองรับ',
    error: '🔴 ติดต่อ API ไม่สำเร็จ',
  };
  const discordTime = (iso) => {
    const timestamp = Date.parse(iso);
    return Number.isFinite(timestamp) ? `<t:${Math.floor(timestamp / 1000)}:R>` : 'ยังไม่มี';
  };
  const questDetails = [
    `สถานะ: ${stateLabels[quest.state] ?? quest.state}`,
    `พยายามตรวจล่าสุด: ${discordTime(quest.lastCheckAt)}`,
    `สำเร็จล่าสุด: ${discordTime(quest.lastSuccessfulCheckAt)}`,
    `พบ ${quest.questCount} เควส / พร้อมทำ ${quest.supportedCount} / excluded ${quest.excludedCount ?? 0}`,
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
    .setTitle('🔌 System Status')
    .setColor(statusColor)
    .addFields(
      { name: 'Database',       value: dbOk ? '🟢 OK' : '🔴 Error', inline: true },
      { name: 'Query Latency',  value: `${latency}ms`,               inline: true },
      { name: 'Bot Ping',       value: `${interaction.client.ws.ping}ms`, inline: true },
      { name: 'RAM (RSS)',      value: `${toMB(mem.rss)} MB`,         inline: true },
      { name: 'Heap ที่ใช้',    value: `${toMB(mem.heapUsed)} MB`,   inline: true },
      { name: 'Heap ทั้งหมด',  value: `${toMB(mem.heapTotal)} MB`,  inline: true },
      { name: 'Discord Quest API', value: questDetails.join('\n').slice(0, 1024), inline: false },
      {
        name: 'หลักฐานจาก Discord',
        value: [
          `ยืนยัน progress: ${discordTime(quest.lastVerifiedProgressAt)}`,
          `ยืนยัน completed_at: ${discordTime(quest.lastVerifiedCompletionAt)}`,
          `ยืนยัน claimed_at: ${discordTime(quest.lastVerifiedClaimAt)}`,
        ].join('\n'),
        inline: false,
      },
    )
    .setTimestamp();

  if (error) embed.addFields({ name: '❌ Database Error', value: `\`${error}\`` });
  if (quest.lastError) {
    embed.addFields({ name: '❌ Quest API Error', value: `\`${quest.lastError.slice(0, 900)}\`` });
  }

  await interaction.editReply({ embeds: [embed] });
}
