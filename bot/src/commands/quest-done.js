import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { markDone } from '../storage.js';

export const data = new SlashCommandBuilder()
  .setName('quest-done')
  .setDescription('มาร์คเควสว่าเสร็จแล้ว')
  .addIntegerOption((opt) =>
    opt.setName('id').setDescription('ID ของเควส').setRequired(true).setMinValue(1)
  );

export async function execute(interaction) {
  const id = interaction.options.getInteger('id');
  try {
    const quest = await markDone(id);
    if (!quest) {
      return interaction.reply({ content: `❌ ไม่พบเควส ID #${id}`, ephemeral: true });
    }
    const embed = new EmbedBuilder()
      .setTitle('🎉 เควสเสร็จแล้ว!')
      .setColor(0x57f287)
      .addFields(
        { name: 'ID', value: `#${quest.id}`, inline: true },
        { name: 'ชื่อ', value: quest.name, inline: true },
      );
    await interaction.reply({ embeds: [embed] });
  } catch (err) {
    await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
  }
}
