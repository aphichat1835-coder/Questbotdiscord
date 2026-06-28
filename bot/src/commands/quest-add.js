import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { addQuest } from '../storage.js';

export const data = new SlashCommandBuilder()
  .setName('quest-add')
  .setDescription('เพิ่มเควสใหม่')
  .addStringOption((opt) =>
    opt.setName('name').setDescription('ชื่อเควส').setRequired(true)
  )
  .addStringOption((opt) =>
    opt.setName('deadline').setDescription('วันครบกำหนด (YYYY-MM-DD)').setRequired(false)
  )
  .addStringOption((opt) =>
    opt.setName('note').setDescription('โน้ตเพิ่มเติม').setRequired(false)
  );

export async function execute(interaction) {
  const name = interaction.options.getString('name');
  const deadline = interaction.options.getString('deadline');
  const note = interaction.options.getString('note');

  if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
    await interaction.reply({ content: '❌ รูปแบบ deadline ต้องเป็น `YYYY-MM-DD` เช่น `2026-07-01`', ephemeral: true });
    return;
  }

  const quest = addQuest({ name, deadline, note });

  const embed = new EmbedBuilder()
    .setTitle('✅ เพิ่มเควสสำเร็จ')
    .setColor(0x57f287)
    .addFields(
      { name: 'ID', value: `#${quest.id}`, inline: true },
      { name: 'ชื่อ', value: quest.name, inline: true },
      { name: 'Deadline', value: quest.deadline ?? '-', inline: true },
      { name: 'โน้ต', value: quest.note ?? '-' },
    );

  await interaction.reply({ embeds: [embed] });
}
