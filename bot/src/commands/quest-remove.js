import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { removeQuest } from '../storage.js';

export const data = new SlashCommandBuilder()
  .setName('quest-remove')
  .setDescription('ลบเควสออกจากรายการ')
  .addIntegerOption((opt) =>
    opt.setName('id').setDescription('ID ของเควส').setRequired(true).setMinValue(1)
  );

export async function execute(interaction) {
  const id = interaction.options.getInteger('id');
  const quest = removeQuest(id);

  if (!quest) {
    await interaction.reply({ content: `❌ ไม่พบเควส ID #${id}`, ephemeral: true });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('🗑️ ลบเควสแล้ว')
    .setColor(0xed4245)
    .addFields(
      { name: 'ID', value: `#${quest.id}`, inline: true },
      { name: 'ชื่อ', value: quest.name, inline: true },
    );

  await interaction.reply({ embeds: [embed] });
}
