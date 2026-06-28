import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { removeQuest } from '../storage.js';
import { requireAdmin } from '../permissions.js';

export const data = new SlashCommandBuilder()
  .setName('quest-remove')
  .setDescription('ลบเควสออกจากรายการ (ต้องการสิทธิ์ Admin)')
  .addIntegerOption((opt) =>
    opt.setName('id').setDescription('ID ของเควส').setRequired(true).setMinValue(1)
  );

export async function execute(interaction) {
  if (!await requireAdmin(interaction)) return;

  await interaction.deferReply({ ephemeral: true });
  const id = interaction.options.getInteger('id');

  try {
    const quest = await removeQuest(id);
    if (!quest) {
      return interaction.editReply({ content: `❌ ไม่พบเควส ID #${id}` });
    }
    const embed = new EmbedBuilder()
      .setTitle('🗑️ ลบเควสแล้ว')
      .setColor(0xed4245)
      .addFields(
        { name: 'ID',   value: `#${quest.id}`,  inline: true },
        { name: 'ชื่อ', value: quest.name,        inline: true },
      )
      .setFooter({ text: `ลบโดย ${interaction.user.username}` })
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply({ content: `❌ ${err.message}` });
  }
}
