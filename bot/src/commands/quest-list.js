import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getAllQuests } from '../storage.js';

export const data = new SlashCommandBuilder()
  .setName('quest-list')
  .setDescription('ดูรายการเควสทั้งหมด');

export async function execute(interaction) {
  try {
    const quests = await getAllQuests();

    if (!quests.length) {
      return interaction.reply('📭 ยังไม่มีเควสเลย ลองใช้ `/quest-add` เพื่อเพิ่มเควสแรก');
    }

    const pending = quests.filter((q) => !q.done);
    const done = quests.filter((q) => q.done);

    const formatRow = (q) => {
      const deadline = q.deadline ? ` · 📅 ${q.deadline}` : '';
      const note = q.note ? ` · 📝 ${q.note}` : '';
      return `\`#${q.id}\` ${q.name}${deadline}${note}`;
    };

    const embed = new EmbedBuilder()
      .setTitle('📋 รายการเควส')
      .setColor(0x5865f2);

    if (pending.length > 0) {
      embed.addFields({ name: `🔴 รอดำเนินการ (${pending.length})`, value: pending.map(formatRow).join('\n') });
    }
    if (done.length > 0) {
      embed.addFields({ name: `✅ เสร็จแล้ว (${done.length})`, value: done.map(formatRow).join('\n') });
    }

    await interaction.reply({ embeds: [embed] });
  } catch (err) {
    await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
  }
}
