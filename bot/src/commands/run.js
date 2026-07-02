import {
  SlashCommandBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, ActionRowBuilder,
} from 'discord.js';
import { startRunner, fetchMe, getUserJobs } from '../discord-runner.js';
import { isManager } from '../permissions.js';

export const data = new SlashCommandBuilder()
  .setName('run')
  .setDescription('เริ่ม Auto Quest อัตโนมัติ (รองรับหลาย TOKEN พร้อมกัน)');

export async function execute(interaction) {
  if (!isManager(interaction)) {
    return interaction.reply({ flags: 64, content: '🔒 ต้องการสิทธิ์ **Manager** ขึ้นไปจึงจะใช้คำสั่งนี้ได้' });
  }
  return showRunModal(interaction);
}

export async function showRunModal(interaction) {
  const modal = new ModalBuilder()
    .setCustomId(`run_modal:${interaction.channelId}`)
    .setTitle('🔥 AUTO QUEST LOGIN');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('user_tokens')
        .setLabel('DISCORD TOKENS')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('1 TOKEN ต่อ 1 บรรทัด')
        .setRequired(true)
        .setMaxLength(4000),
    ),
  );

  await interaction.showModal(modal);
}

export async function handleModal(interaction) {
  const channelId = interaction.customId.split(':')[1];
  const raw       = interaction.fields.getTextInputValue('user_tokens');
  const tokens    = raw.split('\n').map((t) => t.trim()).filter(Boolean);

  if (!tokens.length) {
    return interaction.reply({ flags: 64, content: '❌ ไม่พบ token กรุณาใส่อย่างน้อย 1 token' });
  }

  await interaction.deferReply({ flags: 64 });

  const ownerId    = interaction.user.id;
  const existing   = getUserJobs(ownerId);
  const usedSlots  = existing.length;
  const freeSlots  = Math.max(0, 10 - usedSlots);
  const toRun      = tokens.slice(0, freeSlots);

  if (!toRun.length) {
    return interaction.editReply('⚠️ มี Runner ทำงานอยู่เต็มแล้ว (สูงสุด 10 token) ใช้ 🛑 STOP ALL ก่อน');
  }

  const results = [];
  let startIndex = usedSlots;

  for (const token of toRun) {
    const me = await fetchMe(token).catch(() => null);
    if (!me?.id) { results.push(`❌ Token ไม่ถูกต้อง: \`${token.slice(0, 20)}...\``); continue; }

    const jobKey = `${ownerId}_${startIndex++}`;
    await startRunner({ jobKey, ownerId, userToken: token, channelId, client: interaction.client });
    results.push(`✅ เริ่มแล้ว: **${me.username}**`);
  }

  const skipped = tokens.length - toRun.length;
  if (skipped > 0) results.push(`⚠️ ข้าม ${skipped} token (เกินลิมิต)`);

  await interaction.editReply(results.join('\n'));
}
