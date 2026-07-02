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
        value: '`/panel` — เปิดแผงควบคุมพร้อมปุ่ม: เพิ่ม, แก้ไข, ลบ, Done, สถิติ, **▶️ Start / 🛑 Stop Runner**',
      },
      {
        name: '🤖 Quest Runner (อัตโนมัติ)',
        value: [
          '`/run` — กรอก token แล้วระบบเข้าไปทำ Discord Quest อัตโนมัติทุกอัน',
          '`/stop` — หยุด Runner ที่กำลังทำงาน',
        ].join('\n'),
      },
      {
        name: '📝 Quest Tracker',
        value: [
          '`/quest-add` — เพิ่มเควสใหม่',
          '`/quest-list` — ดูรายการเควสทั้งหมด',
          '`/quest-done` — มาร์คเควสว่าเสร็จแล้ว',
          '`/quest-remove` — ลบเควสออกจากรายการ',
          '`/quest-status` — ดูสรุปสถิติเควส',
        ].join('\n'),
      },
      {
        name: '🔧 ระบบ',
        value: [
          '`/api-status` — เช็กสถานะระบบและฐานข้อมูล',
          '`/ping` — เช็กว่าบอทออนไลน์และวัด latency',
          '`/help` — แสดงหน้านี้',
        ].join('\n'),
      },
    )
    .setFooter({ text: 'NeverDie Quest Helper Bot' });

  await interaction.reply({ embeds: [embed] });
}
