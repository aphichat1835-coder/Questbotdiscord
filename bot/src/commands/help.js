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
          '`/run` — กรอก token แล้วทำ quest อัตโนมัติทุกอัน',
          '`/stop` — หยุด Runner ที่กำลังทำงาน',
        ].join('\n'),
      },
      {
        name: '🎛️ แผงควบคุม',
        value: '`/panel` — เปิดแผงควบคุมพร้อมปุ่ม: เพิ่ม, แก้ไข, ลบ, Done, สถิติ, Runner',
      },
      {
        name: '📝 Quest Tracker',
        value: [
          '`/quest-add name: ... deadline: ... note: ...` — เพิ่มเควส',
          '`/quest-list` — ดูรายการทั้งหมด',
          '`/quest-done id: ...` — มาร์คว่าเสร็จ',
          '`/quest-remove id: ...` — ลบเควส',
          '`/quest-status` — สรุปสถิติ',
        ].join('\n'),
      },
      {
        name: '🔧 ระบบ',
        value: [
          '`/api-status` — เช็กสถานะระบบ/ฐานข้อมูล',
          '`/ping` — เช็กว่าบอทออนไลน์',
          '`/help` — แสดงหน้านี้',
        ].join('\n'),
      },
    )
    .setFooter({ text: 'NeverDie Quest Helper Bot' });

  await interaction.reply({ embeds: [embed] });
}
