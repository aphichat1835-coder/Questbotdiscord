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

const FIELD_MAX = 1000;
const PAGE_LIMIT = 20;
const DEADLINE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MANAGER_MODAL_IDS = new Set(['panel_add_modal', 'panel_edit_modal']);

/** Format one stored Quest for an embed field. */
function fmtQuest(quest) {
  return `\`#${quest.id}\` **${quest.name}**${quest.deadline ? ` · 📅 ${quest.deadline}` : ''}${quest.note ? ` · _${quest.note}_` : ''}`;
}

/** Truncate Quest rows to Discord's embed-field limit. */
function truncate(rows) {
  const lines = [];
  let length = 0;
  for (const quest of rows) {
    const line = fmtQuest(quest);
    if (length + line.length + 1 > FIELD_MAX) {
      lines.push(`_...และอีก ${rows.length - lines.length} รายการ_`);
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join('\n') || '—';
}

/** Wrap one text input in the action row required by Discord modals. */
function inputRow(input) {
  return new ActionRowBuilder().addComponents(input);
}

/** Build the add-Quest modal. */
function buildAddQuestModal() {
  return new ModalBuilder()
    .setCustomId('panel_add_modal')
    .setTitle('➕ เพิ่ม Quest ใหม่')
    .addComponents(
      inputRow(
        new TextInputBuilder()
          .setCustomId('name')
          .setLabel('ชื่อ Quest')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100),
      ),
      inputRow(
        new TextInputBuilder()
          .setCustomId('deadline')
          .setLabel('Deadline (YYYY-MM-DD)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder('เช่น 2026-07-01'),
      ),
      inputRow(
        new TextInputBuilder()
          .setCustomId('note')
          .setLabel('โน้ต')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(500),
      ),
    );
}

/** Build the mark-done modal. */
function buildDoneQuestModal() {
  return new ModalBuilder()
    .setCustomId('panel_done_modal')
    .setTitle('✅ Mark Quest Done')
    .addComponents(
      inputRow(
        new TextInputBuilder()
          .setCustomId('id')
          .setLabel('Quest ID')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('เช่น 1'),
      ),
    );
}

/** Build the edit-Quest modal. */
function buildEditQuestModal() {
  return new ModalBuilder()
    .setCustomId('panel_edit_modal')
    .setTitle('✏️ แก้ไข Quest')
    .addComponents(
      inputRow(
        new TextInputBuilder()
          .setCustomId('id')
          .setLabel('Quest ID ที่จะแก้ไข')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('เช่น 1'),
      ),
      inputRow(
        new TextInputBuilder()
          .setCustomId('name')
          .setLabel('ชื่อใหม่ (เว้นว่างถ้าไม่แก้)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(100),
      ),
      inputRow(
        new TextInputBuilder()
          .setCustomId('deadline')
          .setLabel('Deadline ใหม่ (YYYY-MM-DD)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder('เช่น 2026-07-01'),
      ),
      inputRow(
        new TextInputBuilder()
          .setCustomId('note')
          .setLabel('โน้ตใหม่')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(500),
      ),
    );
}

/** Build the delete-Quest modal. */
function buildDeleteQuestModal() {
  return new ModalBuilder()
    .setCustomId('panel_delete_modal')
    .setTitle('🗑️ ลบ Quest')
    .addComponents(
      inputRow(
        new TextInputBuilder()
          .setCustomId('id')
          .setLabel('Quest ID ที่จะลบ')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('เช่น 1'),
      ),
    );
}

/** Build the Quest-list embed from stored rows. */
function buildQuestListEmbed(quests) {
  const pending = quests.filter((quest) => !quest.done).slice(0, PAGE_LIMIT);
  const done = quests.filter((quest) => quest.done).slice(0, PAGE_LIMIT);
  const embed = new EmbedBuilder().setTitle('📋 รายการเควส').setColor(0x5865f2);

  if (pending.length) {
    embed.addFields({ name: `🔴 ค้างอยู่ (${pending.length})`, value: truncate(pending) });
  }
  if (done.length) {
    embed.addFields({ name: `✅ เสร็จแล้ว (${done.length})`, value: truncate(done) });
  }
  if (quests.length > PAGE_LIMIT * 2) {
    embed.setFooter({ text: `แสดงสูงสุด ${PAGE_LIMIT} ต่อกลุ่ม · ทั้งหมด ${quests.length} รายการ` });
  }

  return embed;
}

/** Build the Quest-statistics embed. */
function buildQuestStatsEmbed({ total, done, pending, overdue }) {
  const percentage = total > 0 ? Math.round((done / total) * 100) : 0;
  const completedBlocks = Math.round(percentage / 10);
  const progressBar = '█'.repeat(completedBlocks) + '░'.repeat(10 - completedBlocks);

  return new EmbedBuilder()
    .setTitle('📊 สถิติเควส')
    .setColor(0xfee75c)
    .addFields(
      { name: '📦 ทั้งหมด', value: `${total}`, inline: true },
      { name: '✅ เสร็จ', value: `${done}`, inline: true },
      { name: '🔴 ค้าง', value: `${pending}`, inline: true },
      { name: '⚠️ เกิน deadline', value: `${overdue}`, inline: true },
      { name: '📈 ความคืบหน้า', value: `${progressBar} ${percentage}%` },
    )
    .setTimestamp();
}

/** Read and trim one modal field value. */
function readModalField(interaction, customId) {
  return interaction.fields.getTextInputValue(customId).trim();
}

/** Parse a Quest ID from the shared modal field. */
function readQuestId(interaction) {
  return Number.parseInt(readModalField(interaction, 'id'), 10);
}

/** Return whether a non-empty deadline uses the expected date shape. */
function isValidDeadline(deadline) {
  return !deadline || DEADLINE_PATTERN.test(deadline);
}

/** Convert a storage failure into the panel's private error reply. */
async function runPanelOperation(interaction, operation) {
  try {
    return await operation();
  } catch (error) {
    return interaction.editReply(`❌ ${error.message}`);
  }
}

/** Reply with the standard Manager permission denial. */
function replyManagerRequired(interaction, changed = false) {
  const content = changed
    ? '🔒 สิทธิ์ของคุณเปลี่ยนไป — ต้องการสิทธิ์ **Manager** ขึ้นไป'
    : '🔒 ต้องการสิทธิ์ **Manager** ขึ้นไป';
  return interaction.reply({ flags: 64, content });
}

/** Reply with the standard Administrator permission denial. */
function replyAdminRequired(interaction, changed = false) {
  const content = changed
    ? '🔒 สิทธิ์ของคุณเปลี่ยนไป — ต้องการสิทธิ์ **Administrator**'
    : '🔒 ต้องการสิทธิ์ **Administrator**';
  return interaction.reply({ flags: 64, content });
}

/** Open the public control panel. */
export async function execute(interaction) {
  await sendPanel(interaction, false);
}

/** Send or update the main Runner control panel. */
export async function sendPanel(interaction, isUpdate = false) {
  const oneShotJobs = getUserJobs(interaction.user.id, { mode: 'oneshot' }).length;
  const scheduledJobs = getUserJobs(interaction.user.id, { mode: 'scheduled' }).length;

  const embed = new EmbedBuilder()
    .setTitle('🔥 AUTO QUEST SYSTEM')
    .setColor(0xff3333)
    .setDescription('```\nPREMIUM PANEL ENABLED\n```')
    .setFooter({
      text: `POWERED BY NEVERDIE AUTO QUEST™ · One-shot: ${oneShotJobs} · Auto Daily: ${scheduledJobs}`,
    })
    .setTimestamp();

  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel:run').setLabel('🚀 START NOW').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('panel:stop').setLabel('🔴 STOP ALL').setStyle(ButtonStyle.Danger),
  );

  const payload = { embeds: [embed], components: [controls] };
  if (isUpdate) return interaction.update(payload);
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply(payload);
}

/** Reply with the stored Quest list. */
async function handleListButton(interaction) {
  await interaction.deferReply({ flags: 64 });
  return runPanelOperation(interaction, async () => {
    const quests = await getAllQuests();
    if (!quests.length) return interaction.editReply('📭 ยังไม่มีเควสเลย');
    return interaction.editReply({ embeds: [buildQuestListEmbed(quests)] });
  });
}

/** Reply with Quest completion statistics. */
async function handleStatusButton(interaction) {
  await interaction.deferReply({ flags: 64 });
  return runPanelOperation(interaction, async () => {
    const stats = await getStats();
    return interaction.editReply({ embeds: [buildQuestStatsEmbed(stats)] });
  });
}

/** Show the add-Quest modal after rechecking Manager permission. */
function handleAddButton(interaction) {
  if (!isManager(interaction)) return replyManagerRequired(interaction);
  return interaction.showModal(buildAddQuestModal());
}

/** Show the mark-done modal. */
function handleDoneButton(interaction) {
  return interaction.showModal(buildDoneQuestModal());
}

/** Show the edit-Quest modal after rechecking Manager permission. */
function handleEditButton(interaction) {
  if (!isManager(interaction)) return replyManagerRequired(interaction);
  return interaction.showModal(buildEditQuestModal());
}

/** Show the delete-Quest modal after rechecking Administrator permission. */
function handleDeleteButton(interaction) {
  if (!isAdmin(interaction)) return replyAdminRequired(interaction);
  return interaction.showModal(buildDeleteQuestModal());
}

/** Show the one-shot Runner modal after rechecking Manager permission. */
function handleRunButton(interaction) {
  if (!isManager(interaction)) return replyManagerRequired(interaction);
  return showRunModal(interaction, 'oneshot');
}

/** Stop all one-shot jobs owned by the invoking user. */
async function handleStopButton(interaction) {
  await interaction.deferReply({ flags: 64 });
  const jobs = getUserJobs(interaction.user.id, { mode: 'oneshot' });
  const stopped = stopRunner(interaction.user.id, { mode: 'oneshot' });
  const content = stopped
    ? `🛑 หยุด One-shot Runner แล้ว **${jobs.length}** token`
    : 'ℹ️ ไม่มี One-shot Runner ที่กำลังทำงาน';
  return interaction.editReply(content);
}

const BUTTON_HANDLERS = Object.freeze({
  refresh: (interaction) => sendPanel(interaction, true),
  list: handleListButton,
  status: handleStatusButton,
  add: handleAddButton,
  done: handleDoneButton,
  edit: handleEditButton,
  delete: handleDeleteButton,
  run: handleRunButton,
  stop: handleStopButton,
});

/** Dispatch one panel button by the action encoded in its custom ID. */
export async function handleButton(interaction) {
  const action = interaction.customId.split(':')[1];
  const handler = BUTTON_HANDLERS[action];
  return handler?.(interaction);
}

/** Return the private permission reply required for one panel modal, if any. */
function getModalPermissionReply(interaction) {
  if (MANAGER_MODAL_IDS.has(interaction.customId) && !isManager(interaction)) {
    return { flags: 64, content: '🔒 สิทธิ์ของคุณเปลี่ยนไป — ต้องการสิทธิ์ **Manager** ขึ้นไป' };
  }
  if (interaction.customId === 'panel_delete_modal' && !isAdmin(interaction)) {
    return { flags: 64, content: '🔒 สิทธิ์ของคุณเปลี่ยนไป — ต้องการสิทธิ์ **Administrator**' };
  }
  return null;
}

/** Add a Quest from submitted modal fields. */
async function handleAddModal(interaction) {
  const name = readModalField(interaction, 'name');
  const deadline = readModalField(interaction, 'deadline') || null;
  const note = readModalField(interaction, 'note') || null;
  await interaction.deferReply({ flags: 64 });

  if (!name) return interaction.editReply('❌ ชื่อต้องไม่ว่างเปล่า');
  if (!isValidDeadline(deadline)) return interaction.editReply('❌ deadline ต้องเป็น YYYY-MM-DD');

  return runPanelOperation(interaction, async () => {
    const quest = await addQuest({ name, deadline, note });
    return interaction.editReply(`✅ เพิ่ม **${quest.name}** (ID #${quest.id}) แล้ว`);
  });
}

/** Mark one Quest done from a submitted modal ID. */
async function handleDoneModal(interaction) {
  const id = readQuestId(interaction);
  await interaction.deferReply({ flags: 64 });
  if (Number.isNaN(id)) return interaction.editReply('❌ ID ต้องเป็นตัวเลข');

  return runPanelOperation(interaction, async () => {
    const quest = await markDone(id);
    if (!quest) return interaction.editReply(`❌ ไม่พบเควส ID #${id}`);
    return interaction.editReply(`🎉 มาร์ค **${quest.name}** ว่าเสร็จแล้ว`);
  });
}

/** Edit one Quest from submitted modal fields. */
async function handleEditModal(interaction) {
  const id = readQuestId(interaction);
  const name = readModalField(interaction, 'name');
  const deadline = readModalField(interaction, 'deadline');
  const note = readModalField(interaction, 'note');
  await interaction.deferReply({ flags: 64 });

  if (Number.isNaN(id)) return interaction.editReply('❌ ID ต้องเป็นตัวเลข');
  if (!isValidDeadline(deadline)) return interaction.editReply('❌ deadline ต้องเป็น YYYY-MM-DD');

  const updates = {};
  if (name) updates.name = name;
  if (deadline) updates.deadline = deadline;
  if (note) updates.note = note;

  return runPanelOperation(interaction, async () => {
    const quest = await editQuest(id, updates);
    return interaction.editReply(`✏️ อัพเดท **${quest.name}** (ID #${quest.id}) แล้ว`);
  });
}

/** Delete one Quest from a submitted modal ID. */
async function handleDeleteModal(interaction) {
  const id = readQuestId(interaction);
  await interaction.deferReply({ flags: 64 });
  if (Number.isNaN(id)) return interaction.editReply('❌ ID ต้องเป็นตัวเลข');

  return runPanelOperation(interaction, async () => {
    const quest = await removeQuest(id);
    if (!quest) return interaction.editReply(`❌ ไม่พบเควส ID #${id}`);
    return interaction.editReply(`🗑️ ลบ **${quest.name}** (ID #${quest.id}) แล้ว`);
  });
}

const MODAL_HANDLERS = Object.freeze({
  panel_add_modal: handleAddModal,
  panel_done_modal: handleDoneModal,
  panel_edit_modal: handleEditModal,
  panel_delete_modal: handleDeleteModal,
});

/** Recheck permission and dispatch one panel modal submission. */
export async function handlePanelModal(interaction) {
  const permissionReply = getModalPermissionReply(interaction);
  if (permissionReply) return interaction.reply(permissionReply);
  const handler = MODAL_HANDLERS[interaction.customId];
  return handler?.(interaction);
}
