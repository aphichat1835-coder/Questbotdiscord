import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { db } from '../db.js';
import { listJobs } from '../discord-runner.js';

export const data = new SlashCommandBuilder()
  .setName('api-status')
  .setDescription('เช็กสถานะระบบและฐานข้อมูล');

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

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
  const jobs = listJobs();

  const embed = new EmbedBuilder()
    .setTitle('🔌 System Status')
    .setColor(dbOk ? 0x57f287 : 0xed4245)
    .addFields(
      { name: 'Database', value: `${dbOk ? '🟢 OK' : '🔴 Error'}`, inline: true },
      { name: 'Query Latency', value: `${latency}ms`, inline: true },
      { name: 'Runner Jobs กำลังทำงาน', value: `${jobs.length}`, inline: true },
    )
    .setTimestamp();

  if (error) embed.addFields({ name: '❌ Error', value: `\`${error}\`` });

  await interaction.editReply({ embeds: [embed] });
}
