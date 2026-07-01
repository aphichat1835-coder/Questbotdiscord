import {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
} from 'discord.js';
import { startRunner, fetchMe, fetchQuests } from '../discord-runner.js';

export const data = new SlashCommandBuilder()
  .setName('run')
  .setDescription('เริ่มทำ Discord Quest อัตโนมัติด้วย user token ของคุณ');

export async function execute(interaction) {
  const modal = new ModalBuilder()
    .setCustomId(`run_modal:${interaction.channelId}`)
    .setTitle('🎮 NeverDie Quest Runner');

  const tokenInput = new TextInputBuilder()
    .setCustomId('user_token')
    .setLabel('Discord User Token')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('วาง token ของคุณที่นี่ (จะไม่ถูกบันทึกถาวร)')
    .setRequired(true)
    .setMinLength(50);

  modal.addComponents(new ActionRowBuilder().addComponents(tokenInput));
  await interaction.showModal(modal);
}

export async function handleModal(interaction) {
  const channelId = interaction.customId.split(':')[1];
  const userToken = interaction.fields.getTextInputValue('user_token').trim();

  await interaction.deferReply({ ephemeral: true });

  try {
    const me = await fetchMe(userToken).catch(() => null);
    if (!me?.id) return interaction.editReply('❌ Token ไม่ถูกต้องหรือหมดอายุ');

    const allQuests = await fetchQuests(userToken);
    const active     = allQuests.filter((q) => !q.completed);

    await startRunner({
      userId:    interaction.user.id,
      userToken,
      channelId,
      client:    interaction.client,
    });

    if (active.length === 0) {
      return interaction.editReply(`✅ ไม่มี quest ที่ต้องทำสำหรับ **${me.username}**`);
    }

    const questLines = active
      .map((q) => `• **${q.name}** — ${q.progress.toFixed(1)}%`)
      .join('\n');

    const embed = new EmbedBuilder()
      .setTitle('⚡ Quest Runner เริ่มต้นแล้ว')
      .setColor(0x57f287)
      .setDescription(`ล็อกอินเป็น **${me.username}** สำเร็จ`)
      .addFields({
        name: `📋 Quest ที่จะทำ (${active.length} รายการ)`,
        value: questLines,
      })
      .addFields({
        name: '📢 ความคืบหน้าแบบสดจะโชว์ที่',
        value: `<#${channelId}>`,
        inline: true,
      })
      .setFooter({ text: 'ใช้ /stop เพื่อหยุด' });

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply(`❌ ${err.message}`);
  }
}
