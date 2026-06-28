import { Router } from 'express';
import { startRunner, stopRunner, getJob, listJobs, fetchMe, fetchQuests } from '../discord-runner.js';

const router = Router();

router.post('/start', async (req, res) => {
  const { userToken, userId, channelId, speedMultiplier, heartbeatInterval } = req.body;

  if (!userToken || typeof userToken !== 'string' || userToken.length < 30) {
    return res.status(400).json({ error: '`userToken` ไม่ถูกต้อง' });
  }
  if (!userId)    return res.status(400).json({ error: '`userId` จำเป็น' });
  if (!channelId) return res.status(400).json({ error: '`channelId` จำเป็น' });

  try {
    const me = await fetchMe(userToken);
    if (!me?.id) return res.status(401).json({ error: 'Token ไม่ถูกต้องหรือหมดอายุ' });

    const allQuests = await fetchQuests(userToken);
    const active    = allQuests.filter((q) => !q.completed);

    await startRunner({
      userId,
      userToken,
      channelId,
      botToken:          process.env.DISCORD_BOT_TOKEN,
      speedMultiplier:   Number(speedMultiplier)   || 5,
      heartbeatInterval: Number(heartbeatInterval) || 30,
    });

    return res.json({
      user:       { id: me.id, username: me.username ?? me.global_name },
      questCount: active.length,
      quests:     active.map((q) => ({ id: q.id, name: q.name, progress: q.progress })),
    });
  } catch (err) {
    const status = err.message.includes('กำลังรันอยู่') ? 409 : 500;
    return res.status(status).json({ error: err.message });
  }
});

router.post('/stop', (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: '`userId` จำเป็น' });
  const stopped = stopRunner(userId);
  res.json({ stopped });
});

router.get('/status/:userId', (req, res) => {
  const job = getJob(req.params.userId);
  if (!job) return res.json({ running: false });
  res.json({ running: true, ...job.summary() });
});

router.get('/jobs', (_req, res) => {
  res.json(listJobs());
});

export default router;
