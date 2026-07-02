import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getStats } from '../storage.js';

export const data = new SlashCommandBuilder()
  .setName('quest-status')
  .setDescription('ดูสรุปสถิติเควสทั้งหมด');

export async function execute(interaction) {
  try {
    const { total, done, pending, overdue } = await getStats();
    const embed = new EmbedBuilder()
      .setTitle('📊 สถิติเควส')
      .setColor(0xfee75c)
      .addFields(
        { name: '📦 ทั้งหมด', value: `${total}`, inline: true },
        { name: '✅ เสร็จแล้ว', value: `${done}`, inline: true },
        { name: '🔴 รอดำเนินการ', value: `${pending}`, inline: true },
        { name: '⚠️ เกิน deadline', value: `${overdue}`, inline: true },
      );
    await interaction.reply({ embeds: [embed] });
  } catch (err) {
    await interaction.reply({ flags: 64, content: `❌ ${err.message}` });
  }
}
