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
        name: '🤖 Quest Runner (อัตโนมัติ)',
        value: [
          '`/run` — เปิด popup กรอก token แล้วทำ quest อัตโนมัติทุกอัน',
          '`/stop` — หยุด runner ที่กำลังทำงานอยู่',
        ].join('\n'),
      },
      {
        name: '📝 Quest Tracker (จัดการเอง)',
        value: [
          '`/quest-add name: ... deadline: ... note: ...` — เพิ่มเควส',
          '`/quest-list` — ดูรายการเควสทั้งหมด',
          '`/quest-done id: ...` — มาร์คว่าเสร็จแล้ว',
          '`/quest-remove id: ...` — ลบเควส',
          '`/quest-status` — ดูสรุปสถิติ',
        ].join('\n'),
      },
      {
        name: '🔧 ทั่วไป',
        value: [
          '`/ping` — เช็กว่าบอทออนไลน์',
          '`/help` — แสดงหน้านี้',
        ].join('\n'),
      },
    )
    .setFooter({ text: 'NeverDie Quest Helper Bot' });

  await interaction.reply({ embeds: [embed] });
}
