import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('แสดงคำสั่งทั้งหมดของบอท');

export async function execute(interaction) {
  const embed = new EmbedBuilder()
    .setTitle('📋 NeverDie Quest Bot — คำสั่งทั้งหมด')
    .setColor(0x5865f2)
    .addFields(
      {
        name: '🎛️ แผงควบคุม',
        value: '`/panel` — เปิดแผงควบคุม กด **🚀 START NOW** เพื่อเริ่ม / **🔴 STOP ALL** เพื่อหยุด',
      },
      {
        name: '🤖 Auto Quest Runner',
        value: [
          '`/run` — กรอก token แล้วระบบทำ Discord Quest อัตโนมัติ',
          '`/stop` — หยุด Runner ทั้งหมดของตัวเอง',
        ].join('\n'),
      },
      {
        name: '🔧 ระบบ',
        value: [
          '`/api-status` — เช็กสถานะระบบ RAM และ ping',
          '`/ping` — เช็กว่าบอทออนไลน์',
          '`/help` — แสดงหน้านี้',
        ].join('\n'),
      },
    )
    .setFooter({ text: 'NeverDie Quest Helper Bot' });

  await interaction.reply({ embeds: [embed] });
}
