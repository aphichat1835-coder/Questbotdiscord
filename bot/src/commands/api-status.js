import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { db } from '../db.js';

export const data = new SlashCommandBuilder()
  .setName('api-status')
  .setDescription('เช็กสถานะระบบและฐานข้อมูล');

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

  const embed = new EmbedBuilder()
    .setTitle('🔌 System Status')
    .setColor(dbOk ? 0x57f287 : 0xed4245)
    .addFields(
      { name: 'Database',       value: dbOk ? '🟢 OK' : '🔴 Error', inline: true },
      { name: 'Query Latency',  value: `${latency}ms`,               inline: true },
      { name: 'Bot Ping',       value: `${interaction.client.ws.ping}ms`, inline: true },
      { name: 'RAM (RSS)',      value: `${toMB(mem.rss)} MB`,         inline: true },
      { name: 'Heap ที่ใช้',    value: `${toMB(mem.heapUsed)} MB`,   inline: true },
      { name: 'Heap ทั้งหมด',  value: `${toMB(mem.heapTotal)} MB`,  inline: true },
    )
    .setTimestamp();

  if (error) embed.addFields({ name: '❌ Error', value: `\`${error}\`` });

  await interaction.editReply({ embeds: [embed] });
}
