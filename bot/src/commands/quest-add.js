import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { addQuest } from '../storage.js';
import { requireManager } from '../permissions.js';

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
  if (!await requireManager(interaction)) return;

  const name     = interaction.options.getString('name')?.trim();
  const deadline = interaction.options.getString('deadline')?.trim() || null;
  const note     = interaction.options.getString('note')?.trim()     || null;

  if (!name) {
    return interaction.reply({ content: '❌ ชื่อเควสต้องไม่ว่างเปล่า', ephemeral: true });
  }
  if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
    return interaction.reply({ content: '❌ รูปแบบ deadline ต้องเป็น `YYYY-MM-DD` เช่น `2026-07-01`', ephemeral: true });
  }

  await interaction.deferReply();

  try {
    const quest = await addQuest({ name, deadline, note });
    const embed = new EmbedBuilder()
      .setTitle('✅ เพิ่มเควสสำเร็จ')
      .setColor(0x57f287)
      .addFields(
        { name: 'ID',       value: `#${quest.id}`,          inline: true },
        { name: 'ชื่อ',     value: quest.name,                inline: true },
        { name: 'Deadline', value: quest.deadline ?? '—',     inline: true },
        { name: 'โน้ต',     value: quest.note     ?? '—' },
      )
      .setFooter({ text: `เพิ่มโดย ${interaction.user.username}` })
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply({ content: `❌ ${err.message}` });
  }
}
