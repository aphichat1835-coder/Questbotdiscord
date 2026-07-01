import { SlashCommandBuilder } from 'discord.js';
import { stopRunner } from '../discord-runner.js';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('หยุด Quest Runner ที่กำลังทำงานอยู่');

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const stopped = stopRunner(interaction.user.id);
  await interaction.editReply(stopped ? '🛑 หยุด Quest Runner แล้ว' : 'ℹ️ ไม่มี Quest Runner ที่กำลังทำงานอยู่');
}
