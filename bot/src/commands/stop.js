import { SlashCommandBuilder } from 'discord.js';
import { stopRunner, getUserJobs } from '../discord-runner.js';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('หยุด Quest Runner ทั้งหมดของคุณ');

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const count = getUserJobs(interaction.user.id).length;
  const stopped = stopRunner(interaction.user.id);
  await interaction.editReply(
    stopped ? `🛑 หยุด Runner ทั้งหมด ${count} token แล้ว` : 'ℹ️ ไม่มี Runner ที่กำลังทำงาน'
  );
}
