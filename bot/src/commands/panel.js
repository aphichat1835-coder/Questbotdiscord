import {
  SlashCommandBuilder, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { getAllQuests, getStats, addQuest, editQuest, markDone, removeQuest } from '../storage.js';
import { stopRunner, getUserJobs } from '../discord-runner.js';
import { isAdmin, isManager } from '../permissions.js';
import { showRunModal } from './run.js';

export const data = new SlashCommandBuilder()
  .setName('panel')
  .setDescription('เปิดแผงควบคุม NeverDie Quest');

const FIELD_MAX  = 1000;
const PAGE_LIMIT = 20;

function fmtQuest(q) {
  return `\`#${q.id}\` **${q.name}**${q.deadline ? ` · 📅 ${q.deadline}` : ''}${q.note ? ` · _${q.note}_` : ''}`;
}

function truncate(rows) {
  const lines = [];
  let len = 0;
  for (const q of rows) {
    const line = fmtQuest(q);
    if (len + line.length + 1 > FIELD_MAX) {
      lines.push(`_...และอีก ${rows.length - lines.length} รายการ_`);
      break;
    }
    lines.push(line);
    len += line.length + 1;
  }
  return lines.join('\n') || '—';
}

export async function execute(interaction) {
  await sendPanel(interaction, false);
}

export async function sendPanel(interaction, isUpdate = false) {
  let st = { total: 0, done: 0, pending: 0, overdue: 0 };
  try { st = await getStats(); } catch {}

  const activeJobs = getUserJobs(interaction.user.id).length;

  const embed = new EmbedBuilder()
    .setTitle('🔥 AUTO QUEST SYSTEM')
    .setColor(0xff3333)
    .setDescription(
      '```\nPREMIUM PANEL ENABLED\n```' +
      '⚡ ระบบทำเควสออโต้เวอร์ชั่นเทพ\n' +
      '🎯 รองรับหลาย TOKEN พร้อมกัน\n' +
      '🚀 กดปุ่มด้านล่างเพื่อเริ่มทันที'
    )
    .addFields(
      { name: '📦 เควสทั้งหมด',   value: `**${st.total}**`,   inline: true },
      { name: '✅ เสร็จแล้ว',     value: `**${st.done}**`,    inline: true },
      { name: '🔴 ค้างอยู่',       value: `**${st.pending}**`, inline: true },
      { name: '⚠️ เกิน Deadline', value: `**${st.overdue}**`, inline: true },
      { name: '⚡ Runner ที่รันอยู่', value: `**${activeJobs}** token`, inline: true },
    )
    .setFooter({ text: 'POWERED BY NEVERDIE AUTO QUEST™' })
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel:run').setLabel('🚀 START NOW').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('panel:stop').setLabel('🔴 STOP ALL').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('panel:status').setLabel('📊 สถิติ').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panel:refresh').setLabel('🔄 Refresh').setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel:list').setLabel('📋 รายการเควส').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('panel:add').setLabel('➕ เพิ่ม').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('panel:done').setLabel('✅ Done').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panel:edit').setLabel('✏️ แก้ไข').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panel:delete').setLabel('🗑️ ลบ').setStyle(ButtonStyle.Danger),
  );

  const payload = { embeds: [embed], components: [row1, row2] };
  if (isUpdate) await interaction.update(payload);
  else          await interaction.reply(payload);
}

export async function handleButton(interaction) {
  const action = interaction.customId.split(':')[1];

  if (action === 'refresh') return sendPanel(interaction, true);

  if (action === 'list') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const quests  = await getAllQuests();
      if (!quests.length) return interaction.editReply('📭 ยังไม่มีเควสเลย');

      const pending = quests.filter((q) => !q.done).slice(0, PAGE_LIMIT);
      const done    = quests.filter((q) => q.done).slice(0, PAGE_LIMIT);

      const embed = new EmbedBuilder().setTitle('📋 รายการเควส').setColor(0x5865f2);
      if (pending.length) embed.addFields({ name: `🔴 ค้างอยู่ (${pending.length})`, value: truncate(pending) });
      if (done.length)    embed.addFields({ name: `✅ เสร็จแล้ว (${done.length})`,    value: truncate(done) });

      const total = quests.length;
      if (total > PAGE_LIMIT * 2) {
        embed.setFooter({ text: `แสดงสูงสุด ${PAGE_LIMIT} ต่อกลุ่ม · ทั้งหมด ${total} รายการ` });
      }

      return interaction.editReply({ embeds: [embed] });
    } catch (err) { return interaction.editReply(`❌ ${err.message}`); }
  }

  if (action === 'status') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const { total, done, pending, overdue } = await getStats();
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
      const embed = new EmbedBuilder()
        .setTitle('📊 สถิติเควส').setColor(0xfee75c)
        .addFields(
          { name: '📦 ทั้งหมด',      value: `${total}`,   inline: true },
          { name: '✅ เสร็จ',         value: `${done}`,    inline: true },
          { name: '🔴 ค้าง',          value: `${pending}`, inline: true },
          { name: '⚠️ เกิน deadline', value: `${overdue}`, inline: true },
          { name: '📈 ความคืบหน้า',   value: `${bar} ${pct}%` },
        )
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    } catch (err) { return interaction.editReply(`❌ ${err.message}`); }
  }

  if (action === 'add') {
    if (!isManager(interaction)) {
      return interaction.reply({ content: '🔒 ต้องการสิทธิ์ **Manager** ขึ้นไป', ephemeral: true });
    }
    return interaction.showModal(
      new ModalBuilder().setCustomId('panel_add_modal').setTitle('➕ เพิ่ม Quest ใหม่')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('name').setLabel('ชื่อ Quest').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('deadline').setLabel('Deadline (YYYY-MM-DD)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('เช่น 2026-07-01')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('note').setLabel('โน้ต').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)
          ),
        )
    );
  }

  if (action === 'done') {
    return interaction.showModal(
      new ModalBuilder().setCustomId('panel_done_modal').setTitle('✅ Mark Quest Done')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('id').setLabel('Quest ID').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('เช่น 1')
          ),
        )
    );
  }

  if (action === 'edit') {
    if (!isManager(interaction)) {
      return interaction.reply({ content: '🔒 ต้องการสิทธิ์ **Manager** ขึ้นไป', ephemeral: true });
    }
    return interaction.showModal(
      new ModalBuilder().setCustomId('panel_edit_modal').setTitle('✏️ แก้ไข Quest')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('id').setLabel('Quest ID ที่จะแก้ไข').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('เช่น 1')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('name').setLabel('ชื่อใหม่ (เว้นว่างถ้าไม่แก้)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('deadline').setLabel('Deadline ใหม่ (YYYY-MM-DD)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('เช่น 2026-07-01')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('note').setLabel('โน้ตใหม่').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)
          ),
        )
    );
  }

  if (action === 'delete') {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '🔒 ต้องการสิทธิ์ **Administrator**', ephemeral: true });
    }
    return interaction.showModal(
      new ModalBuilder().setCustomId('panel_delete_modal').setTitle('🗑️ ลบ Quest')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('id').setLabel('Quest ID ที่จะลบ').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('เช่น 1')
          ),
        )
    );
  }

  if (action === 'run') return showRunModal(interaction);

  if (action === 'stop') {
    await interaction.deferReply({ ephemeral: true });
    const jobs    = getUserJobs(interaction.user.id);
    const stopped = stopRunner(interaction.user.id);
    return interaction.editReply(
      stopped ? `🛑 หยุดแล้ว **${jobs.length}** token` : 'ℹ️ ไม่มี Runner ที่กำลังทำงาน'
    );
  }
}

export async function handlePanelModal(interaction) {
  if (interaction.customId === 'panel_add_modal') {
    const name     = interaction.fields.getTextInputValue('name').trim();
    const deadline = interaction.fields.getTextInputValue('deadline').trim() || null;
    const note     = interaction.fields.getTextInputValue('note').trim()     || null;
    await interaction.deferReply({ ephemeral: true });
    try {
      if (!name) return interaction.editReply('❌ ชื่อต้องไม่ว่างเปล่า');
      if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return interaction.editReply('❌ deadline ต้องเป็น YYYY-MM-DD');
      const quest = await addQuest({ name, deadline, note });
      return interaction.editReply(`✅ เพิ่ม **${quest.name}** (ID #${quest.id}) แล้ว`);
    } catch (err) { return interaction.editReply(`❌ ${err.message}`); }
  }

  if (interaction.customId === 'panel_done_modal') {
    const id = parseInt(interaction.fields.getTextInputValue('id').trim(), 10);
    await interaction.deferReply({ ephemeral: true });
    if (isNaN(id)) return interaction.editReply('❌ ID ต้องเป็นตัวเลข');
    try {
      const quest = await markDone(id);
      if (!quest) return interaction.editReply(`❌ ไม่พบเควส ID #${id}`);
      return interaction.editReply(`🎉 มาร์ค **${quest.name}** ว่าเสร็จแล้ว`);
    } catch (err) { return interaction.editReply(`❌ ${err.message}`); }
  }

  if (interaction.customId === 'panel_edit_modal') {
    const id      = parseInt(interaction.fields.getTextInputValue('id').trim(), 10);
    const nameRaw = interaction.fields.getTextInputValue('name').trim();
    const deadRaw = interaction.fields.getTextInputValue('deadline').trim();
    const noteRaw = interaction.fields.getTextInputValue('note').trim();
    await interaction.deferReply({ ephemeral: true });
    if (isNaN(id)) return interaction.editReply('❌ ID ต้องเป็นตัวเลข');
    if (deadRaw && !/^\d{4}-\d{2}-\d{2}$/.test(deadRaw)) return interaction.editReply('❌ deadline ต้องเป็น YYYY-MM-DD');
    try {
      const updates = {};
      if (nameRaw) updates.name     = nameRaw;
      if (deadRaw) updates.deadline = deadRaw;
      if (noteRaw) updates.note     = noteRaw;
      const quest = await editQuest(id, updates);
      return interaction.editReply(`✏️ อัพเดท **${quest.name}** (ID #${quest.id}) แล้ว`);
    } catch (err) { return interaction.editReply(`❌ ${err.message}`); }
  }

  if (interaction.customId === 'panel_delete_modal') {
    const id = parseInt(interaction.fields.getTextInputValue('id').trim(), 10);
    await interaction.deferReply({ ephemeral: true });
    if (isNaN(id)) return interaction.editReply('❌ ID ต้องเป็นตัวเลข');
    try {
      const quest = await removeQuest(id);
      if (!quest) return interaction.editReply(`❌ ไม่พบเควส ID #${id}`);
      return interaction.editReply(`🗑️ ลบ **${quest.name}** (ID #${quest.id}) แล้ว`);
    } catch (err) { return interaction.editReply(`❌ ${err.message}`); }
  }
}
