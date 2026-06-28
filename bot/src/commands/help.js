import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('แสดงคำสั่งทั้งหมดของบอท');

export async function execute(interaction) {
  const embed = new EmbedBuilder()
    .setTitle('📋 NeverDie Quest Bot — คำสั่งทั้งหมด')
    .setColor(0x5865f2)
    .addFields(
      { name: '/ping', value: 'เช็กว่าบอทออนไลน์อยู่ไหม' },
      { name: '/quest-add', value: 'เพิ่มเควสใหม่\n`name` (จำเป็น) · `deadline` · `note`' },
      { name: '/quest-list', value: 'ดูรายการเควสทั้งหมด' },
      { name: '/quest-done', value: 'มาร์คเควสว่าเสร็จแล้ว\n`id` (จำเป็น)' },
      { name: '/quest-remove', value: 'ลบเควสออก\n`id` (จำเป็น)' },
      { name: '/quest-status', value: 'ดูสรุปสถิติเควสทั้งหมด' },
    )
    .setFooter({ text: 'NeverDie Quest Helper Bot' });

  await interaction.reply({ embeds: [embed] });
}
