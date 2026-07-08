import {
  SlashCommandBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, ActionRowBuilder,
} from 'discord.js';
import { config } from '../config.js';
import {
  startRunner,
  fetchMe,
  findUserJobByAccount,
  getUserJobs,
} from '../discord-runner.js';
import { isManager } from '../permissions.js';
import {
  createScheduledRunner,
  deleteScheduledRunner,
  findScheduledRunner,
  listScheduledRunners,
} from '../scheduled-runner-store.js';

export const data = new SlashCommandBuilder()
  .setName('run')
  .setDescription('เริ่ม Auto Quest อัตโนมัติ (รองรับหลาย TOKEN พร้อมกัน)');

export async function execute(interaction) {
  if (!isManager(interaction)) {
    return interaction.reply({ flags: 64, content: '🔒 ต้องการสิทธิ์ **Manager** ขึ้นไปจึงจะใช้คำสั่งนี้ได้' });
  }
  if (!config.runnerTokenSecret || config.runnerTokenSecret.length < 16) {
    return interaction.reply({
      flags: 64,
      content: '❌ Scheduled Runner ยังไม่พร้อม — กรุณาตั้ง `RUNNER_TOKEN_SECRET` อย่างน้อย 16 ตัวอักษรใน Environment',
    });
  }
  return showRunModal(interaction, 'scheduled');
}

export async function showRunModal(interaction, mode = 'scheduled') {
  const modal = new ModalBuilder()
    .setCustomId(`run_modal:${mode}:${interaction.channelId}`)
    .setTitle(mode === 'scheduled' ? '🤖 AUTO DAILY QUEST' : '🔥 AUTO QUEST LOGIN');

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

  try {
    await interaction.showModal(modal);
  } catch (error) {
    if (error?.code === 10062 || error?.code === 40060) return;
    throw error;
  }
}

export async function handleModal(interaction) {
  const modalParts = interaction.customId.split(':');
  const mode = modalParts.length >= 3 ? modalParts[1] : 'oneshot';
  const channelId = modalParts.length >= 3 ? modalParts[2] : modalParts[1];
  const isScheduled = mode === 'scheduled';
  if (!isManager(interaction)) {
    return interaction.reply({
      flags: 64,
      content: '🔒 สิทธิ์ของคุณเปลี่ยนไป — ต้องการสิทธิ์ **Manager** ขึ้นไป',
    });
  }
  const raw       = interaction.fields.getTextInputValue('user_tokens');
  const tokens    = raw.split('\n').map((t) => t.trim()).filter(Boolean);

  if (!tokens.length) {
    return interaction.reply({ flags: 64, content: '❌ ไม่พบ token กรุณาใส่อย่างน้อย 1 token' });
  }

  await interaction.deferReply({ flags: 64 });

  const ownerId    = interaction.user.id;
  const existing   = getUserJobs(ownerId);
  const persisted  = listScheduledRunners(ownerId);
  const runningScheduledIds = new Set(
    existing.filter((job) => job.scheduleId != null).map((job) => job.scheduleId),
  );
  const offlineScheduled = persisted.filter((row) => !runningScheduledIds.has(row.id)).length;
  const usedSlots  = existing.length + offlineScheduled;
  const freeSlots  = Math.max(0, 10 - usedSlots);
  const toRun      = tokens.slice(0, freeSlots);

  if (!toRun.length) {
    return interaction.editReply('⚠️ มี Runner ทำงานอยู่เต็มแล้ว (สูงสุด 10 token) ใช้ 🛑 STOP ALL ก่อน');
  }

  const results = [];
  let startIndex = Date.now();

  for (const [tokenIndex, token] of toRun.entries()) {
    const me = await fetchMe(token).catch(() => null);
    if (!me?.id) {
      results.push(`❌ Token ลำดับที่ ${tokenIndex + 1} ไม่ถูกต้อง`);
      continue;
    }

    if (findUserJobByAccount(ownerId, me.id) || findScheduledRunner(ownerId, me.id)) {
      results.push(`⚠️ **${me.username}** มี Runner ทำงานอยู่แล้ว`);
      continue;
    }

    let schedule = null;
    try {
      if (isScheduled) {
        schedule = createScheduledRunner({
          ownerId,
          guildId: interaction.guildId,
          channelId,
          accountId: me.id,
          username: me.username,
          token,
          secret: config.runnerTokenSecret,
        });
      }

      const jobKey = isScheduled
        ? `scheduled:${schedule.id}`
        : `${ownerId}:oneshot:${startIndex++}`;
      await startRunner({
        jobKey,
        ownerId,
        userToken: token,
        channelId,
        client: interaction.client,
        mode: isScheduled ? 'scheduled' : 'oneshot',
        scheduleId: schedule?.id ?? null,
        accountId: me.id,
        username: me.username,
      });

      results.push(isScheduled
        ? `🤖 เริ่มระบบอัตโนมัติรายวัน: **${me.username}**\n   ตรวจทันที และตรวจประจำเวลา **00:00 / 08:00 / 16:00 น.**`
        : `✅ เริ่ม Quest auto : **${me.username}**`);
    } catch (err) {
      if (schedule) deleteScheduledRunner(schedule.id, ownerId);
      results.push(`❌ เริ่ม **${me.username}** ไม่สำเร็จ — ${err.message}`);
    }
  }

  const skipped = tokens.length - toRun.length;
  if (skipped > 0) results.push(`⚠️ ข้าม ${skipped} token (เกินลิมิต)`);

  if (isScheduled && results.some((line) => line.startsWith('🤖'))) {
    results.unshift('**🚀 NEVERDIE AUTO DAILY QUEST เปิดใช้งานแล้ว**');
    results.push('ใช้คำสั่ง `/stop` เพื่อเลือกหยุด Runner ที่ต้องการ');
  }

  await interaction.editReply(results.join('\n'));
}
