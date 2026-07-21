import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { config } from '../config.js';
import {
  stopAllForUserAndWait,
  stopScheduledJobAndWait,
} from '../runner-control.js';
import { listScheduledRunners } from '../scheduled-runner-store.js';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('เลือกหยุด Auto Daily Runner ของคุณ');

function shortStatus(row) {
  if (row.last_error) return `มีข้อผิดพลาด: ${row.last_error}`.slice(0, 100);
  if (row.next_check_at) {
    const next = new Date(row.next_check_at);
    if (Number.isFinite(next.getTime())) {
      return `ตรวจครั้งถัดไป ${next.toLocaleString('th-TH', { timeZone: config.timezone })}`.slice(0, 100);
    }
  }
  return 'ระบบอัตโนมัติรายวันกำลังทำงาน';
}

function stopPanelPayload(ownerId, notice = null) {
  const rows = listScheduledRunners(ownerId);
  const embed = new EmbedBuilder()
    .setTitle('🛑 AUTO DAILY RUNNER CONTROL')
    .setColor(rows.length ? 0xed4245 : 0x57f287)
    .setDescription(
      notice
        ? `${notice}\n\n${rows.length ? 'เลือก Token ที่ต้องการหยุดได้หลายรายการ' : 'ไม่มี Auto Daily Runner ที่กำลังทำงาน'}`
        : rows.length
          ? 'เลือก Token ที่ต้องการหยุดได้หลายรายการจากเมนูด้านล่าง'
          : 'ไม่มี Auto Daily Runner ที่กำลังทำงาน',
    )
    .setFooter({ text: `Active: ${rows.length} token` })
    .setTimestamp();

  const components = [];
  if (rows.length) {
    const select = new StringSelectMenuBuilder()
      .setCustomId('runner-stop:select')
      .setPlaceholder('เลือก Token ที่ต้องการหยุด')
      .setMinValues(1)
      .setMaxValues(Math.min(rows.length, 10))
      .addOptions(rows.slice(0, 10).map((row) => ({
        label: row.username.slice(0, 100),
        description: shortStatus(row),
        value: String(row.id),
        emoji: '🤖',
      })));
    components.push(new ActionRowBuilder().addComponents(select));
  }

  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('runner-stop:refresh')
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('runner-stop:all')
      .setLabel('STOP ALL')
      .setEmoji('🛑')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(rows.length === 0),
  ));

  return { embeds: [embed], components };
}

async function acknowledgeForCleanup(interaction) {
  if (typeof interaction.deferUpdate === 'function') {
    await interaction.deferUpdate();
    return true;
  }
  return false;
}

async function finishUpdate(interaction, payload, deferred) {
  if (deferred && typeof interaction.editReply === 'function') {
    return interaction.editReply(payload);
  }
  if (typeof interaction.update === 'function') return interaction.update(payload);
  if (typeof interaction.editReply === 'function') return interaction.editReply(payload);
  throw new Error('Interaction does not support update or editReply');
}

export async function execute(interaction) {
  await interaction.reply({
    ...stopPanelPayload(interaction.user.id),
    flags: 64,
  });
}

export async function handleSelect(interaction) {
  const deferred = await acknowledgeForCleanup(interaction);
  const stopped = [];
  for (const rawId of interaction.values) {
    const id = Number(rawId);
    if (!Number.isInteger(id)) continue;
    const row = listScheduledRunners(interaction.user.id).find((item) => item.id === id);
    if (row && await stopScheduledJobAndWait(interaction.user.id, id)) stopped.push(row.username);
  }

  const notice = stopped.length
    ? `✅ หยุดและ Cleanup แล้ว: **${stopped.join(', ')}**`
    : 'ℹ️ ไม่พบ Runner ที่เลือก';
  return finishUpdate(interaction, stopPanelPayload(interaction.user.id, notice), deferred);
}

export async function handleButton(interaction) {
  const action = interaction.customId.split(':')[1];
  if (action === 'refresh') {
    return interaction.update(stopPanelPayload(interaction.user.id, '🔄 อัปเดตสถานะแล้ว'));
  }

  if (action === 'all') {
    const deferred = await acknowledgeForCleanup(interaction);
    const rows = listScheduledRunners(interaction.user.id);
    const stopped = await stopAllForUserAndWait(interaction.user.id, { mode: 'scheduled' });
    return finishUpdate(
      interaction,
      stopPanelPayload(
        interaction.user.id,
        `✅ หยุดและ Cleanup Auto Daily Runner แล้ว **${stopped || rows.length}** token`,
      ),
      deferred,
    );
  }

  return undefined;
}
