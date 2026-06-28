import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getAllQuests } from '../storage.js';

const FIELD_MAX  = 1000;
const PAGE_LIMIT = 15;

function formatRow(q) {
  const deadline = q.deadline ? ` · 📅 ${q.deadline}` : '';
  const note     = q.note     ? ` · 📝 ${q.note}`     : '';
  return `\`#${q.id}\` **${q.name}**${deadline}${note}`;
}

function buildFieldValue(rows) {
  const lines = [];
  let len = 0;
  for (const row of rows) {
    const line = formatRow(row);
    if (len + line.length + 1 > FIELD_MAX) {
      lines.push(`_...และอีก ${rows.length - lines.length} รายการ_`);
      break;
    }
    lines.push(line);
    len += line.length + 1;
  }
  return lines.join('\n') || '—';
}

export const data = new SlashCommandBuilder()
  .setName('quest-list')
  .setDescription('ดูรายการเควสทั้งหมด')
  .addIntegerOption((opt) =>
    opt.setName('page').setDescription('หน้าที่ต้องการดู (default: 1)').setMinValue(1).setRequired(false)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  try {
    const quests = await getAllQuests();

    if (!quests.length) {
      return interaction.editReply('📭 ยังไม่มีเควสเลย — ใช้ `/quest-add` เพื่อเพิ่มเควสแรก');
    }

    const page    = interaction.options.getInteger('page') ?? 1;
    const pending = quests.filter((q) => !q.done);
    const done    = quests.filter((q) => q.done);
    const totalPages = Math.ceil(quests.length / PAGE_LIMIT);

    const start  = (page - 1) * PAGE_LIMIT;
    const pageQuests = quests.slice(start, start + PAGE_LIMIT);
    const pagePending = pageQuests.filter((q) => !q.done);
    const pageDone    = pageQuests.filter((q) => q.done);

    const embed = new EmbedBuilder()
      .setTitle('📋 รายการเควส')
      .setColor(0x5865f2)
      .setFooter({ text: `หน้า ${page}/${totalPages} · ทั้งหมด ${quests.length} รายการ (ค้าง ${pending.length} · เสร็จ ${done.length})` });

    if (pagePending.length) {
      embed.addFields({ name: `🔴 รอดำเนินการ (${pagePending.length})`, value: buildFieldValue(pagePending) });
    }
    if (pageDone.length) {
      embed.addFields({ name: `✅ เสร็จแล้ว (${pageDone.length})`, value: buildFieldValue(pageDone) });
    }
    if (!pagePending.length && !pageDone.length) {
      embed.setDescription('ไม่มีรายการในหน้านี้');
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply({ content: `❌ ${err.message}` });
  }
}
